// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {WildsentiaChallenges} from "../src/WildsentiaChallenges.sol";
import {TestUSDC} from "./mocks/TestUSDC.sol";

abstract contract ChallengesBase is Test {
    uint96 internal constant ONE = 1e6; // 1 USDC in 6-decimal ERC-20 units
    uint96 internal constant MIN_PRIZE = 1e6;
    uint96 internal constant MAX_PRIZE = 100e6;
    bytes32 internal constant RULES = keccak256("survive@1:chital:days=1");

    TestUSDC internal usdc;
    WildsentiaChallenges internal challenges;
    address internal owner = makeAddr("owner");
    address internal evaluator = makeAddr("evaluator");
    address internal creator;
    uint256 internal creatorKey;
    address internal player = makeAddr("player");
    address internal stranger = makeAddr("stranger");

    function setUp() public virtual {
        vm.warp(1_790_000_000);
        (creator, creatorKey) = makeAddrAndKey("creator");
        usdc = new TestUSDC();
        challenges = new WildsentiaChallenges(IERC20(address(usdc)), owner, evaluator, MIN_PRIZE, MAX_PRIZE);
        // These suites test escrow and settlement; the version 2 rails (daily cap, minimum open time)
        // have their own suite, WildsentiaChallengesRails.t.sol, on the defaults.
        vm.startPrank(owner);
        challenges.setDailyPayoutCap(type(uint256).max);
        challenges.setMinOpenSeconds(0);
        vm.stopPrank();
        usdc.mint(creator, 1_000e6);
        vm.prank(creator);
        usdc.approve(address(challenges), type(uint256).max);
    }

    function _deadline(uint256 fromNow) internal view returns (uint64) {
        return uint64(block.timestamp + fromNow);
    }

    function _create(uint96 prize) internal returns (uint256 id) {
        vm.prank(creator);
        id = challenges.create(RULES, prize, _deadline(1 days));
    }

    function _signReceive(
        uint256 key,
        address from,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce
    ) internal view returns (bytes memory) {
        bytes32 structHash = keccak256(
            abi.encode(
                usdc.RECEIVE_WITH_AUTHORIZATION_TYPEHASH(),
                from,
                address(challenges),
                value,
                validAfter,
                validBefore,
                nonce
            )
        );
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", usdc.DOMAIN_SEPARATOR(), structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, digest);
        return abi.encodePacked(r, s, v);
    }
}
