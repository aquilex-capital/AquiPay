import type { Address } from 'viem'
import type { ChainConfig } from './config.ts'
import { publicClient, type Context } from './context.ts'
import { erc20Abi, forwarderAbi } from './forwarder.ts'

/** USDT's balanceOf for one address, as readContract and multicall both take it. */
export function balanceOfCall(chain: ChainConfig, address: Address) {
  return { address: chain.usdt, abi: erc20Abi, functionName: 'balanceOf', args: [address] } as const
}

/** What one poll learns about an address. */
export interface Reading {
  balance: bigint
  /**
   * Whether its forwarder exists. Until it does, nothing can leave the
   * address, so its balance only ever goes up; once it does, anyone can
   * flush it (ForwarderFactory.sweep is open to all), and an unchanged
   * balance no longer means nothing arrived.
   */
  deployed: boolean
}

/**
 * Balance and forwarder of each address at `blockNumber` (the tip if
 * omitted): one eth_call per MULTICALL_BATCH addresses, however many there are.
 */
export async function readAddresses(
  ctx: Context,
  chain: ChainConfig,
  addresses: readonly Address[],
  blockNumber?: bigint,
): Promise<Reading[]> {
  const readings: Reading[] = []
  for (let i = 0; i < addresses.length; i += ctx.config.multicallBatch) {
    const batch = addresses.slice(i, i + ctx.config.multicallBatch)
    const results = await publicClient(chain).multicall({
      contracts: batch.flatMap((address) => [
        balanceOfCall(chain, address),
        // An address with no code answers nothing, which fails to decode.
        { address, abi: forwarderAbi, functionName: 'factory' } as const,
      ]),
      blockNumber,
      allowFailure: true,
      multicallAddress: chain.multicall3,
      // viem splits calls by calldata size unless told not to; the batch is ours.
      batchSize: 0,
    })
    batch.forEach((_, j) => {
      const balance = results[2 * j]!
      const factory = results[2 * j + 1]!
      if (balance.status !== 'success') throw balance.error
      readings.push({
        balance: balance.result as bigint,
        deployed: factory.status === 'success' && (factory.result as string).toLowerCase() === ctx.config.factory.toLowerCase(),
      })
    })
  }
  return readings
}
