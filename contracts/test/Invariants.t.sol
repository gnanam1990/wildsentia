// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {WildsentiaChallenges} from "../src/WildsentiaChallenges.sol";
import {TestUSDC} from "./mocks/TestUSDC.sol";

/// Drives random creates, payouts, refunds, pauses, evaluator changes and time.
contract ChallengesHandler is Test {
    WildsentiaChallenges public immutable challenges;
    TestUSDC public immutable usdc;
    address public immutable owner;
    address[3] public creators;
    address[3] public players;
    address public evaluator;

    uint256 public ghostDeposited;
    uint256 public ghostPaidOut;
    mapping(uint256 id => uint256 payouts) public payoutsOf;

    constructor(WildsentiaChallenges c, TestUSDC u, address owner_, address evaluator_) {
        challenges = c;
        usdc = u;
        owner = owner_;
        evaluator = evaluator_;
        for (uint256 i; i < 3; i++) {
            creators[i] = makeAddr(string.concat("creator", vm.toString(i)));
            players[i] = makeAddr(string.concat("player", vm.toString(i)));
            u.mint(creators[i], 1e15);
            vm.prank(creators[i]);
            u.approve(address(c), type(uint256).max);
        }
    }

    function create(uint256 who, uint96 prize, uint64 duration) external {
        prize = uint96(bound(prize, challenges.minPrize(), challenges.maxPrize()));
        duration = uint64(bound(duration, challenges.MIN_DURATION(), challenges.MAX_DURATION()));
        vm.prank(creators[who % 3]);
        challenges.create(keccak256(abi.encode(who, prize)), prize, uint64(block.timestamp) + duration);
        ghostDeposited += prize;
    }

    function resolve(uint256 idSeed, uint256 who, bool asCreator) external {
        uint256 count = challenges.challengeCount();
        if (count == 0) return;
        uint256 id = bound(idSeed, 1, count);
        WildsentiaChallenges.Challenge memory c = challenges.challenge(id);
        address winner = asCreator ? c.creator : players[who % 3];
        vm.prank(evaluator);
        try challenges.resolve(id, winner, keccak256(abi.encode(id))) {
            ghostPaidOut += c.prize;
            payoutsOf[id]++;
        } catch {}
    }

    function refund(uint256 idSeed) external {
        uint256 count = challenges.challengeCount();
        if (count == 0) return;
        uint256 id = bound(idSeed, 1, count);
        WildsentiaChallenges.Challenge memory c = challenges.challenge(id);
        try challenges.refund(id) {
            ghostPaidOut += c.prize;
            payoutsOf[id]++;
        } catch {}
    }

    function warp(uint32 secondsAhead) external {
        vm.warp(block.timestamp + bound(secondsAhead, 1, 20 days));
    }

    function togglePause(bool paused) external {
        vm.prank(owner);
        challenges.setResolvePaused(paused);
    }

    function rotateEvaluator(uint256 seed) external {
        address next = makeAddr(string.concat("evaluator", vm.toString(seed % 4)));
        vm.prank(owner);
        challenges.setEvaluator(next);
        evaluator = next;
    }
}

contract InvariantsTest is Test {
    WildsentiaChallenges internal challenges;
    TestUSDC internal usdc;
    ChallengesHandler internal handler;

    function setUp() public {
        vm.warp(1_790_000_000);
        usdc = new TestUSDC();
        address owner = makeAddr("owner");
        address evaluator = makeAddr("evaluator");
        challenges = new WildsentiaChallenges(IERC20(address(usdc)), owner, evaluator, 1e6, 100e6);
        handler = new ChallengesHandler(challenges, usdc, owner, evaluator);
        targetContract(address(handler));
    }

    /// The contract holds exactly the prizes of open challenges: nothing is lost or created.
    function invariant_balanceEqualsOpenPrizes() public view {
        assertEq(usdc.balanceOf(address(challenges)), challenges.totalOpen());
        assertEq(handler.ghostDeposited() - handler.ghostPaidOut(), challenges.totalOpen());
    }

    /// totalOpen is the sum of the prizes of challenges still Open.
    function invariant_totalOpenMatchesOpenChallenges() public view {
        uint256 sum;
        uint256 count = challenges.challengeCount();
        for (uint256 id = 1; id <= count; id++) {
            WildsentiaChallenges.Challenge memory c = challenges.challenge(id);
            if (c.status == WildsentiaChallenges.Status.Open) sum += c.prize;
        }
        assertEq(sum, challenges.totalOpen());
    }

    /// Each challenge pays out at most once, and never to its creator as a winner.
    function invariant_payOnceNeverToCreator() public view {
        uint256 count = challenges.challengeCount();
        for (uint256 id = 1; id <= count; id++) {
            WildsentiaChallenges.Challenge memory c = challenges.challenge(id);
            assertLe(handler.payoutsOf(id), 1);
            if (c.status == WildsentiaChallenges.Status.Resolved) {
                assertTrue(c.winner != c.creator);
                assertTrue(c.winner != address(0));
            }
        }
    }
}
