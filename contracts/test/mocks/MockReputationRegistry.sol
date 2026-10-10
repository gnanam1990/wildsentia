// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";

/// @notice LOCAL TEST STAND-IN for the ERC-8004 ReputationRegistry on Arc (0x8004B663…8713), with its
/// giveFeedback signature and its rule that an agent's owner cannot give feedback on it. Tests only.
contract MockReputationRegistry {
    IERC721 public immutable identity;

    event NewFeedback(
        uint256 indexed agentId,
        address indexed clientAddress,
        int128 value,
        uint8 valueDecimals,
        string tag1,
        string tag2,
        string endpoint,
        string feedbackURI,
        bytes32 feedbackHash
    );

    error SelfFeedback();

    constructor(IERC721 identity_) {
        identity = identity_;
    }

    function getIdentityRegistry() external view returns (address) {
        return address(identity);
    }

    function giveFeedback(
        uint256 agentId,
        int128 value,
        uint8 valueDecimals,
        string calldata tag1,
        string calldata tag2,
        string calldata endpoint,
        string calldata feedbackURI,
        bytes32 feedbackHash
    ) external {
        if (identity.ownerOf(agentId) == msg.sender) revert SelfFeedback();
        emit NewFeedback(agentId, msg.sender, value, valueDecimals, tag1, tag2, endpoint, feedbackURI, feedbackHash);
    }
}
