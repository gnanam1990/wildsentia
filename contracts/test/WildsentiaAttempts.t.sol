// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {WildsentiaAttempts} from "../src/WildsentiaAttempts.sol";

contract WildsentiaAttemptsTest is Test {
    WildsentiaAttempts internal attempts;
    address internal owner = makeAddr("owner");
    address internal recorder = makeAddr("recorder");
    address internal player = makeAddr("player");
    bytes32 internal constant ID = keccak256("attempt-1");

    function setUp() public {
        attempts = new WildsentiaAttempts(owner, recorder);
    }

    function test_records_startThenEnd_once() public {
        vm.expectEmit(address(attempts));
        emit WildsentiaAttempts.AttemptStarted(ID, 7, player);
        vm.prank(recorder);
        attempts.recordStart(ID, 7, player);
        assertEq(attempts.stage(ID), 1);

        vm.prank(recorder);
        vm.expectRevert(WildsentiaAttempts.AlreadyStarted.selector);
        attempts.recordStart(ID, 7, player);

        vm.expectEmit(address(attempts));
        emit WildsentiaAttempts.AttemptEnded(ID, 7, WildsentiaAttempts.Outcome.Met, keccak256("log"));
        vm.prank(recorder);
        attempts.recordEnd(ID, 7, WildsentiaAttempts.Outcome.Met, keccak256("log"));
        assertEq(attempts.stage(ID), 2);

        vm.startPrank(recorder);
        vm.expectRevert(WildsentiaAttempts.AlreadyEnded.selector);
        attempts.recordEnd(ID, 7, WildsentiaAttempts.Outcome.Failed, bytes32(0));
        vm.expectRevert(WildsentiaAttempts.AlreadyStarted.selector);
        attempts.recordStart(ID, 7, player);
        vm.stopPrank();
    }

    function test_end_withoutRecordedStart_andNeverAsNone() public {
        vm.startPrank(recorder);
        vm.expectRevert(WildsentiaAttempts.BadOutcome.selector);
        attempts.recordEnd(ID, 7, WildsentiaAttempts.Outcome.None, bytes32(0));
        attempts.recordEnd(ID, 7, WildsentiaAttempts.Outcome.Void, bytes32(0));
        vm.stopPrank();
        assertEq(attempts.stage(ID), 2);
    }

    function test_onlyRecorderWrites_onlyOwnerMovesTheRole() public {
        vm.expectRevert(WildsentiaAttempts.NotRecorder.selector);
        attempts.recordStart(ID, 7, player);
        vm.prank(recorder);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, recorder));
        attempts.setRecorder(player);
        vm.startPrank(owner);
        vm.expectRevert(WildsentiaAttempts.ZeroAddress.selector);
        attempts.setRecorder(address(0));
        attempts.setRecorder(player);
        vm.expectRevert(WildsentiaAttempts.RenounceDisabled.selector);
        attempts.renounceOwnership();
        vm.stopPrank();
        vm.prank(player);
        attempts.recordStart(ID, 7, player);
    }

    function test_constructor_rejectsZeroRecorder() public {
        vm.expectRevert(WildsentiaAttempts.ZeroAddress.selector);
        new WildsentiaAttempts(owner, address(0));
    }
}
