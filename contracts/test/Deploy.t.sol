// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {Deploy} from "../script/Deploy.s.sol";
import {WildsentiaChallenges} from "../src/WildsentiaChallenges.sol";
import {TestUSDC} from "./mocks/TestUSDC.sol";
import {DeployAttempts} from "../script/DeployAttempts.s.sol";
import {WildsentiaAttempts} from "../src/WildsentiaAttempts.sol";

contract DeployTest is Test {
    function test_deploy_usesTheGivenTerms() public {
        TestUSDC usdc = new TestUSDC();
        WildsentiaChallenges c =
            new Deploy().deploy(Deploy.Config(address(usdc), makeAddr("owner"), makeAddr("evaluator"), 1e6, 100e6));
        assertEq(address(c.usdc()), address(usdc));
        assertEq(c.owner(), makeAddr("owner"));
        assertEq(c.evaluator(), makeAddr("evaluator"));
        assertEq(c.minPrize(), 1e6);
        assertEq(c.maxPrize(), 100e6);
    }

    function test_deploy_refusesOwnerAsEvaluator() public {
        TestUSDC usdc = new TestUSDC();
        Deploy d = new Deploy();
        vm.expectRevert(bytes("owner and evaluator must differ"));
        d.deploy(Deploy.Config(address(usdc), makeAddr("same"), makeAddr("same"), 1e6, 100e6));
    }
}

contract DeployAttemptsTest is Test {
    function test_deployAttempts_setsOwnerAndRecorder() public {
        WildsentiaAttempts a = new DeployAttempts().deploy(makeAddr("owner"), makeAddr("recorder"));
        assertEq(a.owner(), makeAddr("owner"));
        assertEq(a.recorder(), makeAddr("recorder"));
    }

    function test_deployAttempts_refusesOwnerAsRecorder() public {
        DeployAttempts d = new DeployAttempts();
        vm.expectRevert(bytes("owner and recorder must differ"));
        d.deploy(makeAddr("same"), makeAddr("same"));
    }
}
