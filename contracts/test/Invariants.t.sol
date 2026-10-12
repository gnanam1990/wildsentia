// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {WildsentiaChallenges} from "../src/WildsentiaChallenges.sol";
import {TestUSDC} from "./mocks/TestUSDC.sol";

/// Drives random creates (both ways), payouts, refunds, pauses, evaluator changes and time.
/// Durations stay short (12 hours to 2.5 days) so that, within one run, prizes both get paid
/// and expire; the deadline rails themselves are covered by the unit tests.
/// Every action catches the reverts it expects, so the suite runs with fail_on_revert.
contract ChallengesHandler is Test {
    WildsentiaChallenges public immutable challenges;
    TestUSDC public immutable usdc;
    address public immutable owner;
    address[3] public creators;
    uint256[3] internal creatorKeys;
    address[3] public players;

    uint256 public ghostDeposited;
    uint256 public ghostPaidOut;
    mapping(uint256 id => uint256 payouts) public payoutsOf;
    uint256 public resolved;
    uint256 public refunded;
    uint256 public createdByAuthorization;
    /// Payouts made by an evaluator other than the one recorded on the challenge. Must stay zero.
    uint256 public foreignEvaluatorPayouts;
    uint256 internal saltCounter;

    constructor(WildsentiaChallenges c, TestUSDC u, address owner_) {
        challenges = c;
        usdc = u;
        owner = owner_;
        for (uint256 i; i < 3; i++) {
            (creators[i], creatorKeys[i]) = makeAddrAndKey(string.concat("creator", vm.toString(i)));
            players[i] = makeAddr(string.concat("player", vm.toString(i)));
            u.mint(creators[i], 1e15);
            vm.prank(creators[i]);
            u.approve(address(c), type(uint256).max);
        }
    }

    function create(uint256 who, uint96 prize, uint64 duration) external {
        prize = uint96(bound(prize, challenges.minPrize(), challenges.maxPrize()));
        duration = uint64(bound(duration, challenges.MIN_DURATION(), challenges.MIN_DURATION() + 2 days));
        vm.prank(creators[who % 3]);
        challenges.create(keccak256(abi.encode(who, prize)), prize, uint64(block.timestamp) + duration);
        ghostDeposited += prize;
    }

    function createWithAuthorization(uint256 who, uint96 prize, uint64 duration) external {
        prize = uint96(bound(prize, challenges.minPrize(), challenges.maxPrize()));
        duration = uint64(bound(duration, challenges.MIN_DURATION(), challenges.MIN_DURATION() + 2 days));
        address creator = creators[who % 3];
        bytes32 rules = keccak256(abi.encode("auth", who, prize));
        uint64 deadline = uint64(block.timestamp) + duration;
        bytes32 salt = bytes32(++saltCounter);
        bytes memory signature =
            _sign(who % 3, prize, challenges.authorizationNonce(creator, rules, prize, deadline, salt));
        challenges.createWithAuthorization(
            creator, rules, prize, deadline, salt, 0, block.timestamp + 1 hours, signature
        );
        ghostDeposited += prize;
        createdByAuthorization++;
    }

    /// The creator's EIP-712 ReceiveWithAuthorization, valid for one hour from now.
    function _sign(uint256 i, uint96 prize, bytes32 nonce) internal view returns (bytes memory) {
        bytes32 structHash = keccak256(
            abi.encode(
                usdc.RECEIVE_WITH_AUTHORIZATION_TYPEHASH(),
                creators[i],
                address(challenges),
                prize,
                0,
                block.timestamp + 1 hours,
                nonce
            )
        );
        (uint8 v, bytes32 r, bytes32 s) =
            vm.sign(creatorKeys[i], keccak256(abi.encodePacked("\x19\x01", usdc.DOMAIN_SEPARATOR(), structHash)));
        return abi.encodePacked(r, s, v);
    }

    /// The recorded evaluator pays a player (or, sometimes, wrongly tries the creator).
    function resolve(uint256 idSeed, uint256 who, bool asCreator) external {
        uint256 count = challenges.challengeCount();
        if (count == 0) return;
        uint256 id = bound(idSeed, 1, count);
        WildsentiaChallenges.Challenge memory c = challenges.challenge(id);
        address winner = asCreator ? c.creator : players[who % 3];
        vm.prank(c.evaluator);
        try challenges.resolve(id, winner, keccak256(abi.encode(id))) {
            ghostPaidOut += c.prize;
            payoutsOf[id]++;
            resolved++;
        } catch {}
    }

    /// The owner's current evaluator tries to take a prize locked under an earlier one.
    function resolveAsCurrentEvaluator(uint256 idSeed, uint256 who) external {
        uint256 count = challenges.challengeCount();
        if (count == 0) return;
        uint256 id = bound(idSeed, 1, count);
        WildsentiaChallenges.Challenge memory c = challenges.challenge(id);
        address current = challenges.evaluator();
        vm.prank(current);
        try challenges.resolve(id, players[who % 3], bytes32(0)) {
            ghostPaidOut += c.prize;
            payoutsOf[id]++;
            resolved++;
            if (current != c.evaluator) foreignEvaluatorPayouts++;
        } catch {}
    }

    /// Refunds a challenge, sometimes first moving time past its deadline and grace (time only
    /// ever moves forward, so later challenges see the same clock).
    function refund(uint256 idSeed, bool waitForDeadline) external {
        uint256 count = challenges.challengeCount();
        if (count == 0) return;
        uint256 id = bound(idSeed, 1, count);
        WildsentiaChallenges.Challenge memory c = challenges.challenge(id);
        uint256 opensAt = uint256(c.deadline) + challenges.GRACE() + 1;
        if (waitForDeadline && block.timestamp < opensAt) vm.warp(opensAt);
        try challenges.refund(id) {
            ghostPaidOut += c.prize;
            payoutsOf[id]++;
            refunded++;
        } catch {}
    }

    function warp(uint32 secondsAhead) external {
        vm.warp(block.timestamp + bound(secondsAhead, 1, 3 days));
    }

    /// Payouts are paused about a quarter of the time.
    function togglePause(uint8 roll) external {
        vm.prank(owner);
        challenges.setResolvePaused(roll % 4 == 0);
    }

    function rotateEvaluator(uint256 seed) external {
        vm.prank(owner);
        challenges.setEvaluator(makeAddr(string.concat("evaluator", vm.toString(seed % 4))));
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
        challenges = new WildsentiaChallenges(IERC20(address(usdc)), owner, makeAddr("evaluator"), 1e6, 100e6);
        handler = new ChallengesHandler(challenges, usdc, owner);
        targetContract(address(handler));
    }

    /// The handler really pays prizes both ways and creates by authorization: a fixed sequence,
    /// so a handler whose actions all silently fail cannot make the invariants pass vacuously.
    function test_handlerExercisesEveryPath() public {
        handler.create(0, 10e6, 0);
        handler.createWithAuthorization(1, 20e6, 0);
        handler.create(2, 30e6, 0);
        handler.resolve(1, 0, false);
        handler.resolve(2, 1, true); // the creator as winner must fail
        handler.rotateEvaluator(1);
        handler.resolveAsCurrentEvaluator(3, 2); // an evaluator appointed later must fail
        handler.refund(2, true);
        handler.refund(3, true);
        assertEq(handler.resolved(), 1);
        assertEq(handler.refunded(), 2);
        assertEq(handler.createdByAuthorization(), 1);
        invariant_balanceEqualsOpenPrizes();
        invariant_totalOpenMatchesOpenChallenges();
        invariant_payOnceToARealWinner();
        invariant_onlyTheRecordedEvaluatorPays();
    }

    /// No evaluator appointed after a challenge was created has ever paid it out.
    function invariant_onlyTheRecordedEvaluatorPays() public view {
        assertEq(handler.foreignEvaluatorPayouts(), 0);
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

    /// Each challenge pays out at most once, never to its creator, the escrow or address(0).
    function invariant_payOnceToARealWinner() public view {
        uint256 count = challenges.challengeCount();
        for (uint256 id = 1; id <= count; id++) {
            WildsentiaChallenges.Challenge memory c = challenges.challenge(id);
            assertLe(handler.payoutsOf(id), 1);
            if (c.status == WildsentiaChallenges.Status.Resolved) {
                assertTrue(c.winner != c.creator);
                assertTrue(c.winner != address(0));
                assertTrue(c.winner != address(challenges));
            }
        }
    }
}
