// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";

/// @notice LOCAL TEST STAND-IN for the ERC-8004 IdentityRegistry on Arc (0x8004A818…BD9e): an agent is an
/// ERC-721 token minted to whoever registers it. Only the functions the server uses; tests only.
contract MockIdentityRegistry is ERC721("Agent", "AGENT") {
    uint256 public nextId = 1;
    mapping(uint256 => string) internal uris;

    function register(string calldata agentURI) external returns (uint256 agentId) {
        agentId = nextId++;
        _mint(msg.sender, agentId);
        uris[agentId] = agentURI;
    }

    function tokenURI(uint256 agentId) public view override returns (string memory) {
        _requireOwned(agentId);
        return uris[agentId];
    }
}
