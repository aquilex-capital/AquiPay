// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";
import {Forwarder, IForwarderFactory} from "./Forwarder.sol";

/// @notice Deploys per-invoice forwarders at predictable addresses and sweeps
/// them to a single destination wallet. Sweeping is permissionless: the caller
/// only pays gas and cannot redirect funds.
contract ForwarderFactory is IForwarderFactory {
    address public immutable implementation;

    address public destination;
    address public pendingDestination;

    event DestinationProposed(address indexed current, address indexed proposed);
    event DestinationChanged(address indexed previous, address indexed current);
    event ForwarderDeployed(address indexed forwarder, bytes32 indexed salt);
    event FlushFailed(address indexed forwarder, bytes32 indexed salt);

    error ZeroAddress();
    error NotDestination();
    error NotPendingDestination();

    constructor(address destination_) {
        if (destination_ == address(0)) revert ZeroAddress();
        destination = destination_;
        implementation = address(new Forwarder(this));
        emit DestinationChanged(address(0), destination_);
    }

    /// @notice Only the current destination wallet can propose a new one, and
    /// the new wallet must accept, so a typo cannot redirect funds.
    function proposeDestination(address proposed) external {
        if (msg.sender != destination) revert NotDestination();
        pendingDestination = proposed;
        emit DestinationProposed(destination, proposed);
    }

    function acceptDestination() external {
        if (msg.sender != pendingDestination) revert NotPendingDestination();
        emit DestinationChanged(destination, msg.sender);
        destination = msg.sender;
        pendingDestination = address(0);
    }

    function forwarderAddress(bytes32 salt) public view returns (address) {
        return Clones.predictDeterministicAddress(implementation, salt);
    }

    /// @notice Deploys any missing forwarders and flushes `token` from each.
    /// A forwarder whose flush reverts (e.g. a frozen address) is skipped so it
    /// cannot block the rest of the batch.
    function sweep(IERC20 token, bytes32[] calldata salts) external {
        for (uint256 i = 0; i < salts.length; ++i) {
            bytes32 salt = salts[i];
            address forwarder = forwarderAddress(salt);
            if (forwarder.code.length == 0) {
                Clones.cloneDeterministic(implementation, salt);
                emit ForwarderDeployed(forwarder, salt);
            }
            try Forwarder(forwarder).flush(token) {}
            catch {
                emit FlushFailed(forwarder, salt);
            }
        }
    }
}
