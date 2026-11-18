// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title MockAgentIdRegistry — test double for the SPACE ID Agent ID registry.
/// @notice Mapping-based: enrol() gives a test wallet a handle, after which
///         balanceOf() returns 1 and handleOf() returns that handle.
contract MockAgentIdRegistry {
    mapping(address => string) private _handleByAddress;
    mapping(address => bool) private _enrolled;
    mapping(bytes32 => address) private _ownerByHandleHash;

    function enrol(address account, string calldata handle) external {
        _enrolled[account] = true;
        _handleByAddress[account] = handle;
        if (bytes(handle).length > 0) {
            _ownerByHandleHash[keccak256(bytes(handle))] = account;
        }
    }

    function balanceOf(address account) external view returns (uint256) {
        return _enrolled[account] ? 1 : 0;
    }

    function handleOf(address account) external view returns (string memory) {
        return _handleByAddress[account];
    }

    function ownerOfHandle(string calldata handle) external view returns (address) {
        return _ownerByHandleHash[keccak256(bytes(handle))];
    }
}
