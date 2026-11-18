// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title MockUSDT — minimal ERC20 test double for PrizeVault tests.
/// @notice 18 decimals (like BSC USDT), public mint, plain transfers.
///         Only what PrizeVault touches: balanceOf + transfer, plus mint
///         so tests can fund wallets and the vault.
contract MockUSDT {
    string public constant name = "Mock USDT";
    string public constant symbol = "USDT";
    uint8 public constant decimals = 18;

    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;

    event Transfer(address indexed from, address indexed to, uint256 amount);
    event Mint(address indexed to, uint256 amount);

    function mint(address to, uint256 amount) external {
        totalSupply += amount;
        balanceOf[to] += amount;
        emit Mint(to, amount);
        emit Transfer(address(0), to, amount);
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        uint256 bal = balanceOf[msg.sender];
        require(bal >= amount, "MockUSDT: insufficient balance");
        balanceOf[msg.sender] = bal - amount;
        balanceOf[to] += amount;
        emit Transfer(msg.sender, to, amount);
        return true;
    }
}
