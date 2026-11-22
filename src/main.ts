import { setTimeout as sleep } from 'node:timers/promises'
import { pino } from 'pino'
import { buildServer } from './api/server.ts'
import { loadConfig } from './config.ts'
import type { Context } from './context.ts'
import { connect, migrate } from './db.ts'
import { dispatchTick } from './dispatcher.ts'
import { sweepTick } from './sweeper.ts'
import { AddressBook, watcherTick } from './watcher.ts'

const ROLES = ['api', 'watcher', 'dispatcher', 'sweeper', 'migrate', 'all'] as const
type Role = (typeof ROLES)[number]

/** Runs `fn` forever, `intervalMs` apart; a failed pass is logged and retried. */
async function loop(ctx: Context, name: string, intervalMs: number, signal: AbortSignal, fn: () => Promise<unknown>) {
  while (!signal.aborted) {
    try {
      await fn()
    } catch (err) {
      ctx.log.error({ err, loop: name }, 'pass failed')
    }
    await sleep(intervalMs, undefined, { signal }).catch(() => {})
  }
}

async function main() {
  const role = (process.argv[2] ?? 'api') as Role
  if (!ROLES.includes(role)) {
    console.error(`Usage: main <${ROLES.join('|')}>`)
    process.exit(2)
  }

  const config = loadConfig()
  const log = pino({ level: process.env.LOG_LEVEL ?? 'info', base: { role } })
  const sql = connect(config.databaseUrl)
  const ctx: Context = { config, sql, log }

  if (role === 'migrate' || role === 'all') {
    const applied = await migrate(sql)
    log.info({ applied }, 'migrations up to date')
    if (role === 'migrate') return sql.end()
  }

  const shutdown = new AbortController()
  const tasks: Promise<unknown>[] = []
  const runs = (r: Role) => role === r || role === 'all'

  const server = runs('api') ? buildServer(ctx) : undefined
  if (server) await server.listen({ host: '0.0.0.0', port: config.port })

  if (runs('watcher')) {
    for (const chain of config.chains) {
      const book = new AddressBook()
      tasks.push(loop(ctx, `watcher:${chain.key}`, chain.pollMs, shutdown.signal, () => watcherTick(ctx, chain, book)))
    }
  }
  if (runs('dispatcher')) {
    tasks.push(
      loop(ctx, 'dispatcher', 1000, shutdown.signal, async () => {
        // Drain the queue before sleeping again.
        while ((await dispatchTick(ctx)) > 0 && !shutdown.signal.aborted);
      }),
    )
  }
  if (runs('sweeper')) {
    for (const chain of config.chains) {
      tasks.push(loop(ctx, `sweeper:${chain.key}`, config.sweepIntervalMs, shutdown.signal, () => sweepTick(ctx, chain)))
    }
  }

  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.once(signal, () => {
      log.info({ signal }, 'shutting down')
      shutdown.abort()
    })
  }
  await new Promise<void>((resolve) => shutdown.signal.addEventListener('abort', () => resolve()))
  await server?.close()
  await Promise.all(tasks)
  await sql.end({ timeout: 5 })
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
