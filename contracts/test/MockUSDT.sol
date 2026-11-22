// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @notice Mimics mainnet USDT: `transfer` returns nothing, and addresses can
/// be frozen. Test and local development only.
contract MockUSDT {
    string public constant name = "Tether USD";
    string public constant symbol = "USDT";
    uint8 public immutable decimals;

    mapping(address => uint256) public balanceOf;
    mapping(address => bool) public frozen;

    event Transfer(address indexed from, address indexed to, uint256 value);

    constructor(uint8 decimals_) {
        decimals = decimals_;
    }

    function mint(address to, uint256 value) external {
        balanceOf[to] += value;
        emit Transfer(address(0), to, value);
    }

    function setFrozen(address account, bool value) external {
        frozen[account] = value;
    }

    function transfer(address to, uint256 value) external {
        require(!frozen[msg.sender], "frozen");
        balanceOf[msg.sender] -= value;
        balanceOf[to] += value;
        emit Transfer(msg.sender, to, value);
    }
}
