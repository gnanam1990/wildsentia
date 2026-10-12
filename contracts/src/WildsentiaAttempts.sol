// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";

/// @title Wildsentia Attempts
/// @notice A public, append-only record of challenge attempts: when each started, who played it,
/// and how it ended with the hash of its log. Only the recorder (the Wildsentia server) writes;
/// each attempt can be started once and ended once. It holds no funds.
contract WildsentiaAttempts is Ownable2Step {
    enum Outcome {
        None,
        Met,
        Failed,
        Void
    }

    address public recorder;
    /// @notice 0 = unknown, 1 = started, 2 = ended.
    mapping(bytes32 attemptId => uint8) public stage;

    event AttemptStarted(bytes32 indexed attemptId, uint256 indexed challengeId, address indexed player);
    event AttemptEnded(bytes32 indexed attemptId, uint256 indexed challengeId, Outcome outcome, bytes32 logHash);
    event RecorderChanged(address indexed previous, address indexed next);

    error NotRecorder();
    error ZeroAddress();
    error AlreadyStarted();
    error AlreadyEnded();
    error BadOutcome();
    error RenounceDisabled();

    constructor(address owner_, address recorder_) Ownable(owner_) {
        if (recorder_ == address(0)) revert ZeroAddress();
        recorder = recorder_;
        emit RecorderChanged(address(0), recorder_);
    }

    modifier onlyRecorder() {
        if (msg.sender != recorder) revert NotRecorder();
        _;
    }

    function recordStart(bytes32 attemptId, uint256 challengeId, address player) external onlyRecorder {
        if (stage[attemptId] != 0) revert AlreadyStarted();
        stage[attemptId] = 1;
        emit AttemptStarted(attemptId, challengeId, player);
    }

    /// @notice Ends an attempt. An attempt whose start was never recorded can still be ended.
    function recordEnd(bytes32 attemptId, uint256 challengeId, Outcome outcome, bytes32 logHash) external onlyRecorder {
        if (stage[attemptId] == 2) revert AlreadyEnded();
        if (outcome == Outcome.None) revert BadOutcome();
        stage[attemptId] = 2;
        emit AttemptEnded(attemptId, challengeId, outcome, logHash);
    }

    function setRecorder(address next) external onlyOwner {
        if (next == address(0)) revert ZeroAddress();
        emit RecorderChanged(recorder, next);
        recorder = next;
    }

    function renounceOwnership() public view override onlyOwner {
        revert RenounceDisabled();
    }
}
