// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {Deploy} from "../script/Deploy.s.sol";
import {WildsentiaChallenges} from "../src/WildsentiaChallenges.sol";
import {TestUSDC} from "./mocks/TestUSDC.sol";
import {DeployAttempts} from "../script/DeployAttempts.s.sol";
import {WildsentiaAttempts} from "../src/WildsentiaAttempts.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// A token with 18 decimals, as if Arc's native gas amounts were given instead of USDC's.
contract EighteenDecimals is ERC20("Native-looking", "N18") {}

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

contract DeployGuardsTest is Test {
    Deploy internal d = new Deploy();

    function test_deploy_refusesATokenThatIsNotSixDecimals() public {
        address token = address(new EighteenDecimals());
        vm.expectRevert(bytes("token must have 6 decimals (USDC)"));
        d.deploy(Deploy.Config(token, makeAddr("owner"), makeAddr("evaluator"), 1e6, 100e6));
    }

    function test_deploy_refusesPrizeLimitsThatLookLike18Decimals() public {
        address token = address(new TestUSDC());
        vm.expectRevert(bytes("max prize above 1,000,000 USDC: are these 6-decimal units?"));
        d.deploy(Deploy.Config(token, makeAddr("owner"), makeAddr("evaluator"), 1e6, 1e18));
        vm.expectRevert(bytes("min prize must be at least 1 unit and at most max"));
        d.deploy(Deploy.Config(token, makeAddr("owner"), makeAddr("evaluator"), 200e6, 100e6));
    }

    function test_prize_neverTruncatesAnOversizedValue() public {
        assertEq(d.prize(100e6), 100e6);
        vm.expectRevert(bytes("prize does not fit uint96"));
        d.prize(uint256(type(uint96).max) + 1);
    }

    function test_chain_isArcTestnetUnlessMainnetIsApproved() public {
        d.checkChain(5042002, false);
        d.checkChain(1, true);
        vm.expectRevert(bytes("not Arc Testnet: set CHALLENGES_MAINNET_APPROVED=true only after the legal review"));
        d.checkChain(1, false);
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
