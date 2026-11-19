// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {WildsentiaChallenges} from "../src/WildsentiaChallenges.sol";
import {ChallengesBase} from "./ChallengesBase.sol";

/// Version 2's rails (docs/2026-11-17-security-audit.md, finding C1), on a deployment left at its
/// defaults: what a stolen evaluator key can take is bounded.
contract WildsentiaChallengesRailsTest is ChallengesBase {
    function setUp() public override {
        super.setUp();
        challenges = new WildsentiaChallenges(IERC20(address(usdc)), owner, evaluator, MIN_PRIZE, MAX_PRIZE);
        vm.prank(creator);
        usdc.approve(address(challenges), type(uint256).max);
    }

    function _resolve(uint256 id, address winner) internal {
        vm.prank(evaluator);
        challenges.resolve(id, winner, keccak256("log"));
    }

    function test_defaults_oneTopPrizeADayAndTenMinutesOpen() public view {
        assertEq(challenges.dailyPayoutCap(), MAX_PRIZE);
        assertEq(challenges.minOpenSeconds(), 10 minutes);
    }

    function test_resolve_waitsTheMinimumOpenTime() public {
        uint256 id = _create(10e6);
        vm.warp(block.timestamp + 10 minutes - 1);
        vm.prank(evaluator);
        vm.expectRevert(WildsentiaChallenges.TooEarly.selector);
        challenges.resolve(id, player, bytes32(0));
        vm.warp(block.timestamp + 1);
        _resolve(id, player);
        assertEq(usdc.balanceOf(player), 10e6);
    }

    function test_resolve_cappedPerUtcDay_refundsUncapped() public {
        uint256 a = _create(60e6);
        uint256 b = _create(50e6);
        uint256 c = _create(40e6);
        vm.warp(block.timestamp + 10 minutes);
        _resolve(a, player);
        vm.prank(evaluator);
        vm.expectRevert(WildsentiaChallenges.DailyCapReached.selector);
        challenges.resolve(b, player, bytes32(0));
        _resolve(c, player); // 60 + 40 = the 100 USDC cap
        assertEq(challenges.paidToday(), 100e6);
        // The next UTC day starts a new count.
        vm.warp((block.timestamp / 1 days + 1) * 1 days);
        _resolve(b, player);
        assertEq(challenges.paidToday(), 50e6);
        assertEq(usdc.balanceOf(player), 150e6);
    }

    function test_resolve_neverPaysTheEvaluatorOrTheOwner() public {
        uint256 id = _create(10e6);
        vm.warp(block.timestamp + 10 minutes);
        address next = makeAddr("next evaluator");
        vm.prank(owner);
        challenges.setEvaluator(next);
        address[3] memory refused = [evaluator, next, owner];
        for (uint256 i; i < refused.length; i++) {
            vm.prank(evaluator);
            vm.expectRevert(WildsentiaChallenges.BadWinner.selector);
            challenges.resolve(id, refused[i], bytes32(0));
        }
        _resolve(id, player);
    }

    function test_revoke_stopsPayingAndRefundsAtOnce() public {
        uint256 id = _create(10e6);
        vm.warp(block.timestamp + 10 minutes);
        vm.prank(stranger);
        vm.expectRevert();
        challenges.revokeEvaluator(evaluator);
        vm.prank(owner);
        challenges.revokeEvaluator(evaluator);
        vm.prank(evaluator);
        vm.expectRevert(WildsentiaChallenges.NotEvaluator.selector);
        challenges.resolve(id, player, bytes32(0));
        // Long before the deadline, anyone may return the prize to its creator.
        uint256 before = usdc.balanceOf(creator);
        vm.prank(stranger);
        challenges.refund(id);
        assertEq(usdc.balanceOf(creator) - before, 10e6);
        // A revoked key cannot be appointed again.
        vm.prank(owner);
        vm.expectRevert(WildsentiaChallenges.Revoked.selector);
        challenges.setEvaluator(evaluator);
    }

    function test_ownerRails_validated() public {
        vm.startPrank(owner);
        vm.expectRevert(WildsentiaChallenges.BadLimits.selector);
        challenges.setDailyPayoutCap(MAX_PRIZE - 1);
        vm.expectRevert(WildsentiaChallenges.BadLimits.selector);
        challenges.setMinOpenSeconds(1 days + 1);
        // The top prize may not outgrow the cap.
        vm.expectRevert(WildsentiaChallenges.BadLimits.selector);
        challenges.setPrizeLimits(MIN_PRIZE, MAX_PRIZE + 1);
        challenges.setDailyPayoutCap(500e6);
        challenges.setPrizeLimits(MIN_PRIZE, 200e6);
        challenges.setMinOpenSeconds(1 hours);
        vm.stopPrank();
        assertEq(challenges.dailyPayoutCap(), 500e6);
        assertEq(challenges.maxPrize(), 200e6);
        assertEq(challenges.minOpenSeconds(), 1 hours);
        vm.prank(stranger);
        vm.expectRevert();
        challenges.setDailyPayoutCap(1_000e6);
    }
}
