-- Persist weekly model suggestions independently from mutable game records.

create table public.betting_analysis_runs (
  id uuid primary key default gen_random_uuid(),
  season integer not null,
  stage text,
  week text not null,
  model_name text not null,
  context_snapshot jsonb not null,
  summary text not null,
  created_at timestamptz not null default now(),
  constraint betting_analysis_runs_season_check check (season between 1900 and 2100),
  constraint betting_analysis_runs_week_check check (length(btrim(week)) between 1 and 100),
  constraint betting_analysis_runs_model_check check (length(btrim(model_name)) between 1 and 200),
  constraint betting_analysis_runs_context_check check (jsonb_typeof(context_snapshot) = 'object'),
  constraint betting_analysis_runs_summary_check check (length(btrim(summary)) > 0)
);

create index betting_analysis_runs_created_at_idx
  on public.betting_analysis_runs (created_at desc);
create index betting_analysis_runs_season_week_idx
  on public.betting_analysis_runs (season, week, created_at desc);

create function public.prevent_betting_analysis_run_updates()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'Betting analysis runs are immutable.';
end;
$$;

create trigger prevent_betting_analysis_run_updates
before update on public.betting_analysis_runs
for each row execute function public.prevent_betting_analysis_run_updates();

create table public.betting_suggestions (
  id bigint generated always as identity primary key,
  run_id uuid not null references public.betting_analysis_runs(id) on delete cascade,
  game_id integer not null,
  season integer not null,
  stage text,
  week text not null,
  kickoff_at timestamptz not null,
  away_team_id integer not null,
  away_team_name text not null,
  home_team_id integer not null,
  home_team_name text not null,
  market text not null,
  selection text not null,
  locked_line numeric not null,
  confidence smallint not null,
  rationale text not null,
  supporting_game_ids integer[] not null default '{}',
  result text not null default 'ungraded',
  result_delta numeric,
  final_away_score integer,
  final_home_score integer,
  graded_at timestamptz,
  created_at timestamptz not null default now(),
  constraint betting_suggestions_game_check check (game_id > 0),
  constraint betting_suggestions_season_check check (season between 1900 and 2100),
  constraint betting_suggestions_week_check check (length(btrim(week)) between 1 and 100),
  constraint betting_suggestions_team_ids_check
    check (away_team_id > 0 and home_team_id > 0 and away_team_id <> home_team_id),
  constraint betting_suggestions_team_names_check
    check (length(btrim(away_team_name)) > 0 and length(btrim(home_team_name)) > 0),
  constraint betting_suggestions_market_check check (market in ('spread', 'total')),
  constraint betting_suggestions_selection_check check (
    (market = 'spread' and selection in ('away', 'home'))
    or (market = 'total' and selection in ('over', 'under'))
  ),
  constraint betting_suggestions_line_check check (locked_line between -200 and 200),
  constraint betting_suggestions_confidence_check check (confidence between 1 and 100),
  constraint betting_suggestions_rationale_check check (length(btrim(rationale)) between 1 and 240),
  constraint betting_suggestions_result_check check (result in ('win', 'loss', 'push', 'ungraded')),
  constraint betting_suggestions_scores_check check (
    (result = 'ungraded' and result_delta is null and final_away_score is null
      and final_home_score is null and graded_at is null)
    or
    (result <> 'ungraded' and result_delta is not null and final_away_score is not null
      and final_home_score is not null and graded_at is not null)
  ),
  unique (run_id, game_id, market)
);

create index betting_suggestions_run_id_idx
  on public.betting_suggestions (run_id, id);
create index betting_suggestions_pending_idx
  on public.betting_suggestions (game_id) where result = 'ungraded';

create function public.enforce_betting_suggestion_input_immutable()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.id is distinct from old.id
    or new.run_id is distinct from old.run_id
    or new.game_id is distinct from old.game_id
    or new.season is distinct from old.season
    or new.stage is distinct from old.stage
    or new.week is distinct from old.week
    or new.kickoff_at is distinct from old.kickoff_at
    or new.away_team_id is distinct from old.away_team_id
    or new.away_team_name is distinct from old.away_team_name
    or new.home_team_id is distinct from old.home_team_id
    or new.home_team_name is distinct from old.home_team_name
    or new.market is distinct from old.market
    or new.selection is distinct from old.selection
    or new.locked_line is distinct from old.locked_line
    or new.confidence is distinct from old.confidence
    or new.rationale is distinct from old.rationale
    or new.supporting_game_ids is distinct from old.supporting_game_ids
    or new.created_at is distinct from old.created_at
  then
    raise exception 'Betting suggestion inputs are immutable.';
  end if;
  return new;
end;
$$;

create trigger enforce_betting_suggestion_input_immutable
before update on public.betting_suggestions
for each row execute function public.enforce_betting_suggestion_input_immutable();

create function public.save_weekly_betting_analysis(
  requested_season integer,
  requested_stage text,
  requested_week text,
  requested_model text,
  requested_context jsonb,
  requested_summary text,
  requested_suggestions jsonb
)
returns uuid
language plpgsql
set search_path = ''
as $$
declare
  created_run_id uuid;
begin
  if jsonb_typeof(requested_suggestions) <> 'array' then
    raise exception 'Suggestions must be a JSON array.';
  end if;

  insert into public.betting_analysis_runs (
    season, stage, week, model_name, context_snapshot, summary
  ) values (
    requested_season, requested_stage, requested_week, requested_model,
    requested_context, requested_summary
  )
  returning id into created_run_id;

  insert into public.betting_suggestions (
    run_id, game_id, season, stage, week, kickoff_at,
    away_team_id, away_team_name, home_team_id, home_team_name,
    market, selection, locked_line, confidence, rationale, supporting_game_ids
  )
  select
    created_run_id,
    suggestion.game_id,
    requested_season,
    requested_stage,
    requested_week,
    suggestion.kickoff_at,
    suggestion.away_team_id,
    suggestion.away_team_name,
    suggestion.home_team_id,
    suggestion.home_team_name,
    suggestion.market,
    suggestion.selection,
    suggestion.locked_line,
    suggestion.confidence,
    suggestion.rationale,
    coalesce(suggestion.supporting_game_ids, '{}')
  from jsonb_to_recordset(requested_suggestions) as suggestion(
    game_id integer,
    kickoff_at timestamptz,
    away_team_id integer,
    away_team_name text,
    home_team_id integer,
    home_team_name text,
    market text,
    selection text,
    locked_line numeric,
    confidence smallint,
    rationale text,
    supporting_game_ids integer[]
  );

  return created_run_id;
end;
$$;

alter table public.betting_analysis_runs enable row level security;
alter table public.betting_suggestions enable row level security;

revoke all on public.betting_analysis_runs, public.betting_suggestions from anon, authenticated;
grant all on public.betting_analysis_runs, public.betting_suggestions to service_role;
grant usage, select on sequence public.betting_suggestions_id_seq to service_role;

create policy betting_analysis_runs_all_service_role
  on public.betting_analysis_runs for all to service_role using (true) with check (true);
create policy betting_suggestions_all_service_role
  on public.betting_suggestions for all to service_role using (true) with check (true);

revoke all on function public.enforce_betting_suggestion_input_immutable() from public, anon, authenticated;
grant execute on function public.enforce_betting_suggestion_input_immutable() to service_role;
revoke all on function public.prevent_betting_analysis_run_updates() from public, anon, authenticated;
grant execute on function public.prevent_betting_analysis_run_updates() to service_role;
revoke all on function public.save_weekly_betting_analysis(integer, text, text, text, jsonb, text, jsonb)
  from public, anon, authenticated;
grant execute on function public.save_weekly_betting_analysis(integer, text, text, text, jsonb, text, jsonb)
  to service_role;

comment on table public.betting_analysis_runs is
  'Immutable upcoming-week analytics context and local-model summary';
comment on table public.betting_suggestions is
  'Model-suggested ATS and total picks graded against their recommendation-time consensus line';
