import { createWalletClient, parseEventLogs, type Address, type Hex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import type { ChainConfig } from './config.ts'
import { publicClient, rpcTransport, type Context } from './context.ts'
import { factoryAbi } from './forwarder.ts'
import { watchHorizonSeconds } from './watcher.ts'
import { readAddresses } from './chain.ts'

interface Candidate {
  id: string
  salt: Hex
  address: Address
}

/**
 * Moves confirmed USDT from invoice addresses to the factory's destination
 * wallet, one batch per call. The signing key only pays gas: the contract
 * decides where funds go. Returns the sweep transaction hash, if one was sent.
 */
export async function sweepTick(ctx: Context, chain: ChainConfig): Promise<Hex | undefined> {
  const { config, sql, log } = ctx
  if (!config.sweeperPrivateKey) throw new Error('SWEEPER_PRIVATE_KEY is required')
  const client = publicClient(chain)

  // Only addresses the watcher is done with: it has looked after the late
  // window closed, or the address is past the horizon it reads at all, and no
  // reorg is waiting on a search again. It finds payments by a balance going
  // up, so emptying an address it still reads could hide one.
  const candidates = await sql<Candidate[]>`
    select distinct i.id, i.salt, i.address
    from transfers t
    join invoices i on i.id = t.invoice_id
    left join watch_state w on w.invoice_id = i.id and w.chain = t.chain
    where t.chain = ${chain.key} and t.status = 'confirmed' and t.swept_at is null and t.sweep_error is null
      and (w.invoice_id is null or w.balance is not null)
      and (w.checked_at >= i.expires_at + make_interval(secs => ${config.lateWindowSeconds})
           or i.expires_at <= now() - make_interval(secs => ${watchHorizonSeconds(config)}))
    limit ${config.sweepBatchSize}`
  if (candidates.length === 0) return

  if (chain.maxGasPriceWei !== undefined) {
    const gasPrice = await client.getGasPrice()
    if (gasPrice > chain.maxGasPriceWei) {
      log.info({ chain: chain.key, gasPrice: gasPrice.toString() }, 'gas price above cap, sweep postponed')
      return
    }
  }

  const balances = (await readAddresses(ctx, chain, candidates.map((c) => c.address))).map((r) => r.balance)
  const funded = candidates.filter((_, i) => balances[i]! > 0n)
  // Anyone may flush a deployed forwarder, so an empty one has already been swept.
  const alreadyEmpty = candidates.filter((_, i) => balances[i] === 0n)
  if (alreadyEmpty.length > 0) {
    await sql`update transfers set swept_at = now()
              where chain = ${chain.key} and status = 'confirmed' and swept_at is null
                and invoice_id in ${sql(alreadyEmpty.map((c) => c.id))}`
  }
  if (funded.length === 0) return

  const account = privateKeyToAccount(config.sweeperPrivateKey)
  const wallet = createWalletClient({ account, chain: chain.viemChain, transport: rpcTransport(chain) })
  const sweep = {
    address: config.factory,
    abi: factoryAbi,
    functionName: 'sweep',
    args: [chain.usdt, funded.map((c) => c.salt)],
  } as const
  // The factory catches a flush that fails, so the least gas the sweep
  // succeeds with, which is what a node estimates, can be one where a flush
  // ran out of gas: the sweep is mined and moves nothing. That estimate still
  // covers everything around the flushes, so each one's gas goes on top.
  // What is not used is not paid for.
  const estimate = await client.estimateContractGas({ ...sweep, account })
  const gas = estimate + BigInt(funded.length) * config.sweepFlushGas
  const hash = await wallet.writeContract({ ...sweep, gas })
  const receipt = await client.waitForTransactionReceipt({ hash })
  if (receipt.status !== 'success') throw new Error(`sweep transaction ${hash} reverted`)

  const failed = new Set(
    parseEventLogs({ abi: factoryAbi, eventName: 'FlushFailed', logs: receipt.logs }).map((event) =>
      event.args.forwarder.toLowerCase(),
    ),
  )
  const stuck = funded.filter((c) => failed.has(c.address.toLowerCase()))
  const swept = funded.filter((c) => !failed.has(c.address.toLowerCase()))

  // Only transfers mined before the sweep were moved by it; later ones wait for the next pass.
  if (swept.length > 0) {
    await sql`update transfers set swept_at = now(), swept_tx_hash = ${hash}
              where chain = ${chain.key} and status = 'confirmed' and swept_at is null
                and block_number <= ${receipt.blockNumber.toString()}
                and invoice_id in ${sql(swept.map((c) => c.id))}`
  }
  if (stuck.length > 0) {
    // Typically the token issuer froze the address. Parked until someone clears sweep_error.
    await sql`update transfers set sweep_error = ${`flush failed in ${hash}`}
              where chain = ${chain.key} and status = 'confirmed' and swept_at is null
                and invoice_id in ${sql(stuck.map((c) => c.id))}`
    log.error({ chain: chain.key, tx: hash, invoices: stuck.map((c) => c.id) }, 'forwarder flush failed')
  }
  log.info({ chain: chain.key, tx: hash, swept: swept.length, failed: stuck.length }, 'sweep complete')
  return hash
}
