// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Script} from "forge-std/Script.sol";
import {WildsentiaAttempts} from "../src/WildsentiaAttempts.sol";

/// Deploys WildsentiaAttempts. Every setting comes from the environment:
///   CHALLENGES_OWNER      owner (can change the recorder)
///   CHALLENGES_EVALUATOR  the server's key, which records attempts (the same key that pays winners)
contract DeployAttempts is Script {
    function run() external returns (WildsentiaAttempts) {
        address owner = vm.envAddress("CHALLENGES_OWNER");
        address recorder = vm.envAddress("CHALLENGES_EVALUATOR");
        vm.startBroadcast();
        WildsentiaAttempts deployed = deploy(owner, recorder);
        vm.stopBroadcast();
        return deployed;
    }

    function deploy(address owner, address recorder) public returns (WildsentiaAttempts) {
        require(owner != recorder, "owner and recorder must differ");
        return new WildsentiaAttempts(owner, recorder);
    }
}
