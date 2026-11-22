import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import postgres from 'postgres'

export type Sql = postgres.Sql

export function connect(databaseUrl: string): Sql {
  return postgres(databaseUrl, {
    max: 10,
    onnotice: () => {},
    // bigint columns (block numbers) come back as JS bigint
    types: { bigint: postgres.BigInt },
  })
}

const MIGRATIONS_DIR = join(import.meta.dirname, '..', 'migrations')

/** Applies migrations/*.sql in name order, each in its own transaction. */
export async function migrate(sql: Sql, dir: string = MIGRATIONS_DIR): Promise<string[]> {
  await sql`create table if not exists schema_migrations (
    name text primary key,
    applied_at timestamptz not null default now()
  )`
  const files = (await readdir(dir)).filter((file) => file.endsWith('.sql')).sort()
  const applied: string[] = []
  for (const file of files) {
    const body = await readFile(join(dir, file), 'utf8')
    await sql.begin(async (tx) => {
      // Serialises concurrent migrators (e.g. two pods starting at once).
      await tx`select pg_advisory_xact_lock(727274001)`
      const [done] = await tx`select 1 from schema_migrations where name = ${file}`
      if (done) return
      await tx.unsafe(body)
      await tx`insert into schema_migrations (name) values (${file})`
      applied.push(file)
    })
  }
  return applied
}
