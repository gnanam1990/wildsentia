// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Script} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {WildsentiaBounties} from "../src/WildsentiaBounties.sol";

/// Deploys WildsentiaBounties. Every setting comes from the environment, with no defaults:
///   BOUNTIES_USDC        USDC ERC-20 interface (Arc: 0x3600000000000000000000000000000000000000)
///   BOUNTIES_OWNER       owner (withdraws unreserved pool money, changes the evaluator, pauses payments)
///   BOUNTIES_EVALUATOR   the server's evaluator address (publishes, pays, voids)
///   BOUNTIES_MIN_AMOUNT  smallest bounty, 6-decimal units (1 USDC = 1000000)
///   BOUNTIES_MAX_AMOUNT  largest bounty, 6-decimal units
///   BOUNTIES_MAINNET_APPROVED  optional, "true" only after the legal review: without it only Arc Testnet is allowed
contract DeployBounties is Script {
    uint256 internal constant ARC_TESTNET = 5042002;
    uint96 internal constant MAX_SENSIBLE_AMOUNT = 1_000_000e6;

    struct Config {
        address usdc;
        address owner;
        address evaluator;
        uint96 minAmount;
        uint96 maxAmount;
    }

    function run() external returns (WildsentiaBounties) {
        checkChain(block.chainid, vm.envOr("BOUNTIES_MAINNET_APPROVED", false));
        Config memory config = Config({
            usdc: vm.envAddress("BOUNTIES_USDC"),
            owner: vm.envAddress("BOUNTIES_OWNER"),
            evaluator: vm.envAddress("BOUNTIES_EVALUATOR"),
            minAmount: amount(vm.envUint("BOUNTIES_MIN_AMOUNT")),
            maxAmount: amount(vm.envUint("BOUNTIES_MAX_AMOUNT"))
        });
        vm.startBroadcast();
        WildsentiaBounties deployed = deploy(config);
        vm.stopBroadcast();
        return deployed;
    }

    /// An amount limit from the environment, refused rather than truncated if it does not fit.
    function amount(uint256 value) public pure returns (uint96) {
        require(value <= type(uint96).max, "amount does not fit uint96");
        return uint96(value);
    }

    /// Arc Testnet only, unless mainnet use has been approved.
    function checkChain(uint256 chainId, bool mainnetApproved) public pure {
        require(
            chainId == ARC_TESTNET || mainnetApproved,
            "not Arc Testnet: set BOUNTIES_MAINNET_APPROVED=true only after the legal review"
        );
    }

    function deploy(Config memory config) public returns (WildsentiaBounties) {
        require(config.owner != config.evaluator, "owner and evaluator must differ");
        require(IERC20Metadata(config.usdc).decimals() == 6, "token must have 6 decimals (USDC)");
        require(config.maxAmount <= MAX_SENSIBLE_AMOUNT, "max amount above 1,000,000 USDC: are these 6-decimal units?");
        require(
            config.minAmount >= 1 && config.minAmount <= config.maxAmount,
            "min amount must be at least 1 unit and at most max"
        );
        return new WildsentiaBounties(
            IERC20(config.usdc), config.owner, config.evaluator, config.minAmount, config.maxAmount
        );
    }
}
