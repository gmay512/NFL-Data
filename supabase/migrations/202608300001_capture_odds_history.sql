-- Preserve the complete provider market catalog and timestamped odds snapshots.

alter table public.bet_types
  drop constraint if exists bet_types_name_key;

alter table public.odds
  alter column odd type numeric using odd::numeric,
  add column if not exists provider_updated_at timestamptz not null default now(),
  add column if not exists captured_at timestamptz not null default now();

delete from public.odds newer
using public.odds older
where newer.id > older.id
  and newer.game_id = older.game_id
  and newer.bookmaker_id = older.bookmaker_id
  and newer.bet_id = older.bet_id
  and newer.bet_value = older.bet_value
  and newer.provider_updated_at = older.provider_updated_at;

alter table public.odds
  add constraint odds_snapshot_key
    unique (game_id, bookmaker_id, bet_id, bet_value, provider_updated_at);

create index if not exists idx_odds_game_provider_updated
  on public.odds (game_id, provider_updated_at desc);

create index if not exists idx_odds_game_bet_provider_updated
  on public.odds (game_id, bet_id, provider_updated_at desc);

comment on table public.odds is
  'Timestamped pre-match odds snapshots by game, bookmaker, bet type, and outcome';

comment on column public.odds.provider_updated_at is
  'Timestamp reported by API-Sports for this odds snapshot';

comment on column public.odds.captured_at is
  'Timestamp when this application first persisted the snapshot';
