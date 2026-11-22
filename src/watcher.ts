import { randomUUID } from 'node:crypto'
import { formatUnits, type Address } from 'viem'
import type { ChainConfig } from './config.ts'
import { publicClient, type Context } from './context.ts'
import { erc20Abi } from './forwarder.ts'

// Providers cap how many values one topic filter may hold.
const ADDRESS_CHUNK = 200

/** Lowercased invoice address -> invoice id, refreshed incrementally. */
export class AddressBook {
  private readonly byAddress = new Map<string, string>()
  private newest: Date = new Date(0)

  async refresh(ctx: Context): Promise<void> {
    // Re-read a small overlap so rows committed out of order are not missed.
    const since = new Date(this.newest.getTime() - 5 * 60_000)
    const rows = await ctx.sql<{ id: string; address: string; created_at: Date }[]>`
      select id, address, created_at from invoices where created_at > ${since}`
    for (const row of rows) {
      this.byAddress.set(row.address, row.id)
      if (row.created_at > this.newest) this.newest = row.created_at
    }
  }

  invoiceId(address: string): string | undefined {
    return this.byAddress.get(address.toLowerCase())
  }

  addresses(): Address[] {
    return [...this.byAddress.keys()] as Address[]
  }
}

/**
 * One pass over a chain: record new transfers into invoice addresses as
 * pending, then confirm or orphan the ones that are deep enough.
 * Safe to run repeatedly and after any downtime.
 */
export async function watcherTick(ctx: Context, chain: ChainConfig, book: AddressBook): Promise<void> {
  const client = publicClient(chain)
  await book.refresh(ctx)
  // viem caches the block number for a few seconds by default; always read the real tip.
  const latest = await client.getBlockNumber({ cacheTime: 0 })

  const [cursorRow] = await ctx.sql<{ block_number: bigint }[]>`
    select block_number from chain_cursors where chain = ${chain.key}`
  const cursor = cursorRow?.block_number ?? latest

  // Rescan the unconfirmed tail every pass so reorged-in transfers are seen.
  let from = cursor > chain.confirmations ? cursor - chain.confirmations : 0n
  const addresses = book.addresses()
  while (from <= latest && addresses.length > 0) {
    const to = from + chain.logRange - 1n < latest ? from + chain.logRange - 1n : latest
    for (let i = 0; i < addresses.length; i += ADDRESS_CHUNK) {
      const logs = await client.getLogs({
        address: chain.usdt,
        event: erc20Abi[1],
        args: { to: addresses.slice(i, i + ADDRESS_CHUNK) },
        fromBlock: from,
        toBlock: to,
        strict: true,
      })
      for (const log of logs) {
        const invoiceId = book.invoiceId(log.args.to)
        if (!invoiceId || log.args.value === 0n) continue
        const [inserted] = await ctx.sql`
          insert into transfers
            (invoice_id, chain, tx_hash, log_index, block_number, block_hash, from_address, amount_raw, amount, status)
          values
            (${invoiceId}, ${chain.key}, ${log.transactionHash}, ${log.logIndex}, ${log.blockNumber.toString()},
             ${log.blockHash}, ${log.args.from.toLowerCase()}, ${log.args.value.toString()},
             ${formatUnits(log.args.value, chain.decimals)}, 'pending')
          on conflict (chain, tx_hash, log_index) do update
            set block_number = excluded.block_number, block_hash = excluded.block_hash, status = 'pending'
            where transfers.status = 'orphaned'
               or (transfers.status = 'pending' and transfers.block_hash <> excluded.block_hash)
          returning id`
        if (inserted) {
          ctx.log.info({ chain: chain.key, tx: log.transactionHash, invoiceId }, 'transfer detected')
        }
      }
    }
    from = to + 1n
  }

  await settlePending(ctx, chain, latest)

  await ctx.sql`
    insert into chain_cursors (chain, block_number) values (${chain.key}, ${latest.toString()})
    on conflict (chain) do update set block_number = excluded.block_number, updated_at = now()`
}

interface PendingRow {
  id: string
  block_number: bigint
  block_hash: string
  amount_raw: string
}

async function settlePending(ctx: Context, chain: ChainConfig, latest: bigint): Promise<void> {
  const client = publicClient(chain)
  // A transfer in block N has `latest - N + 1` confirmations.
  const deepEnough = latest + 1n - chain.confirmations
  if (deepEnough < 0n) return
  const pending = await ctx.sql<PendingRow[]>`
    select id, block_number, block_hash, amount_raw from transfers
    where chain = ${chain.key} and status = 'pending' and block_number <= ${deepEnough.toString()}
    order by block_number`

  const canonicalHash = new Map<bigint, string>()
  for (const row of pending) {
    let hash = canonicalHash.get(row.block_number)
    if (!hash) {
      hash = (await client.getBlock({ blockNumber: row.block_number })).hash
      canonicalHash.set(row.block_number, hash)
    }
    if (hash.toLowerCase() !== row.block_hash.toLowerCase()) {
      // The block was reorged out. If the transaction lands again, the rescan re-adds it.
      await ctx.sql`update transfers set status = 'orphaned' where id = ${row.id} and status = 'pending'`
      ctx.log.warn({ chain: chain.key, transferId: row.id }, 'transfer orphaned by reorg')
      continue
    }
    await confirmTransfer(ctx, chain, row)
  }
}

interface UncreditedRow {
  id: string
  tx_hash: string
  log_index: number
  from_address: string
  amount_raw: string
  amount: string
}

/**
 * Confirms one transfer, then credits the invoice's uncredited transfers on
 * this chain together if they now add up to the minimum. Small payments
 * therefore accumulate instead of being lost.
 */
export async function confirmTransfer(ctx: Context, chain: ChainConfig, row: Pick<PendingRow, 'id'>): Promise<void> {
  await ctx.sql.begin(async (tx) => {
    // The status guard makes confirmation, and so the webhook, happen exactly once.
    const [transfer] = await tx`
      update transfers set status = 'confirmed', confirmed_at = now()
      where id = ${row.id} and status = 'pending'
      returning invoice_id, tx_hash`
    if (!transfer) return
    ctx.log.info({ chain: chain.key, tx: transfer.tx_hash }, 'transfer confirmed')

    // Locking the invoice serialises crediting across concurrent confirmations.
    const [invoice] = await tx`select reference, metadata from invoices where id = ${transfer.invoice_id} for update`
    const uncredited = await tx<UncreditedRow[]>`
      select id, tx_hash, log_index, from_address, amount_raw::text as amount_raw, amount::text as amount
      from transfers
      where invoice_id = ${transfer.invoice_id} and chain = ${chain.key} and status = 'confirmed' and not credited
      order by id`
    const total = uncredited.reduce((sum, t) => sum + BigInt(t.amount_raw), 0n)
    if (total < chain.minTopupRaw) return

    const eventId = randomUUID()
    await tx`update transfers set credited = true, credit_event_id = ${eventId}
             where id in ${tx(uncredited.map((t) => t.id))}`
    const payload = {
      id: eventId,
      type: 'topup.confirmed',
      created_at: new Date().toISOString(),
      data: {
        invoice_id: transfer.invoice_id,
        reference: invoice!.reference,
        metadata: invoice!.metadata,
        chain: chain.key,
        chain_id: chain.viemChain.id,
        currency: 'USDT',
        // The sum of `transfers`; more than one when small payments accumulated.
        amount: formatUnits(total, chain.decimals),
        transfers: uncredited.map((t) => ({
          tx_hash: t.tx_hash,
          log_index: t.log_index,
          from: t.from_address,
          amount: trimAmount(t.amount),
        })),
      },
    }
    await tx`insert into webhook_deliveries (id, event_type, payload)
             values (${eventId}, ${payload.type}, ${tx.json(payload)})`
    ctx.log.info({ chain: chain.key, eventId, amount: payload.data.amount, transfers: uncredited.length }, 'top-up credited')
  })
}

/** "25.500000000000000000" -> "25.5" */
export function trimAmount(amount: string): string {
  return amount.includes('.') ? amount.replace(/0+$/, '').replace(/\.$/, '') : amount
}
