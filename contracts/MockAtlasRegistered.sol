// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title MockAtlasRegistered — test double for the AgentAtlas registry
///         check used by PrizeVault.
/// @notice setRegistered() flips the flag that isRegistered() reports;
///         unlisted addresses default to false, like an AgentAtlas lookup
///         for an address that never registered.
contract MockAtlasRegistered {
    mapping(address => bool) private _registered;

    function setRegistered(address account, bool value) external {
        _registered[account] = value;
    }

    function isRegistered(address account) external view returns (bool) {
        return _registered[account];
    }
}
