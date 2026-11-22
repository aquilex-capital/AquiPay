import { concatHex, getContractAddress, keccak256, parseAbi, toHex, type Address, type Hex } from 'viem'

export const factoryAbi = parseAbi([
  'function implementation() view returns (address)',
  'function destination() view returns (address)',
  'function forwarderAddress(bytes32 salt) view returns (address)',
  'function sweep(address token, bytes32[] salts)',
  'event ForwarderDeployed(address indexed forwarder, bytes32 indexed salt)',
  'event FlushFailed(address indexed forwarder, bytes32 indexed salt)',
])

export const erc20Abi = parseAbi([
  'function balanceOf(address account) view returns (uint256)',
  'event Transfer(address indexed from, address indexed to, uint256 value)',
])

/** The factory creates the forwarder implementation in its constructor, i.e. with nonce 1. */
export function implementationAddress(factory: Address): Address {
  return getContractAddress({ from: factory, nonce: 1n })
}

export function invoiceSalt(invoiceId: string): Hex {
  return keccak256(toHex(`aquipay:invoice:${invoiceId}`))
}

/**
 * Mirrors OpenZeppelin `Clones.predictDeterministicAddress`: the CREATE2
 * address of an EIP-1167 minimal proxy deployed by the factory.
 */
export function forwarderAddress(factory: Address, implementation: Address, salt: Hex): Address {
  const bytecode = concatHex([
    '0x3d602d80600a3d3981f3363d3d373d3d3d363d73',
    implementation,
    '0x5af43d82803e903d91602b57fd5bf3',
  ])
  return getContractAddress({ opcode: 'CREATE2', from: factory, salt, bytecode })
}
