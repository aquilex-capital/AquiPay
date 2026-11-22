import { createWalletClient, parseEventLogs, type Address, type Hex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import type { ChainConfig } from './config.ts'
import { publicClient, rpcTransport, type Context } from './context.ts'
import { erc20Abi, factoryAbi } from './forwarder.ts'

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

  const candidates = await sql<Candidate[]>`
    select distinct i.id, i.salt, i.address
    from transfers t join invoices i on i.id = t.invoice_id
    where t.chain = ${chain.key} and t.status = 'confirmed' and t.swept_at is null and t.sweep_error is null
    limit ${config.sweepBatchSize}`
  if (candidates.length === 0) return

  if (chain.maxGasPriceWei !== undefined) {
    const gasPrice = await client.getGasPrice()
    if (gasPrice > chain.maxGasPriceWei) {
      log.info({ chain: chain.key, gasPrice: gasPrice.toString() }, 'gas price above cap, sweep postponed')
      return
    }
  }

  const balanceOf = (address: Address) =>
    client.readContract({ address: chain.usdt, abi: erc20Abi, functionName: 'balanceOf', args: [address] })

  const balances = await Promise.all(candidates.map((c) => balanceOf(c.address)))
  const funded = candidates.filter((_, i) => balances[i]! > 0n)
  // Anyone may flush a deployed forwarder, so an empty one has already been swept.
  const alreadyEmpty = candidates.filter((_, i) => balances[i] === 0n)
  if (alreadyEmpty.length > 0) {
    await sql`update transfers set swept_at = now()
              where chain = ${chain.key} and status = 'confirmed' and swept_at is null
                and invoice_id in ${sql(alreadyEmpty.map((c) => c.id))}`
  }
  if (funded.length === 0) return

  const wallet = createWalletClient({
    account: privateKeyToAccount(config.sweeperPrivateKey),
    chain: chain.viemChain,
    transport: rpcTransport(chain),
  })
  const hash = await wallet.writeContract({
    address: config.factory,
    abi: factoryAbi,
    functionName: 'sweep',
    args: [chain.usdt, funded.map((c) => c.salt)],
  })
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
