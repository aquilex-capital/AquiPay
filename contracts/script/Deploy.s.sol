// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {ForwarderFactory} from "../src/ForwarderFactory.sol";

/// @notice Deploys the factory through the canonical CREATE2 deployer, so the
/// same DESTINATION gives the same factory address on every chain. The
/// broadcasting key gets no privileges; any funded key will do.
contract Deploy is Script {
    bytes32 constant SALT = keccak256("aquipay.forwarder-factory.v1");

    function run() external {
        address destination = vm.envAddress("DESTINATION");
        vm.startBroadcast();
        ForwarderFactory factory = new ForwarderFactory{salt: SALT}(destination);
        vm.stopBroadcast();
        console.log("factory:", address(factory));
        console.log("implementation:", factory.implementation());
        console.log("destination:", factory.destination());
    }
}
