// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

interface IForwarderFactory {
    function destination() external view returns (address);
}

/// @notice Deposit address for one invoice. Deployed as an EIP-1167 clone.
/// The only thing it can do is send what it holds to the factory's destination,
/// so anyone may call it.
contract Forwarder {
    using SafeERC20 for IERC20;

    IForwarderFactory public immutable factory;

    error NativeTransferFailed();

    constructor(IForwarderFactory factory_) {
        factory = factory_;
    }

    function flush(IERC20 token) external {
        uint256 balance = token.balanceOf(address(this));
        if (balance == 0) return;
        token.safeTransfer(factory.destination(), balance);
    }

    /// @notice Recovers native currency sent to the address before deployment.
    function flushNative() external {
        uint256 balance = address(this).balance;
        if (balance == 0) return;
        (bool ok,) = factory.destination().call{value: balance}("");
        if (!ok) revert NativeTransferFailed();
    }
}
