-- Track injury episodes instead of overwriting one row per player.

alter table public.injuries
  drop constraint if exists injuries_player_id_key;

alter table public.injuries
  add column if not exists first_seen_at timestamptz not null default now(),
  add column if not exists last_seen_at timestamptz not null default now(),
  add column if not exists resolved_at timestamptz;

alter table public.injuries
  add constraint injuries_episode_key
    unique nulls not distinct (player_id, team_id, injury_date, status, description);

create index if not exists injuries_player_history_idx
  on public.injuries (player_id, first_seen_at desc);

create index if not exists injuries_active_idx
  on public.injuries (team_id, injury_date desc)
  where resolved_at is null;

comment on table public.injuries is
  'Current and historical injury episodes observed from team-scoped API-Sports injury responses';

comment on column public.injuries.first_seen_at is
  'First time this exact injury episode was observed';

comment on column public.injuries.last_seen_at is
  'Most recent complete refresh where this exact injury episode was observed';

comment on column public.injuries.resolved_at is
  'First complete refresh where this injury episode was no longer returned';
