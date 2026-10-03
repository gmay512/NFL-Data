\set ON_ERROR_STOP on
begin;
set local lock_timeout = '15s';
set local statement_timeout = '5min';
select set_config('nfl.keep_from', :'keep_from', true);

do $$
begin
  if current_setting('nfl.keep_from')::integer not between 1900 and 2100 then
    raise exception 'Retained season must be between 1900 and 2100.';
  end if;
  if to_regclass('public.ingest_resource_status') is null
    or to_regclass('public.betting_suggestion_loss_analyses') is null then
    raise exception 'NFL schema is incomplete; apply repository migrations first.';
  end if;
end;
$$;

\if :apply
lock table public.games, public.odds, public.game_events,
  public.game_team_stats, public.game_player_stats, public.player_season_stats,
  public.standings, public.team_rosters, public.league_seasons, public.ingest_resource_status,
  public.injuries, public.analysis_sessions, public.analysis_messages,
  public.betting_analysis_runs, public.betting_suggestions,
  public.betting_suggestion_loss_analyses, public.teams, public.players,
  public.leagues, public.bookmakers, public.bet_types in share row exclusive mode;
\endif

create temporary table prune_old_games on commit drop as
select id from public.games where season < current_setting('nfl.keep_from')::integer;
create unique index on prune_old_games(id);

create or replace function pg_temp.has_old_grounding(snapshot jsonb)
returns boolean language sql stable as $$
  select exists (
    select 1 from jsonb_path_query(snapshot, '$.**.season') value
    where case when value #>> '{}' ~ '^[0-9]{4}$'
      then (value #>> '{}')::integer < current_setting('nfl.keep_from')::integer
      else false end
  ) or exists (
    select 1 from (
      select value from jsonb_path_query(snapshot, '$.**.gameId') value
      union all select value from jsonb_path_query(snapshot, '$.**.game_id') value
      union all select value from jsonb_path_query(snapshot, '$.**.supportingGameIds[*]') value
      union all select value from jsonb_path_query(snapshot, '$.**.supporting_game_ids[*]') value
    ) ids
    join prune_old_games old on old.id::text = ids.value #>> '{}'
  );
$$;

create temporary table prune_old_sessions on commit drop as
select id from public.analysis_sessions
where pg_temp.has_old_grounding(filter_snapshot) or pg_temp.has_old_grounding(context_snapshot);

create temporary table prune_old_runs on commit drop as
select run.id from public.betting_analysis_runs run
where run.season < current_setting('nfl.keep_from')::integer
  or pg_temp.has_old_grounding(run.context_snapshot)
  or exists (
    select 1 from public.betting_suggestions suggestion
    where suggestion.run_id = run.id and (
      suggestion.season < current_setting('nfl.keep_from')::integer
      or suggestion.game_id in (select id from prune_old_games)
      or exists (select 1 from prune_old_games where id = any(suggestion.supporting_game_ids))
      or exists (
        select 1 from public.betting_suggestion_loss_analyses loss
        where loss.suggestion_id = suggestion.id and pg_temp.has_old_grounding(loss.evidence_snapshot)
      )
    )
  );

create temporary table prune_old_suggestions on commit drop as
select id from public.betting_suggestions where run_id in (select id from prune_old_runs);

select count(*) as undated_resolved_injuries_requiring_review
from public.injuries where resolved_at is not null and injury_date is null;

create temporary table prune_plan (
  ordinal integer generated always as identity,
  table_name text not null,
  predicate text not null,
  delete_count bigint,
  retained_count bigint,
  retained_fingerprint text
) on commit drop;

insert into prune_plan(table_name, predicate) values
  ('betting_suggestion_loss_analyses', 'suggestion_id in (select id from prune_old_suggestions)'),
  ('betting_suggestions', 'id in (select id from prune_old_suggestions)'),
  ('betting_analysis_runs', 'id in (select id from prune_old_runs)'),
  ('analysis_messages', 'session_id in (select id from prune_old_sessions)'),
  ('analysis_sessions', 'id in (select id from prune_old_sessions)'),
  ('odds', 'game_id in (select id from prune_old_games)'),
  ('game_events', 'game_id in (select id from prune_old_games)'),
  ('game_team_stats', 'game_id in (select id from prune_old_games)'),
  ('game_player_stats', 'game_id in (select id from prune_old_games)'),
  ('games', 'id in (select id from prune_old_games)'),
  ('player_season_stats', 'season < current_setting(''nfl.keep_from'')::integer'),
  ('standings', 'season < current_setting(''nfl.keep_from'')::integer'),
  ('team_rosters', 'season < current_setting(''nfl.keep_from'')::integer'),
  ('league_seasons', 'season_year < current_setting(''nfl.keep_from'')::integer'),
  ('ingest_resource_status', 'season < current_setting(''nfl.keep_from'')::integer'),
  ('injuries', 'resolved_at is not null and injury_date < make_date(current_setting(''nfl.keep_from'')::integer, 3, 1)'),
  ('leagues', 'false'), ('teams', 'false'), ('players', 'false'),
  ('bookmakers', 'false'), ('bet_types', 'false');

do $$
declare
  entry record;
  removed bigint;
  retained bigint;
  fingerprint text;
begin
  for entry in select * from prune_plan order by ordinal loop
    execute format('select count(*) from public.%I where %s', entry.table_name, entry.predicate) into removed;
    execute format(
      'select count(*), md5(coalesce(string_agg(row_hash, '''' order by row_hash), ''''))
       from (select md5(to_jsonb(t)::text) row_hash from public.%I t where not (%s)) retained',
      entry.table_name, entry.predicate
    ) into retained, fingerprint;
    update prune_plan set delete_count = removed, retained_count = retained, retained_fingerprint = fingerprint
    where ordinal = entry.ordinal;
  end loop;
end;
$$;

select table_name, delete_count, retained_count from prune_plan order by ordinal;

\if :apply
do $$
declare
  entry record;
  affected bigint;
  remaining bigint;
  retained bigint;
  fingerprint text;
begin
  if exists (select 1 from public.injuries where resolved_at is not null and injury_date is null) then
    raise exception 'Undated resolved injuries require review; no records were deleted.';
  end if;
  for entry in select * from prune_plan order by ordinal loop
    if entry.delete_count > 0 then
      execute format('delete from public.%I where %s', entry.table_name, entry.predicate);
      get diagnostics affected = row_count;
      if affected <> entry.delete_count then
        raise exception 'Deletion count mismatch for %', entry.table_name;
      end if;
    end if;
  end loop;
  for entry in select * from prune_plan order by ordinal loop
    execute format('select count(*) from public.%I where %s', entry.table_name, entry.predicate) into remaining;
    execute format(
      'select count(*), md5(coalesce(string_agg(row_hash, '''' order by row_hash), ''''))
       from (select md5(to_jsonb(t)::text) row_hash from public.%I t where not (%s)) retained',
      entry.table_name, entry.predicate
    ) into retained, fingerprint;
    if remaining <> 0 or retained <> entry.retained_count or fingerprint <> entry.retained_fingerprint then
      raise exception 'Historical absence or retained-data verification failed for %', entry.table_name;
    end if;
  end loop;
end;
$$;
commit;
\echo Cleanup committed; historical absence and retained-row fingerprints verified.
\else
rollback;
\echo Dry run only; no records deleted.
\endif
