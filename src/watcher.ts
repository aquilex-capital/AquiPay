import { randomUUID } from 'node:crypto'
import { formatUnits, type Address, type Hex } from 'viem'
import type { ChainConfig } from './config.ts'
import { publicClient, type Context } from './context.ts'
import { erc20Abi } from './forwarder.ts'

interface WatchedRow {
  id: string
  address: Address
  /** How long ago the invoice was created, by the database's clock. */
  age_ms: number
  /** Whether the address has been read on this chain before. */
  seen: boolean
  checked_through: bigint | null
  /** The balance at checked_through; null when a reorg asked for a fresh search. */
  balance: string | null
}

/** USDT balances of `addresses` at `blockNumber` (the tip if omitted): one eth_call per MULTICALL_BATCH addresses. */
export async function balancesAt(
  ctx: Context,
  chain: ChainConfig,
  addresses: readonly Address[],
  blockNumber?: bigint,
): Promise<bigint[]> {
  const client = publicClient(chain)
  const balances: bigint[] = []
  for (let i = 0; i < addresses.length; i += ctx.config.multicallBatch) {
    const results = await client.multicall({
      contracts: addresses.slice(i, i + ctx.config.multicallBatch).map((address) => ({
        address: chain.usdt,
        abi: erc20Abi,
        functionName: 'balanceOf' as const,
        args: [address] as const,
      })),
      blockNumber,
      allowFailure: false,
      multicallAddress: chain.multicall3,
      // viem splits calls by calldata size unless told not to; the batch is ours.
      batchSize: 0,
    })
    balances.push(...(results as bigint[]))
  }
  return balances
}

/**
 * One pass over a chain. Reads the balance of every address being watched in
 * a single call, searches the logs only of those whose balance moved, then
 * confirms or orphans the transfers that are deep enough. An idle chain — no
 * live checkout, nothing confirming — costs no RPC call at all.
 *
 * Watched are: addresses that are live, each address once more after it
 * expires, addresses a reorg asked to search again and, with `late`, every
 * address inside the late-payment window. Safe to run repeatedly and after
 * any downtime.
 */
export async function watcherTick(ctx: Context, chain: ChainConfig, { late = false } = {}): Promise<void> {
  const { sql, config } = ctx
  const watched = await sql<WatchedRow[]>`
    select i.id, i.address, (extract(epoch from now() - i.created_at) * 1000)::float8 as age_ms,
           w.invoice_id is not null as seen, w.checked_through, w.balance::text as balance
    from invoices i
    left join watch_state w on w.invoice_id = i.id and w.chain = ${chain.key}
    where i.expires_at > now()
       or w.invoice_id is null
       or w.checked_at < i.expires_at
       or w.balance is null
       ${late ? sql`or w.checked_at < i.expires_at + make_interval(secs => ${config.lateWindowSeconds})` : sql``}
    order by i.created_at`
  const [{ confirming }] = (await sql`
    select exists (select 1 from transfers where chain = ${chain.key} and status = 'pending') as confirming`) as [
    { confirming: boolean },
  ]
  if (watched.length === 0 && !confirming) return

  // viem caches the block number for a few seconds by default; always read the real tip.
  const latest = await publicClient(chain).getBlockNumber({ cacheTime: 0 })
  if (watched.length > 0) await detect(ctx, chain, watched, latest)
  await settlePending(ctx, chain, latest)
}

async function detect(ctx: Context, chain: ChainConfig, watched: WatchedRow[], latest: bigint): Promise<void> {
  const balances = await balancesAt(ctx, chain, watched.map((row) => row.address), latest)
  const unchanged: { row: WatchedRow; balance: bigint }[] = []
  const moved: { row: WatchedRow; balance: bigint }[] = []
  watched.forEach((row, i) => {
    const balance = balances[i]!
    const known = row.seen ? (row.balance === null ? undefined : BigInt(row.balance)) : 0n
    ;(known === balance ? unchanged : moved).push({ row, balance })
  })
  await saveState(ctx, chain, unchanged, latest)
  for (const entry of moved) {
    try {
      await locate(ctx, chain, entry.row, entry.balance, latest)
      await saveState(ctx, chain, [entry], latest)
    } catch (err) {
      // Left as it was, so the next pass searches the same blocks again.
      ctx.log.error({ err, chain: chain.key, invoiceId: entry.row.id }, 'balance change not accounted for yet')
    }
  }
}

async function saveState(
  ctx: Context,
  chain: ChainConfig,
  entries: { row: WatchedRow; balance: bigint }[],
  latest: bigint,
): Promise<void> {
  if (entries.length === 0) return
  const rows = entries.map(({ row, balance }) => ({
    invoice_id: row.id,
    chain: chain.key,
    checked_through: latest.toString(),
    balance: balance.toString(),
  }))
  await ctx.sql`
    insert into watch_state ${ctx.sql(rows)}
    on conflict (invoice_id, chain) do update
      set checked_through = excluded.checked_through, balance = excluded.balance, checked_at = now()`
}

/**
 * Finds the transfers that took an address from what was last seen to
 * `balance` at `latest`, and records them as pending.
 *
 * It halves the block range on past balances until a piece is no longer than
 * LOG_RANGE, then reads that piece's logs; a piece whose ends hold the same
 * balance received nothing, because nothing leaves an address while it is
 * watched (the sweeper waits until it is not). An hour of Arbitrum is
 * therefore a dozen calls rather than fourteen hundred. Without past
 * balances, it reads the logs of the whole range.
 */
async function locate(ctx: Context, chain: ChainConfig, row: WatchedRow, balance: bigint, latest: bigint): Promise<void> {
  const client = publicClient(chain)
  const usdt = { address: chain.usdt, abi: erc20Abi, functionName: 'balanceOf' as const, args: [row.address] as const }
  const balanceAt = async (blockNumber: bigint): Promise<bigint | undefined> => {
    if (!chain.historicalReads) return undefined
    try {
      return await client.readContract({ ...usdt, blockNumber })
    } catch (err) {
      ctx.log.warn({ err, chain: chain.key, blockNumber: blockNumber.toString() }, 'past balance refused; reading logs instead')
      return undefined
    }
  }

  let from: bigint
  let fromBalance: bigint | undefined
  if (row.seen) {
    // Back by the confirmation depth, so a reorg under the last check is searched again.
    const through = row.checked_through!
    from = through > chain.confirmations ? through - chain.confirmations : 0n
    fromBalance = await balanceAt(from)
  } else {
    // Nobody can pay an address before its invoice exists, so it held nothing
    // that many blocks ago: the invoice's age in blocks, plus the confirmation depth.
    const blocks = chain.minBlockMs > 0 ? BigInt(Math.ceil(row.age_ms / chain.minBlockMs)) + chain.confirmations : latest
    from = latest > blocks ? latest - blocks : 0n
    fromBalance = 0n
  }

  let received = 0n
  const scan = async (first: bigint, last: bigint) => {
    for (let start = first; start <= last; start += chain.logRange) {
      const end = start + chain.logRange - 1n < last ? start + chain.logRange - 1n : last
      const logs = await client.getLogs({
        address: chain.usdt,
        event: erc20Abi[1],
        args: { to: row.address },
        fromBlock: start,
        toBlock: end,
        strict: true,
      })
      for (const log of logs) {
        received += log.args.value
        await record(ctx, chain, row.id, log)
      }
    }
  }
  // Transfers in blocks (lo, hi], which took the balance from loBalance to hiBalance.
  const search = async (lo: bigint, hi: bigint, loBalance: bigint | undefined, hiBalance: bigint): Promise<void> => {
    if (loBalance === hiBalance) return
    if (loBalance === undefined || hi - lo <= chain.logRange) return scan(lo + 1n, hi)
    const mid = lo + (hi - lo) / 2n
    const midBalance = await balanceAt(mid)
    if (midBalance === undefined) return scan(lo + 1n, hi)
    await search(lo, mid, loBalance, midBalance)
    await search(mid, hi, midBalance, hiBalance)
  }
  await search(from, latest, fromBalance, balance)

  // A node that answered the balance but not yet the logs would otherwise
  // leave a payment unrecorded and the balance marked as seen.
  // Without a past balance, what was last seen is the baseline; a reorg's
  // search again from a forgotten balance has none.
  const baseline = fromBalance ?? (row.balance === null ? undefined : BigInt(row.balance))
  const expected = baseline === undefined ? 0n : balance - baseline
  if (received < expected) {
    throw new Error(`found ${received} of the ${expected} that arrived at ${row.address}`)
  }
}

type TransferLog = {
  transactionHash: Hex
  logIndex: number
  blockNumber: bigint
  blockHash: Hex
  args: { from: Address; to: Address; value: bigint }
}

async function record(ctx: Context, chain: ChainConfig, invoiceId: string, log: TransferLog): Promise<void> {
  if (log.args.value === 0n) return
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

interface PendingRow {
  id: string
  invoice_id: string
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
    select id, invoice_id, block_number, block_hash, amount_raw from transfers
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
      // The block was reorged out. The address is searched again from just
      // before it, so a transaction that lands again is found again.
      await ctx.sql`update transfers set status = 'orphaned' where id = ${row.id} and status = 'pending'`
      await ctx.sql`
        update watch_state set balance = null, checked_through = least(checked_through, ${(row.block_number - 1n).toString()}::bigint)
        where invoice_id = ${row.invoice_id} and chain = ${chain.key}`
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
