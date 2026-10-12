// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {TestUSDC} from "./mocks/TestUSDC.sol";

contract TestUSDCTest is Test {
    TestUSDC internal usdc;

    function setUp() public {
        usdc = new TestUSDC();
    }

    function test_sixDecimals() public view {
        assertEq(usdc.decimals(), 6);
    }

    function test_blocklistBlocksBothDirections() public {
        address a = makeAddr("a");
        address b = makeAddr("b");
        usdc.mint(a, 5e6);
        usdc.setBlocklisted(b, true);
        vm.prank(a);
        vm.expectRevert(abi.encodeWithSelector(TestUSDC.Blocklisted.selector, b));
        usdc.transfer(b, 1e6);
        usdc.setBlocklisted(b, false);
        usdc.setBlocklisted(a, true);
        vm.prank(a);
        vm.expectRevert(abi.encodeWithSelector(TestUSDC.Blocklisted.selector, a));
        usdc.transfer(b, 1e6);
    }
}
