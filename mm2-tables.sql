-- MM2 values storage. Run once in the Supabase SQL editor.
-- Two rows: id = 'latest' ({ updatedAt, items }) and id = 'history' ({ itemKey: [[ms, value], ...] }).
create table if not exists mm2_state (
  id text primary key,
  data jsonb not null,
  updated_at timestamptz not null default now()
);

-- Only the service-role key (used by the server and mm2-push.mjs) can read or write it.
alter table mm2_state enable row level security;
