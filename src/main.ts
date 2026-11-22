// Process entrypoint: wiring only. Everything testable lives in app.ts.
import { pino } from 'pino'
import { isRole, ROLES, run } from './app.ts'
import { loadConfig } from './config.ts'
import { connect } from './db.ts'

async function main() {
  const role = process.argv[2] ?? 'api'
  if (!isRole(role)) {
    console.error(`Usage: main <${ROLES.join('|')}>`)
    process.exit(2)
  }

  const config = loadConfig()
  const log = pino({ level: process.env.LOG_LEVEL ?? 'info', base: { role } })
  const sql = connect(config.databaseUrl)

  const shutdown = new AbortController()
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.once(signal, () => {
      log.info({ signal }, 'shutting down')
      shutdown.abort()
    })
  }
  try {
    await run(role, { config, sql, log }, shutdown.signal)
  } finally {
    await sql.end({ timeout: 5 })
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
