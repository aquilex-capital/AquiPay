// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Forwarder} from "../src/Forwarder.sol";
import {ForwarderFactory} from "../src/ForwarderFactory.sol";
import {MockUSDT} from "./MockUSDT.sol";

contract ForwarderFactoryTest is Test {
    address constant DEST = address(0xD357);
    address constant PAYER = address(0xBEEF);
    address constant STRANGER = address(0xBAD);

    ForwarderFactory factory;
    MockUSDT usdt;

    function setUp() public {
        factory = new ForwarderFactory(DEST);
        usdt = new MockUSDT(6);
        usdt.mint(PAYER, 1_000e6);
    }

    function _salts(uint256 n) internal pure returns (bytes32[] memory salts) {
        salts = new bytes32[](n);
        for (uint256 i = 0; i < n; ++i) {
            salts[i] = keccak256(abi.encode("invoice", i));
        }
    }

    function _pay(bytes32 salt, uint256 amount) internal returns (address forwarder) {
        forwarder = factory.forwarderAddress(salt);
        vm.prank(PAYER);
        usdt.transfer(forwarder, amount);
    }

    function test_constructorRejectsZeroDestination() public {
        vm.expectRevert(ForwarderFactory.ZeroAddress.selector);
        new ForwarderFactory(address(0));
    }

    function test_sweepDeploysAndFlushesBatch() public {
        bytes32[] memory salts = _salts(3);
        _pay(salts[0], 10e6);
        _pay(salts[1], 25e6);
        address third = _pay(salts[2], 40e6);
        assertEq(third.code.length, 0);

        vm.prank(STRANGER);
        factory.sweep(IERC20(address(usdt)), salts);

        assertEq(usdt.balanceOf(DEST), 75e6);
        assertEq(usdt.balanceOf(third), 0);
        assertGt(third.code.length, 0);
    }

    function test_sweepIsRepeatableForLaterPayments() public {
        bytes32[] memory salts = _salts(1);
        _pay(salts[0], 10e6);
        factory.sweep(IERC20(address(usdt)), salts);
        _pay(salts[0], 15e6);
        factory.sweep(IERC20(address(usdt)), salts);
        factory.sweep(IERC20(address(usdt)), salts);
        assertEq(usdt.balanceOf(DEST), 25e6);
    }

    function test_frozenForwarderDoesNotBlockBatch() public {
        bytes32[] memory salts = _salts(2);
        address frozen = _pay(salts[0], 10e6);
        _pay(salts[1], 20e6);
        usdt.setFrozen(frozen, true);

        factory.sweep(IERC20(address(usdt)), salts);

        assertEq(usdt.balanceOf(DEST), 20e6);
        assertEq(usdt.balanceOf(frozen), 10e6);
    }

    function test_anyoneCanFlushButOnlyToDestination() public {
        bytes32[] memory salts = _salts(1);
        address forwarder = _pay(salts[0], 10e6);
        factory.sweep(IERC20(address(usdt)), salts);
        _pay(salts[0], 5e6);

        vm.prank(STRANGER);
        Forwarder(forwarder).flush(IERC20(address(usdt)));

        assertEq(usdt.balanceOf(DEST), 15e6);
        assertEq(usdt.balanceOf(STRANGER), 0);
    }

    function test_flushNativeRecoversPreDeploymentEther() public {
        bytes32[] memory salts = _salts(1);
        address forwarder = factory.forwarderAddress(salts[0]);
        vm.deal(forwarder, 1 ether);
        factory.sweep(IERC20(address(usdt)), salts);

        Forwarder(forwarder).flushNative();

        assertEq(DEST.balance, 1 ether);
    }

    function test_flushWithNothingToSendIsANoOp() public {
        bytes32[] memory salts = _salts(1);
        address forwarder = factory.forwarderAddress(salts[0]);
        factory.sweep(IERC20(address(usdt)), salts);

        Forwarder(forwarder).flush(IERC20(address(usdt)));
        Forwarder(forwarder).flushNative();

        assertEq(usdt.balanceOf(DEST), 0);
        assertEq(DEST.balance, 0);
    }

    function test_flushNativeRevertsWhenDestinationRejectsEther() public {
        // A destination with no receive function, such as a token contract.
        ForwarderFactory rejecting = new ForwarderFactory(address(usdt));
        bytes32[] memory salts = _salts(1);
        address forwarder = rejecting.forwarderAddress(salts[0]);
        vm.deal(forwarder, 1 ether);
        rejecting.sweep(IERC20(address(usdt)), salts);

        vm.expectRevert(Forwarder.NativeTransferFailed.selector);
        Forwarder(forwarder).flushNative();
        assertEq(forwarder.balance, 1 ether);
    }

    function test_sweepEmitsDeploymentOnceAndFlushFailures() public {
        bytes32[] memory salts = _salts(1);
        address forwarder = _pay(salts[0], 10e6);

        vm.expectEmit(true, true, false, false, address(factory));
        emit ForwarderFactory.ForwarderDeployed(forwarder, salts[0]);
        factory.sweep(IERC20(address(usdt)), salts);

        _pay(salts[0], 10e6);
        usdt.setFrozen(forwarder, true);
        vm.expectEmit(true, true, false, false, address(factory));
        emit ForwarderFactory.FlushFailed(forwarder, salts[0]);
        factory.sweep(IERC20(address(usdt)), salts);
    }

    function test_sweepOfEmptyBatchDoesNothing() public {
        factory.sweep(IERC20(address(usdt)), new bytes32[](0));
        assertEq(usdt.balanceOf(DEST), 0);
    }

    function test_addressesDependOnFactoryAndSaltOnly() public {
        bytes32[] memory salts = _salts(2);
        address first = factory.forwarderAddress(salts[0]);
        assertTrue(first != factory.forwarderAddress(salts[1]));

        // The same factory address gives the same invoice address on any chain.
        vm.chainId(42161);
        assertEq(factory.forwarderAddress(salts[0]), first);

        ForwarderFactory other = new ForwarderFactory(DEST);
        assertTrue(other.forwarderAddress(salts[0]) != first);
    }

    function test_proposalCanBeReplacedAndIsClearedOnAccept() public {
        address wrong = address(0xBAD1);
        address right = address(0xD359);

        vm.expectEmit(true, true, false, false, address(factory));
        emit ForwarderFactory.DestinationProposed(DEST, wrong);
        vm.prank(DEST);
        factory.proposeDestination(wrong);
        vm.prank(DEST);
        factory.proposeDestination(right);
        assertEq(factory.pendingDestination(), right);

        vm.prank(wrong);
        vm.expectRevert(ForwarderFactory.NotPendingDestination.selector);
        factory.acceptDestination();

        vm.expectEmit(true, true, false, false, address(factory));
        emit ForwarderFactory.DestinationChanged(DEST, right);
        vm.prank(right);
        factory.acceptDestination();
        assertEq(factory.pendingDestination(), address(0));

        // The old wallet has no power left.
        vm.prank(DEST);
        vm.expectRevert(ForwarderFactory.NotDestination.selector);
        factory.proposeDestination(DEST);
    }

    function test_destinationChangeNeedsBothWallets() public {
        address next = address(0xD358);

        vm.prank(STRANGER);
        vm.expectRevert(ForwarderFactory.NotDestination.selector);
        factory.proposeDestination(STRANGER);

        vm.prank(DEST);
        factory.proposeDestination(next);
        assertEq(factory.destination(), DEST);

        vm.prank(STRANGER);
        vm.expectRevert(ForwarderFactory.NotPendingDestination.selector);
        factory.acceptDestination();

        vm.prank(next);
        factory.acceptDestination();
        assertEq(factory.destination(), next);

        // Addresses are unaffected; funds now go to the new wallet.
        bytes32[] memory salts = _salts(1);
        _pay(salts[0], 10e6);
        factory.sweep(IERC20(address(usdt)), salts);
        assertEq(usdt.balanceOf(next), 10e6);
    }

    function testFuzz_forwarderAddressMatchesDeployment(bytes32 salt) public {
        address predicted = factory.forwarderAddress(salt);
        bytes32[] memory salts = new bytes32[](1);
        salts[0] = salt;
        factory.sweep(IERC20(address(usdt)), salts);
        assertGt(predicted.code.length, 0);
        assertEq(address(Forwarder(predicted).factory()), address(factory));
    }
}
