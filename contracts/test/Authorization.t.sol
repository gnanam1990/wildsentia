// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {WildsentiaChallenges} from "../src/WildsentiaChallenges.sol";
import {TestUSDC} from "./mocks/TestUSDC.sol";
import {ChallengesBase} from "./ChallengesBase.sol";

contract AuthorizationTest is ChallengesBase {
    bytes32 internal constant SALT = keccak256("salt-1");

    function setUp() public override {
        super.setUp();
        vm.prank(creator);
        usdc.approve(address(challenges), 0); // the authorization path must not need an allowance
    }

    function _signed(uint96 prize, uint64 deadline, bytes32 salt) internal view returns (bytes memory) {
        bytes32 nonce = challenges.authorizationNonce(creator, RULES, prize, deadline, salt);
        return _signReceive(creatorKey, creator, prize, 0, block.timestamp + 1 hours, nonce);
    }

    function test_createWithAuthorization_relayedByAnyone() public {
        uint64 deadline = _deadline(2 days);
        bytes memory sig = _signed(10e6, deadline, SALT);
        vm.prank(stranger);
        uint256 id =
            challenges.createWithAuthorization(creator, RULES, 10e6, deadline, SALT, 0, block.timestamp + 1 hours, sig);
        WildsentiaChallenges.Challenge memory c = challenges.challenge(id);
        assertEq(c.creator, creator);
        assertEq(c.prize, 10e6);
        assertEq(usdc.balanceOf(address(challenges)), 10e6);
        assertEq(usdc.balanceOf(creator), 990e6);
    }

    function test_createWithAuthorization_rejectsChangedTerms() public {
        uint64 deadline = _deadline(2 days);
        bytes memory sig = _signed(10e6, deadline, SALT);
        uint256 validBefore = block.timestamp + 1 hours;
        vm.startPrank(stranger);
        // Another rules hash, prize, deadline or salt gives another nonce, so the signature fails.
        vm.expectRevert(TestUSDC.InvalidSignature.selector);
        challenges.createWithAuthorization(creator, keccak256("other"), 10e6, deadline, SALT, 0, validBefore, sig);
        vm.expectRevert(TestUSDC.InvalidSignature.selector);
        challenges.createWithAuthorization(creator, RULES, 10e6, deadline + 1 days, SALT, 0, validBefore, sig);
        vm.expectRevert(TestUSDC.InvalidSignature.selector);
        challenges.createWithAuthorization(creator, RULES, 10e6, deadline, keccak256("x"), 0, validBefore, sig);
        vm.expectRevert(TestUSDC.InvalidSignature.selector);
        challenges.createWithAuthorization(stranger, RULES, 10e6, deadline, SALT, 0, validBefore, sig);
        vm.stopPrank();
        assertEq(challenges.challengeCount(), 0);
        assertEq(usdc.balanceOf(creator), 1_000e6);
    }

    function test_createWithAuthorization_cannotBeReplayed() public {
        uint64 deadline = _deadline(2 days);
        bytes memory sig = _signed(10e6, deadline, SALT);
        uint256 validBefore = block.timestamp + 1 hours;
        challenges.createWithAuthorization(creator, RULES, 10e6, deadline, SALT, 0, validBefore, sig);
        vm.expectRevert(TestUSDC.AuthorizationUsed.selector);
        challenges.createWithAuthorization(creator, RULES, 10e6, deadline, SALT, 0, validBefore, sig);
        assertEq(challenges.challengeCount(), 1);
    }

    function test_createWithAuthorization_sameTermsTwiceNeedsANewSalt() public {
        uint64 deadline = _deadline(2 days);
        uint256 validBefore = block.timestamp + 1 hours;
        challenges.createWithAuthorization(
            creator, RULES, 10e6, deadline, SALT, 0, validBefore, _signed(10e6, deadline, SALT)
        );
        bytes32 salt2 = keccak256("salt-2");
        challenges.createWithAuthorization(
            creator, RULES, 10e6, deadline, salt2, 0, validBefore, _signed(10e6, deadline, salt2)
        );
        assertEq(challenges.challengeCount(), 2);
        assertEq(challenges.totalOpen(), 20e6);
    }

    function test_createWithAuthorization_rejectsExpiredAuthorization() public {
        uint64 deadline = _deadline(2 days);
        bytes memory sig = _signed(10e6, deadline, SALT);
        uint256 validBefore = block.timestamp + 1 hours;
        vm.warp(validBefore);
        vm.expectRevert(TestUSDC.AuthorizationExpired.selector);
        challenges.createWithAuthorization(creator, RULES, 10e6, deadline, SALT, 0, validBefore, sig);
    }

    function test_createWithAuthorization_rejectsZeroCreator() public {
        vm.expectRevert(WildsentiaChallenges.ZeroAddress.selector);
        challenges.createWithAuthorization(address(0), RULES, 10e6, _deadline(2 days), SALT, 0, 1, "");
    }

    function test_authorizationNonce_bindsChainAndContract() public {
        uint64 deadline = _deadline(2 days);
        bytes32 a = challenges.authorizationNonce(creator, RULES, 10e6, deadline, SALT);
        vm.chainId(block.chainid + 1);
        assertTrue(a != challenges.authorizationNonce(creator, RULES, 10e6, deadline, SALT));
    }
}
