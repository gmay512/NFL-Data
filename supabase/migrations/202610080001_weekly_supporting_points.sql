alter table public.betting_suggestions add column supporting_points jsonb;

create function public.valid_weekly_supporting_points(points jsonb)
returns boolean
language plpgsql
immutable
set search_path = ''
as $$
declare
  point jsonb;
  evidence_id jsonb;
  seen_texts text[] := '{}';
  seen_ids text[];
  normalized_text text;
begin
  if points is null then return true; end if;
  if jsonb_typeof(points) <> 'array' then return false; end if;
  if jsonb_array_length(points) not between 1 and 4 then return false; end if;
  for point in select value from jsonb_array_elements(points) loop
    if jsonb_typeof(point) <> 'object' then return false; end if;
    if point - 'text' - 'evidenceIds' <> '{}'::jsonb
      or jsonb_typeof(point->'text') is distinct from 'string'
      or jsonb_typeof(point->'evidenceIds') is distinct from 'array'
    then return false; end if;
    if point->>'text' ~ '^\s*$' or length(point->>'text') > 240
      or point->>'text' ~ E'[\r\n]'
      or jsonb_array_length(point->'evidenceIds') not between 1 and 4
    then return false; end if;
    normalized_text := lower(regexp_replace(btrim(point->>'text'), '\s+', ' ', 'g'));
    if normalized_text = any(seen_texts) then return false; end if;
    seen_texts := array_append(seen_texts, normalized_text);
    seen_ids := '{}';
    for evidence_id in select value from jsonb_array_elements(point->'evidenceIds') loop
      if jsonb_typeof(evidence_id) <> 'string' then return false; end if;
      if length(evidence_id #>> '{}') not between 1 and 100
        or evidence_id #>> '{}' ~ '^\s*$'
        or evidence_id #>> '{}' = any(seen_ids)
      then return false; end if;
      seen_ids := array_append(seen_ids, evidence_id #>> '{}');
    end loop;
  end loop;
  return true;
end;
$$;

alter table public.betting_suggestions add constraint betting_suggestions_supporting_points_check
  check (public.valid_weekly_supporting_points(supporting_points));

create or replace function public.enforce_betting_suggestion_input_immutable()
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
    or new.supporting_points is distinct from old.supporting_points
    or new.supporting_game_ids is distinct from old.supporting_game_ids
    or new.created_at is distinct from old.created_at
  then
    raise exception 'Betting suggestion inputs are immutable.';
  end if;
  return new;
end;
$$;

create or replace function public.save_weekly_betting_analysis(
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
    market, selection, locked_line, confidence, rationale, supporting_points, supporting_game_ids
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
    suggestion.supporting_points,
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
    supporting_points jsonb,
    supporting_game_ids integer[]
  );
  return created_run_id;
end;
$$;

revoke all on function public.valid_weekly_supporting_points(jsonb) from public, anon, authenticated;
grant execute on function public.valid_weekly_supporting_points(jsonb) to service_role;
