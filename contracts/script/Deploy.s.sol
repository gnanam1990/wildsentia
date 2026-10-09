// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Script} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {WildsentiaChallenges} from "../src/WildsentiaChallenges.sol";

/// Deploys WildsentiaChallenges. Every setting comes from the environment; there are no defaults
/// for addresses or limits, so a missing value stops the deployment.
///   CHALLENGES_USDC       USDC ERC-20 interface (Arc: 0x3600000000000000000000000000000000000000)
///   CHALLENGES_OWNER      owner (can change the evaluator, pause payouts, set limits)
///   CHALLENGES_EVALUATOR  the server's evaluator address (pays winners)
///   CHALLENGES_MIN_PRIZE  smallest prize, 6-decimal units (1 USDC = 1000000)
///   CHALLENGES_MAX_PRIZE  largest prize, 6-decimal units
///   CHALLENGES_MAINNET_APPROVED  optional, "true" only after the legal review: without it only Arc Testnet is allowed
/// On Arc, native gas amounts have 18 decimals and USDC's ERC-20 interface 6; the guards below stop
/// an 18-decimal number or token from being used by mistake.
contract Deploy is Script {
    uint256 internal constant ARC_TESTNET = 5042002;
    uint96 internal constant MAX_SENSIBLE_PRIZE = 1_000_000e6;

    struct Config {
        address usdc;
        address owner;
        address evaluator;
        uint96 minPrize;
        uint96 maxPrize;
    }

    function run() external returns (WildsentiaChallenges) {
        checkChain(block.chainid, vm.envOr("CHALLENGES_MAINNET_APPROVED", false));
        Config memory config = Config({
            usdc: vm.envAddress("CHALLENGES_USDC"),
            owner: vm.envAddress("CHALLENGES_OWNER"),
            evaluator: vm.envAddress("CHALLENGES_EVALUATOR"),
            minPrize: prize(vm.envUint("CHALLENGES_MIN_PRIZE")),
            maxPrize: prize(vm.envUint("CHALLENGES_MAX_PRIZE"))
        });
        vm.startBroadcast();
        WildsentiaChallenges deployed = deploy(config);
        vm.stopBroadcast();
        return deployed;
    }

    /// A prize limit from the environment, refused rather than truncated if it does not fit.
    function prize(uint256 value) public pure returns (uint96) {
        require(value <= type(uint96).max, "prize does not fit uint96");
        return uint96(value);
    }

    /// Arc Testnet only, unless mainnet use has been approved.
    function checkChain(uint256 chainId, bool mainnetApproved) public pure {
        require(
            chainId == ARC_TESTNET || mainnetApproved,
            "not Arc Testnet: set CHALLENGES_MAINNET_APPROVED=true only after the legal review"
        );
    }

    function deploy(Config memory config) public returns (WildsentiaChallenges) {
        require(config.owner != config.evaluator, "owner and evaluator must differ");
        require(IERC20Metadata(config.usdc).decimals() == 6, "token must have 6 decimals (USDC)");
        require(config.maxPrize <= MAX_SENSIBLE_PRIZE, "max prize above 1,000,000 USDC: are these 6-decimal units?");
        require(
            config.minPrize >= 1 && config.minPrize <= config.maxPrize,
            "min prize must be at least 1 unit and at most max"
        );
        return
            new WildsentiaChallenges(
                IERC20(config.usdc), config.owner, config.evaluator, config.minPrize, config.maxPrize
            );
    }
}
