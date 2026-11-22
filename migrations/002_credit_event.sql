-- Transfers below the minimum accumulate and are credited together; this links
-- each transfer to the topup.confirmed event that credited it.
alter table transfers add column credit_event_id uuid;
create index transfers_uncredited_idx on transfers (invoice_id, chain) where status = 'confirmed' and not credited;
