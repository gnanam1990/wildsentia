// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Script} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {WildsentiaChallenges} from "../src/WildsentiaChallenges.sol";

/// Deploys WildsentiaChallenges. Every setting comes from the environment; there are no defaults
/// for addresses or limits, so a missing value stops the deployment.
///   CHALLENGES_USDC       USDC ERC-20 interface (Arc: 0x3600000000000000000000000000000000000000)
///   CHALLENGES_OWNER      owner (can change the evaluator, pause payouts, set limits)
///   CHALLENGES_EVALUATOR  the server's evaluator address (pays winners)
///   CHALLENGES_MIN_PRIZE  smallest prize, 6-decimal units (1 USDC = 1000000)
///   CHALLENGES_MAX_PRIZE  largest prize, 6-decimal units
contract Deploy is Script {
    struct Config {
        address usdc;
        address owner;
        address evaluator;
        uint96 minPrize;
        uint96 maxPrize;
    }

    function run() external returns (WildsentiaChallenges) {
        Config memory config = Config({
            usdc: vm.envAddress("CHALLENGES_USDC"),
            owner: vm.envAddress("CHALLENGES_OWNER"),
            evaluator: vm.envAddress("CHALLENGES_EVALUATOR"),
            minPrize: uint96(vm.envUint("CHALLENGES_MIN_PRIZE")),
            maxPrize: uint96(vm.envUint("CHALLENGES_MAX_PRIZE"))
        });
        vm.startBroadcast();
        WildsentiaChallenges deployed = deploy(config);
        vm.stopBroadcast();
        return deployed;
    }

    function deploy(Config memory config) public returns (WildsentiaChallenges) {
        require(config.owner != config.evaluator, "owner and evaluator must differ");
        return
            new WildsentiaChallenges(
                IERC20(config.usdc), config.owner, config.evaluator, config.minPrize, config.maxPrize
            );
    }
}
