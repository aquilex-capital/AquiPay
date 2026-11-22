// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @notice The `aggregate3` entry point of Multicall3
/// (0xcA11bde05977b3631167028862bE2a173976CA11 on every real chain), which is
/// all the watcher uses. Anvil has no Multicall3, so tests and local
/// development deploy this one and point MULTICALL3_ADDRESS_LOCAL at it.
contract Multicall3 {
    struct Call3 {
        address target;
        bool allowFailure;
        bytes callData;
    }

    struct Result {
        bool success;
        bytes returnData;
    }

    function aggregate3(Call3[] calldata calls) external payable returns (Result[] memory returnData) {
        returnData = new Result[](calls.length);
        for (uint256 i = 0; i < calls.length; ++i) {
            (bool success, bytes memory data) = calls[i].target.call(calls[i].callData);
            require(success || calls[i].allowFailure, "Multicall3: call failed");
            returnData[i] = Result(success, data);
        }
    }
}
