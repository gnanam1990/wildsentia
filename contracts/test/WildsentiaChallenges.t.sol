// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {WildsentiaChallenges} from "../src/WildsentiaChallenges.sol";
import {TestUSDC} from "./mocks/TestUSDC.sol";
import {ChallengesBase} from "./ChallengesBase.sol";

contract CreateTest is ChallengesBase {
    function test_create_locksPrizeAndRecordsTerms() public {
        uint64 deadline = _deadline(3 days);
        vm.expectEmit(address(challenges));
        emit WildsentiaChallenges.ChallengeCreated(1, creator, 10e6, deadline, RULES);
        vm.prank(creator);
        uint256 id = challenges.create(RULES, 10e6, deadline);

        assertEq(id, 1);
        WildsentiaChallenges.Challenge memory c = challenges.challenge(id);
        assertEq(c.creator, creator);
        assertEq(c.prize, 10e6);
        assertEq(c.deadline, deadline);
        assertEq(uint8(c.status), uint8(WildsentiaChallenges.Status.Open));
        assertEq(c.rulesHash, RULES);
        assertEq(usdc.balanceOf(address(challenges)), 10e6);
        assertEq(challenges.totalOpen(), 10e6);
    }

    function test_create_rejectsEmptyRules() public {
        vm.prank(creator);
        vm.expectRevert(WildsentiaChallenges.EmptyRules.selector);
        challenges.create(bytes32(0), 10e6, _deadline(1 days));
    }

    function test_create_rejectsPrizeOutsideLimits() public {
        vm.startPrank(creator);
        vm.expectRevert(WildsentiaChallenges.PrizeOutOfRange.selector);
        challenges.create(RULES, MIN_PRIZE - 1, _deadline(1 days));
        vm.expectRevert(WildsentiaChallenges.PrizeOutOfRange.selector);
        challenges.create(RULES, MAX_PRIZE + 1, _deadline(1 days));
        vm.stopPrank();
    }

    function test_create_rejectsDeadlineOutsideRails() public {
        vm.startPrank(creator);
        vm.expectRevert(WildsentiaChallenges.DeadlineOutOfRange.selector);
        challenges.create(RULES, 10e6, _deadline(12 hours - 1));
        vm.expectRevert(WildsentiaChallenges.DeadlineOutOfRange.selector);
        challenges.create(RULES, 10e6, _deadline(15 days + 1));
        challenges.create(RULES, 10e6, _deadline(12 hours));
        challenges.create(RULES, 10e6, _deadline(15 days));
        vm.stopPrank();
    }

    function test_create_failsWithoutAllowance() public {
        vm.prank(creator);
        usdc.approve(address(challenges), 0);
        vm.prank(creator);
        vm.expectRevert();
        challenges.create(RULES, 10e6, _deadline(1 days));
        assertEq(challenges.challengeCount(), 0);
        assertEq(challenges.totalOpen(), 0);
    }

    function test_create_failsForBlocklistedCreator() public {
        usdc.setBlocklisted(creator, true);
        vm.prank(creator);
        vm.expectRevert(abi.encodeWithSelector(TestUSDC.Blocklisted.selector, creator));
        challenges.create(RULES, 10e6, _deadline(1 days));
    }
}

contract ResolveTest is ChallengesBase {
    function test_resolve_paysWinnerOnce() public {
        uint256 id = _create(10e6);
        bytes32 result = keccak256("attempt log");
        vm.expectEmit(address(challenges));
        emit WildsentiaChallenges.ChallengeResolved(id, player, 10e6, result);
        vm.prank(evaluator);
        challenges.resolve(id, player, result);

        assertEq(usdc.balanceOf(player), 10e6);
        assertEq(usdc.balanceOf(address(challenges)), 0);
        assertEq(challenges.totalOpen(), 0);
        WildsentiaChallenges.Challenge memory c = challenges.challenge(id);
        assertEq(uint8(c.status), uint8(WildsentiaChallenges.Status.Resolved));
        assertEq(c.winner, player);
        assertEq(c.resultHash, result);

        vm.prank(evaluator);
        vm.expectRevert(WildsentiaChallenges.NotOpen.selector);
        challenges.resolve(id, player, result);
        vm.warp(block.timestamp + 2 days);
        vm.expectRevert(WildsentiaChallenges.NotOpen.selector);
        challenges.refund(id);
    }

    function test_resolve_onlyEvaluator() public {
        uint256 id = _create(10e6);
        vm.prank(owner);
        vm.expectRevert(WildsentiaChallenges.NotEvaluator.selector);
        challenges.resolve(id, player, bytes32(0));
        vm.prank(creator);
        vm.expectRevert(WildsentiaChallenges.NotEvaluator.selector);
        challenges.resolve(id, player, bytes32(0));
    }

    function test_resolve_rejectsCreatorOrZeroWinner() public {
        uint256 id = _create(10e6);
        vm.startPrank(evaluator);
        vm.expectRevert(WildsentiaChallenges.BadWinner.selector);
        challenges.resolve(id, creator, bytes32(0));
        vm.expectRevert(WildsentiaChallenges.BadWinner.selector);
        challenges.resolve(id, address(0), bytes32(0));
        vm.stopPrank();
    }

    function test_resolve_rejectsUnknownChallenge() public {
        vm.prank(evaluator);
        vm.expectRevert(WildsentiaChallenges.NotOpen.selector);
        challenges.resolve(42, player, bytes32(0));
    }

    function test_resolve_allowedUntilDeadlinePlusGrace() public {
        uint256 id = _create(10e6);
        WildsentiaChallenges.Challenge memory c = challenges.challenge(id);
        vm.warp(uint256(c.deadline) + challenges.GRACE());
        vm.prank(evaluator);
        challenges.resolve(id, player, bytes32(0));
        assertEq(usdc.balanceOf(player), 10e6);
    }

    function test_resolve_closedAfterGrace() public {
        uint256 id = _create(10e6);
        WildsentiaChallenges.Challenge memory c = challenges.challenge(id);
        vm.warp(uint256(c.deadline) + challenges.GRACE() + 1);
        vm.prank(evaluator);
        vm.expectRevert(WildsentiaChallenges.ResolveWindowClosed.selector);
        challenges.resolve(id, player, bytes32(0));
    }

    function test_resolve_blockedWhilePaused() public {
        uint256 id = _create(10e6);
        vm.prank(owner);
        challenges.setResolvePaused(true);
        vm.prank(evaluator);
        vm.expectRevert(WildsentiaChallenges.ResolveIsPaused.selector);
        challenges.resolve(id, player, bytes32(0));
    }

    function test_resolve_toBlocklistedWinnerRevertsAndPrizeStaysRefundable() public {
        uint256 id = _create(10e6);
        usdc.setBlocklisted(player, true);
        vm.prank(evaluator);
        vm.expectRevert(abi.encodeWithSelector(TestUSDC.Blocklisted.selector, player));
        challenges.resolve(id, player, bytes32(0));
        assertEq(uint8(challenges.challenge(id).status), uint8(WildsentiaChallenges.Status.Open));

        vm.warp(uint256(challenges.challenge(id).deadline) + challenges.GRACE() + 1);
        challenges.refund(id);
        assertEq(usdc.balanceOf(creator), 1_000e6);
    }
}

contract RefundTest is ChallengesBase {
    function test_refund_tooEarlyUntilGracePasses() public {
        uint256 id = _create(10e6);
        WildsentiaChallenges.Challenge memory c = challenges.challenge(id);
        vm.warp(uint256(c.deadline) + challenges.GRACE());
        vm.expectRevert(WildsentiaChallenges.TooEarly.selector);
        challenges.refund(id);
    }

    function test_refund_byAnyoneReturnsPrizeToCreator() public {
        uint256 id = _create(10e6);
        WildsentiaChallenges.Challenge memory c = challenges.challenge(id);
        vm.warp(uint256(c.deadline) + challenges.GRACE() + 1);
        vm.expectEmit(address(challenges));
        emit WildsentiaChallenges.ChallengeRefunded(id, creator, 10e6);
        vm.prank(stranger);
        challenges.refund(id);

        assertEq(usdc.balanceOf(creator), 1_000e6);
        assertEq(usdc.balanceOf(stranger), 0);
        assertEq(challenges.totalOpen(), 0);
        assertEq(uint8(challenges.challenge(id).status), uint8(WildsentiaChallenges.Status.Refunded));

        vm.expectRevert(WildsentiaChallenges.NotOpen.selector);
        challenges.refund(id);
    }

    function test_refund_worksWhilePausedAndAfterEvaluatorChange() public {
        uint256 id = _create(10e6);
        vm.startPrank(owner);
        challenges.setResolvePaused(true);
        challenges.setEvaluator(stranger);
        vm.stopPrank();
        vm.warp(uint256(challenges.challenge(id).deadline) + challenges.GRACE() + 1);
        challenges.refund(id);
        assertEq(usdc.balanceOf(creator), 1_000e6);
    }
}

contract OwnerTest is ChallengesBase {
    function test_ownerFunctions_onlyOwner() public {
        bytes memory notOwner = abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, evaluator);
        vm.startPrank(evaluator);
        vm.expectRevert(notOwner);
        challenges.setEvaluator(evaluator);
        vm.expectRevert(notOwner);
        challenges.setResolvePaused(true);
        vm.expectRevert(notOwner);
        challenges.setPrizeLimits(1, 2);
        vm.stopPrank();
    }

    function test_setEvaluator_rejectsZeroAndMovesRole() public {
        vm.startPrank(owner);
        vm.expectRevert(WildsentiaChallenges.ZeroAddress.selector);
        challenges.setEvaluator(address(0));
        challenges.setEvaluator(stranger);
        vm.stopPrank();
        uint256 id = _create(10e6);
        vm.prank(evaluator);
        vm.expectRevert(WildsentiaChallenges.NotEvaluator.selector);
        challenges.resolve(id, player, bytes32(0));
        vm.prank(stranger);
        challenges.resolve(id, player, bytes32(0));
    }

    function test_setPrizeLimits_validates() public {
        vm.startPrank(owner);
        vm.expectRevert(WildsentiaChallenges.BadPrizeLimits.selector);
        challenges.setPrizeLimits(0, 10e6);
        vm.expectRevert(WildsentiaChallenges.BadPrizeLimits.selector);
        challenges.setPrizeLimits(10e6, 1e6);
        challenges.setPrizeLimits(2e6, 50e6);
        vm.stopPrank();
        assertEq(challenges.minPrize(), 2e6);
        assertEq(challenges.maxPrize(), 50e6);
    }

    function test_renounceOwnership_disabled() public {
        vm.prank(owner);
        vm.expectRevert(WildsentiaChallenges.RenounceDisabled.selector);
        challenges.renounceOwnership();
        assertEq(challenges.owner(), owner);
    }

    function test_ownershipTransfer_isTwoStep() public {
        vm.prank(owner);
        challenges.transferOwnership(stranger);
        assertEq(challenges.owner(), owner);
        vm.prank(stranger);
        challenges.acceptOwnership();
        assertEq(challenges.owner(), stranger);
    }

    function test_constructor_rejectsZeroAddresses() public {
        vm.expectRevert(WildsentiaChallenges.ZeroAddress.selector);
        new WildsentiaChallenges(usdc, owner, address(0), MIN_PRIZE, MAX_PRIZE);
    }
}
