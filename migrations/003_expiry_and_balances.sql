-- An invoice's address is live until expires_at, and looked at for late
-- payments for a while after it (LATE_PAYMENT_HOURS). Invoices made before
-- this migration get the default ten minutes, and so do those an API pod
-- still running the previous release makes during the rollout.
alter table invoices add column expires_at timestamptz;
update invoices set expires_at = created_at + interval '10 minutes';
alter table invoices alter column expires_at set not null;
alter table invoices alter column expires_at set default now() + interval '10 minutes';
create index invoices_expires_at_idx on invoices (expires_at);

-- What the watcher last saw at each invoice address, per chain: the USDT
-- balance at block checked_through. Payments are found by that balance
-- changing, so an address that has not changed costs no log queries.
-- A null balance asks for the address to be searched again from
-- checked_through, which is what a reorg that orphaned a transfer does.
create table watch_state (
  invoice_id       uuid not null references invoices (id),
  chain            text not null,
  checked_through  bigint not null,
  balance          numeric(78, 0),
  checked_at       timestamptz not null default now(),
  primary key (invoice_id, chain)
);
create index watch_state_search_again_idx on watch_state (chain) where balance is null;

-- The watcher no longer scans every block, so it keeps no cursor.
drop table chain_cursors;
