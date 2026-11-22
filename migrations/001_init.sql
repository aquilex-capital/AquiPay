create table invoices (
  id          uuid primary key default gen_random_uuid(),
  reference   text not null,
  metadata    jsonb not null default '{}',
  salt        text not null unique,
  address     text not null unique,
  created_at  timestamptz not null default now()
);
create index invoices_reference_idx on invoices (reference);
create index invoices_created_at_idx on invoices (created_at);

-- One row per USDT Transfer log into an invoice address.
create table transfers (
  id            bigserial primary key,
  invoice_id    uuid not null references invoices (id),
  chain         text not null,
  tx_hash       text not null,
  log_index     integer not null,
  block_number  bigint not null,
  block_hash    text not null,
  from_address  text not null,
  amount_raw    numeric(78, 0) not null,
  amount        numeric(60, 18) not null,
  status        text not null check (status in ('pending', 'confirmed', 'orphaned')),
  -- true when the confirmed amount met the chain minimum and counted as a top-up
  credited      boolean not null default false,
  detected_at   timestamptz not null default now(),
  confirmed_at  timestamptz,
  swept_tx_hash text,
  swept_at      timestamptz,
  -- set when a flush reverted (e.g. frozen address); excluded from sweeps until cleared
  sweep_error   text,
  unique (chain, tx_hash, log_index)
);
create index transfers_invoice_idx on transfers (invoice_id);
create index transfers_pending_idx on transfers (chain, block_number) where status = 'pending';
create index transfers_unswept_idx on transfers (chain) where status = 'confirmed' and swept_at is null and sweep_error is null;

create table chain_cursors (
  chain         text primary key,
  block_number  bigint not null,
  updated_at    timestamptz not null default now()
);

-- Outbox: rows are written in the same transaction that confirms a transfer.
create table webhook_deliveries (
  id               uuid primary key default gen_random_uuid(),
  event_type       text not null,
  payload          jsonb not null,
  attempts         integer not null default 0,
  next_attempt_at  timestamptz not null default now(),
  delivered_at     timestamptz,
  last_error       text,
  created_at       timestamptz not null default now()
);
create index webhook_deliveries_due_idx on webhook_deliveries (next_attempt_at) where delivered_at is null;
