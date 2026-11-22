// Deploys MockUSDT and the ForwarderFactory to the local anvil node, puts
// Multicall3 at its usual address (anvil has none), and prints the matching
// .env lines. Run `npm run contracts:build` first.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createWalletClient, http, parseUnits, publicActions, type Address } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { foundry } from 'viem/chains'

const RPC_URL = process.env.RPC_URL ?? 'http://127.0.0.1:8545'
// Well-known anvil development accounts #0 (deployer) and #1 (payer).
const deployer = privateKeyToAccount('0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80')
const PAYER: Address = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8'
const DESTINATION = (process.env.DESTINATION ?? '0x00000000000000000000000000000000000d3571') as Address

const client = createWalletClient({ account: deployer, chain: foundry, transport: http(RPC_URL) }).extend(publicActions)

function artifact(name: string) {
  const path = join(import.meta.dirname, '..', 'contracts', 'out', `${name}.sol`, `${name}.json`)
  const json = JSON.parse(readFileSync(path, 'utf8'))
  return { abi: json.abi, bytecode: json.bytecode.object, deployedBytecode: json.deployedBytecode.object }
}

async function deploy(name: string, args: unknown[]): Promise<Address> {
  const { abi, bytecode } = artifact(name)
  const hash = await client.deployContract({ abi, bytecode, args })
  return (await client.waitForTransactionReceipt({ hash })).contractAddress!
}

await client.request({
  method: 'anvil_setCode' as never,
  params: ['0xcA11bde05977b3631167028862bE2a173976CA11', artifact('Multicall3').deployedBytecode] as never,
})
const usdt = await deploy('MockUSDT', [6])
const factory = await deploy('ForwarderFactory', [DESTINATION])
const mint = await client.writeContract({
  address: usdt,
  abi: artifact('MockUSDT').abi,
  functionName: 'mint',
  args: [PAYER, parseUnits('10000', 6)],
})
await client.waitForTransactionReceipt({ hash: mint })

console.log(`FORWARDER_FACTORY_ADDRESS=${factory}`)
console.log(`USDT_ADDRESS_LOCAL=${usdt}`)
console.error(`Minted 10000 mock USDT to ${PAYER}; sweeps go to ${DESTINATION}`)
