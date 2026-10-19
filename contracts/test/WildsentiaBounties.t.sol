// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {WildsentiaBounties} from "../src/WildsentiaBounties.sol";
import {TestUSDC} from "./mocks/TestUSDC.sol";

contract WildsentiaBountiesTest is Test {
    uint96 internal constant ONE = 1e6; // 1 USDC in 6-decimal ERC-20 units
    bytes32 internal constant ID = keccak256("bounty-1");
    bytes32 internal constant RULES = keccak256("congo-bounty@1:standard");
    bytes32 internal constant TARGET = keccak256("blue_duiker_00e5:life-1");
    bytes32 internal constant SALT = keccak256("salt");

    TestUSDC internal usdc;
    WildsentiaBounties internal bounties;
    address internal owner = makeAddr("owner");
    address internal evaluator = makeAddr("evaluator");
    address internal treasury = makeAddr("treasury");
    address internal hunter = makeAddr("hunter");
    address internal prey = makeAddr("prey");
    address internal stranger = makeAddr("stranger");

    function setUp() public {
        vm.warp(1_790_000_000);
        usdc = new TestUSDC();
        bounties = new WildsentiaBounties(IERC20(address(usdc)), owner, evaluator, ONE, 100 * ONE);
        usdc.mint(treasury, 1_000 * ONE);
        vm.prank(treasury);
        usdc.approve(address(bounties), type(uint256).max);
        vm.prank(treasury);
        bounties.fund(100 * ONE);
        assertEq(bounties.commitOf(TARGET, SALT), _commit());
    }

    /// keccak256(abi.encode(TARGET, SALT)), worked out here: calling `commitOf` would use up a prank.
    function _commit() internal pure returns (bytes32) {
        return keccak256(abi.encode(TARGET, SALT));
    }

    function _publish(uint96 amount) internal {
        vm.prank(evaluator);
        bounties.publish(ID, amount, uint64(block.timestamp + 1 days), RULES, _commit());
    }

    function test_fundAddsToThePool() public view {
        assertEq(bounties.pool(), 100 * ONE);
        assertEq(usdc.balanceOf(address(bounties)), 100 * ONE);
    }

    function test_publishReservesFromThePool() public {
        _publish(50 * ONE);
        assertEq(bounties.pool(), 50 * ONE);
        assertEq(bounties.reserved(), 50 * ONE);
        WildsentiaBounties.Bounty memory b = bounties.bounty(ID);
        assertEq(uint8(b.status), uint8(WildsentiaBounties.Status.Open));
        assertEq(b.evaluator, evaluator);
        assertEq(b.target, bytes32(0)); // still secret
    }

    function test_publishIsTheEvaluatorsAndWithinLimits() public {
        vm.prank(stranger);
        vm.expectRevert(WildsentiaBounties.NotEvaluator.selector);
        bounties.publish(ID, ONE, uint64(block.timestamp + 1 days), RULES, _commit());
        vm.startPrank(evaluator);
        vm.expectRevert(WildsentiaBounties.AmountOutOfRange.selector);
        bounties.publish(ID, 101 * ONE, uint64(block.timestamp + 1 days), RULES, _commit());
        vm.expectRevert(WildsentiaBounties.ExpiryOutOfRange.selector);
        bounties.publish(ID, ONE, uint64(block.timestamp + 31 days), RULES, _commit());
        vm.expectRevert(WildsentiaBounties.ExpiryOutOfRange.selector);
        bounties.publish(ID, ONE, uint64(block.timestamp), RULES, _commit());
        vm.expectRevert(WildsentiaBounties.EmptyCommit.selector);
        bounties.publish(ID, ONE, uint64(block.timestamp + 1 days), RULES, bytes32(0));
        bounties.publish(ID, ONE, uint64(block.timestamp + 1 days), RULES, _commit());
        vm.expectRevert(WildsentiaBounties.AlreadyExists.selector);
        bounties.publish(ID, ONE, uint64(block.timestamp + 1 days), RULES, _commit());
        vm.stopPrank();
    }

    function test_publishCannotReserveMoreThanThePool() public {
        _publish(60 * ONE);
        vm.prank(evaluator);
        vm.expectRevert(WildsentiaBounties.PoolTooSmall.selector);
        bounties.publish(keccak256("bounty-2"), 41 * ONE, uint64(block.timestamp + 1 days), RULES, _commit());
    }

    function test_settlePaysTheHuntersAgentAndRevealsTheTarget() public {
        _publish(50 * ONE);
        bytes32 record = keccak256("record");
        vm.prank(evaluator);
        bounties.settle(ID, WildsentiaBounties.Outcome.Predator, hunter, record, TARGET, SALT);
        assertEq(usdc.balanceOf(hunter), 50 * ONE);
        assertEq(bounties.reserved(), 0);
        assertEq(bounties.pool(), 50 * ONE);
        WildsentiaBounties.Bounty memory b = bounties.bounty(ID);
        assertEq(uint8(b.status), uint8(WildsentiaBounties.Status.Paid));
        assertEq(uint8(b.outcome), uint8(WildsentiaBounties.Outcome.Predator));
        assertEq(b.payee, hunter);
        assertEq(b.target, TARGET);
        assertEq(b.recordHash, record);
    }

    function test_settlePaysThePreysAgentThatSurvived() public {
        _publish(10 * ONE);
        vm.prank(evaluator);
        bounties.settle(ID, WildsentiaBounties.Outcome.Survived, prey, keccak256("record"), TARGET, SALT);
        assertEq(usdc.balanceOf(prey), 10 * ONE);
    }

    function test_settleOnceOnlyByItsEvaluatorWithTheRightReveal() public {
        _publish(10 * ONE);
        vm.prank(stranger);
        vm.expectRevert(WildsentiaBounties.NotEvaluator.selector);
        bounties.settle(ID, WildsentiaBounties.Outcome.Predator, hunter, bytes32(0), TARGET, SALT);
        vm.startPrank(evaluator);
        vm.expectRevert(WildsentiaBounties.BadReveal.selector);
        bounties.settle(ID, WildsentiaBounties.Outcome.Predator, hunter, bytes32(0), keccak256("other"), SALT);
        vm.expectRevert(WildsentiaBounties.BadOutcome.selector);
        bounties.settle(ID, WildsentiaBounties.Outcome.None, hunter, bytes32(0), TARGET, SALT);
        bounties.settle(ID, WildsentiaBounties.Outcome.Predator, hunter, bytes32(0), TARGET, SALT);
        vm.expectRevert(WildsentiaBounties.NotOpen.selector);
        bounties.settle(ID, WildsentiaBounties.Outcome.Predator, hunter, bytes32(0), TARGET, SALT);
        vm.stopPrank();
    }

    function test_neitherTheEvaluatorNorTheOwnerNorTheContractCanBePaid() public {
        _publish(10 * ONE);
        address[4] memory bad = [evaluator, owner, address(bounties), address(0)];
        for (uint256 i; i < bad.length; i++) {
            vm.prank(evaluator);
            vm.expectRevert(WildsentiaBounties.BadPayee.selector);
            bounties.settle(ID, WildsentiaBounties.Outcome.Predator, bad[i], bytes32(0), TARGET, SALT);
        }
    }

    function test_voidReturnsTheBountyToThePool() public {
        _publish(30 * ONE);
        vm.prank(evaluator);
        bounties.voidBounty(ID, keccak256("record"), TARGET, SALT);
        assertEq(bounties.pool(), 100 * ONE);
        assertEq(bounties.reserved(), 0);
        assertEq(uint8(bounties.bounty(ID).status), uint8(WildsentiaBounties.Status.Voided));
        assertEq(bounties.bounty(ID).target, TARGET);
    }

    function test_anExpiredBountyReturnsToThePoolForAnyoneAndCanNoLongerBePaid() public {
        _publish(30 * ONE);
        vm.prank(stranger);
        vm.expectRevert(WildsentiaBounties.NotExpired.selector);
        bounties.expire(ID);
        vm.warp(block.timestamp + 1 days + 1);
        vm.prank(evaluator);
        vm.expectRevert(WildsentiaBounties.Expired.selector);
        bounties.settle(ID, WildsentiaBounties.Outcome.Predator, hunter, bytes32(0), TARGET, SALT);
        vm.prank(stranger);
        bounties.expire(ID);
        assertEq(bounties.pool(), 100 * ONE);
        assertEq(uint8(bounties.bounty(ID).status), uint8(WildsentiaBounties.Status.Expired));
    }

    function test_pausingStopsPaymentsButNotReturns() public {
        _publish(30 * ONE);
        vm.prank(owner);
        bounties.setSettlePaused(true);
        vm.prank(evaluator);
        vm.expectRevert(WildsentiaBounties.SettleIsPaused.selector);
        bounties.settle(ID, WildsentiaBounties.Outcome.Predator, hunter, bytes32(0), TARGET, SALT);
        vm.prank(evaluator);
        bounties.voidBounty(ID, bytes32(0), TARGET, SALT);
        assertEq(bounties.pool(), 100 * ONE);
    }

    function test_theOwnerWithdrawsOnlyUnreservedMoney() public {
        _publish(70 * ONE);
        vm.prank(owner);
        vm.expectRevert(WildsentiaBounties.PoolTooSmall.selector);
        bounties.withdraw(31 * ONE, treasury);
        vm.prank(owner);
        bounties.withdraw(30 * ONE, treasury);
        assertEq(bounties.pool(), 0);
        assertEq(usdc.balanceOf(address(bounties)), 70 * ONE);
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        bounties.withdraw(1, stranger);
    }

    function test_aNewEvaluatorCannotDecideBountiesPublishedBeforeIt() public {
        _publish(10 * ONE);
        address next = makeAddr("next");
        vm.prank(owner);
        bounties.setEvaluator(next);
        vm.prank(next);
        vm.expectRevert(WildsentiaBounties.NotEvaluator.selector);
        bounties.settle(ID, WildsentiaBounties.Outcome.Predator, hunter, bytes32(0), TARGET, SALT);
        // The old evaluator still can, and cannot be paid either.
        vm.prank(evaluator);
        vm.expectRevert(WildsentiaBounties.BadPayee.selector);
        bounties.settle(ID, WildsentiaBounties.Outcome.Predator, next, bytes32(0), TARGET, SALT);
        vm.prank(evaluator);
        bounties.settle(ID, WildsentiaBounties.Outcome.Predator, hunter, bytes32(0), TARGET, SALT);
    }

    function test_renounceIsDisabled() public {
        vm.prank(owner);
        vm.expectRevert(WildsentiaBounties.RenounceDisabled.selector);
        bounties.renounceOwnership();
    }

    /// The contract always holds exactly the pool plus what open bounties reserve.
    function testFuzz_balanceIsPoolPlusReserved(uint96 a, uint96 b, uint8 decide) public {
        a = uint96(bound(a, ONE, 50 * ONE));
        b = uint96(bound(b, ONE, 50 * ONE));
        vm.startPrank(evaluator);
        bounties.publish(ID, a, uint64(block.timestamp + 1 days), RULES, _commit());
        bytes32 id2 = keccak256("bounty-2");
        bounties.publish(id2, b, uint64(block.timestamp + 2 days), RULES, _commit());
        if (decide % 3 == 0) bounties.settle(ID, WildsentiaBounties.Outcome.Predator, hunter, bytes32(0), TARGET, SALT);
        else if (decide % 3 == 1) bounties.voidBounty(ID, bytes32(0), TARGET, SALT);
        vm.stopPrank();
        if (decide % 3 == 2) {
            vm.warp(block.timestamp + 1 days + 1);
            bounties.expire(ID);
        }
        assertEq(usdc.balanceOf(address(bounties)), bounties.pool() + bounties.reserved());
    }
}
