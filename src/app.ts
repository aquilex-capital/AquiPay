import { setTimeout as sleep } from 'node:timers/promises'
import { buildServer } from './api/server.ts'
import type { Context } from './context.ts'
import { migrate } from './db.ts'
import { dispatchTick } from './dispatcher.ts'
import { sweepTick } from './sweeper.ts'
import { watcherTick } from './watcher.ts'

export const ROLES = ['api', 'watcher', 'dispatcher', 'sweeper', 'migrate', 'all'] as const
export type Role = (typeof ROLES)[number]

export function isRole(value: string): value is Role {
  return (ROLES as readonly string[]).includes(value)
}

/** Runs `fn` until aborted, `intervalMs` apart; a failed pass is logged and retried. */
export async function loop(
  ctx: Context,
  name: string,
  intervalMs: number,
  signal: AbortSignal,
  fn: () => Promise<unknown>,
): Promise<void> {
  while (!signal.aborted) {
    try {
      await fn()
    } catch (err) {
      ctx.log.error({ err, loop: name }, 'pass failed')
    }
    await sleep(intervalMs, undefined, { signal }).catch(() => {})
  }
}

/** Runs one role (or all of them) until `signal` aborts, then shuts down cleanly. */
export async function run(role: Role, ctx: Context, signal: AbortSignal): Promise<void> {
  const { config, log } = ctx
  if (role === 'migrate' || role === 'all') {
    const applied = await migrate(ctx.sql)
    log.info({ applied }, 'migrations up to date')
    if (role === 'migrate') return
  }

  const runs = (r: Role) => role === r || role === 'all'
  const tasks: Promise<void>[] = []

  const server = runs('api') ? buildServer(ctx) : undefined
  if (server) await server.listen({ host: '0.0.0.0', port: config.port })

  if (runs('watcher')) {
    for (const chain of config.chains) {
      // The late-payment pass rides on an ordinary pass, so the two never race over one address.
      let lateDue = 0
      tasks.push(
        loop(ctx, `watcher:${chain.key}`, chain.pollMs, signal, async () => {
          const late = Date.now() >= lateDue
          await watcherTick(ctx, chain, { late })
          if (late) lateDue = Date.now() + config.latePassMs
        }),
      )
    }
  }
  if (runs('dispatcher')) {
    tasks.push(
      loop(ctx, 'dispatcher', 1000, signal, async () => {
        // Drain the queue before sleeping again.
        while ((await dispatchTick(ctx)) > 0 && !signal.aborted);
      }),
    )
  }
  if (runs('sweeper')) {
    for (const chain of config.chains) {
      tasks.push(loop(ctx, `sweeper:${chain.key}`, config.sweepIntervalMs, signal, () => sweepTick(ctx, chain)))
    }
  }

  if (!signal.aborted) {
    await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }))
  }
  await server?.close()
  await Promise.all(tasks)
}
