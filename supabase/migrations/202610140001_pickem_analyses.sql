create table public.pickem_analyses (
  id uuid primary key default gen_random_uuid(),
  season integer not null check (season between 1900 and 2100),
  stage text,
  week text not null check (length(btrim(week)) between 1 and 100),
  revision integer not null default 1 check (revision > 0),
  summary text not null,
  changes jsonb not null default '[]' check (jsonb_typeof(changes) = 'array'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique nulls not distinct (season, stage, week)
);

create table public.pickem_predictions (
  analysis_id uuid not null references public.pickem_analyses(id) on delete cascade,
  game_id integer not null check (game_id > 0),
  kickoff_at timestamptz not null,
  away_team_id integer not null,
  away_team_name text not null,
  home_team_id integer not null,
  home_team_name text not null,
  winner_team_id integer not null,
  confidence smallint not null check (confidence between 1 and 100),
  supporting_points jsonb not null check (jsonb_typeof(supporting_points) = 'array' and jsonb_array_length(supporting_points) between 1 and 4),
  risks jsonb not null check (jsonb_typeof(risks) = 'array' and jsonb_array_length(risks) between 1 and 4),
  model_name text not null check (length(btrim(model_name)) between 1 and 200),
  analyzed_at timestamptz not null,
  source_refreshed_at timestamptz not null,
  data_warnings jsonb not null default '[]' check (jsonb_typeof(data_warnings) = 'array'),
  evidence_snapshot jsonb not null check (jsonb_typeof(evidence_snapshot) = 'object'),
  evidence_key jsonb not null check (jsonb_typeof(evidence_key) = 'object'),
  result text not null default 'pending' check (result in ('pending', 'win', 'loss', 'tie', 'void')),
  final_away_score integer,
  final_home_score integer,
  graded_at timestamptz,
  primary key (analysis_id, game_id),
  check (away_team_id > 0 and home_team_id > 0 and away_team_id <> home_team_id),
  check (winner_team_id in (away_team_id, home_team_id)),
  check (analyzed_at < kickoff_at),
  check (
    (result = 'pending' and graded_at is null and final_away_score is null and final_home_score is null)
    or (result = 'void' and graded_at is not null)
    or (result in ('win', 'loss', 'tie') and graded_at is not null and final_away_score >= 0 and final_home_score >= 0
      and final_away_score is not null and final_home_score is not null)
  )
);

create index pickem_predictions_pending_idx on public.pickem_predictions (kickoff_at, game_id) where result = 'pending';

create function public.pickem_comparison(p public.pickem_predictions)
returns jsonb language sql immutable set search_path = '' as $$
  select jsonb_build_object(
    'winnerTeamId', p.winner_team_id,
    'winnerTeamName', case when p.winner_team_id = p.home_team_id then p.home_team_name else p.away_team_name end,
    'confidence', p.confidence, 'supportingPoints', p.supporting_points,
    'risks', p.risks, 'evidence', p.evidence_key
  );
$$;

create function public.save_pickem_analysis(
  requested_season integer, requested_stage text, requested_week text,
  expected_revision integer, requested_predictions jsonb
)
returns uuid language plpgsql set search_path = '' as $$
declare
  saved public.pickem_analyses;
  previous public.pickem_predictions;
  proposed public.pickem_predictions;
  source_game public.games;
  item jsonb;
  before_value jsonb;
  after_value jsonb;
  before_evidence jsonb;
  after_evidence jsonb;
  latest_changes jsonb := '[]';
  submitted_ids integer[];
  eligible_ids integer[];
  removed public.pickem_predictions;
begin
  perform pg_advisory_xact_lock(hashtextextended(jsonb_build_array(requested_season, requested_stage, requested_week)::text, 0));
  select * into saved from public.pickem_analyses
    where season = requested_season and stage is not distinct from requested_stage and week = requested_week for update;
  if coalesce(saved.revision, 0) is distinct from expected_revision then
    raise exception 'Pickem changed while analysis was running. Reload the week and retry.';
  end if;
  if requested_stage is null or lower(btrim(requested_stage)) not in ('regular season', 'post season', 'postseason', 'playoffs')
    or jsonb_typeof(requested_predictions) is distinct from 'array' or jsonb_array_length(requested_predictions) = 0 then
    raise exception using errcode = '22023', message = 'A supported week and a complete nonempty prediction slate are required.';
  end if;

  select array_agg((value->>'game_id')::integer order by (value->>'game_id')::integer) into submitted_ids
    from jsonb_array_elements(requested_predictions);
  -- Lock schedule rows as well as the analysis so ingestion cannot move kickoff during the save.
  perform 1 from public.games where season = requested_season
    and stage is not distinct from requested_stage and week = requested_week for share;
  select array_agg(g.id order by g.id) into eligible_ids from public.games g
    where g.season = requested_season and g.stage is not distinct from requested_stage and g.week = requested_week
      and g.status_short = 'NS' and g.game_timestamp > extract(epoch from clock_timestamp())
      and g.away_team_id > 0 and g.home_team_id > 0 and g.away_team_id <> g.home_team_id
      and not exists (select 1 from public.pickem_predictions p where p.analysis_id = saved.id and p.game_id = g.id
        and (p.kickoff_at <= clock_timestamp() or p.result <> 'pending'));
  if submitted_ids is distinct from eligible_ids then
    raise exception 'The eligible Pickem slate changed or kickoff passed. Reload the week and retry.';
  end if;

  if saved.id is null then
    insert into public.pickem_analyses (season, stage, week, summary)
      values (requested_season, requested_stage, requested_week, 'Initial Pickem analysis.') returning * into saved;
  end if;
  for item in select value from jsonb_array_elements(requested_predictions) loop
    select * into source_game from public.games where id = (item->>'game_id')::integer;
    select * into previous from public.pickem_predictions where analysis_id = saved.id and game_id = source_game.id;
    proposed := jsonb_populate_record(null::public.pickem_predictions, item);
    if proposed.away_team_id is distinct from source_game.away_team_id
      or proposed.home_team_id is distinct from source_game.home_team_id
      or proposed.kickoff_at is distinct from to_timestamp(source_game.game_timestamp)
      or proposed.analyzed_at > clock_timestamp() then
      raise exception using errcode = '22023', message = 'Pickem prediction does not match its scheduled game.';
    end if;
    before_value := case when previous.game_id is null then null else public.pickem_comparison(previous) end;
    after_value := public.pickem_comparison(proposed);
    if expected_revision > 0 and before_value is distinct from after_value then
      if before_value is not null then
        before_evidence := before_value->'evidence';
        after_evidence := after_value->'evidence';
        before_value := jsonb_set(before_value, '{evidence}', coalesce((
          select jsonb_object_agg(key, value) from jsonb_each(before_evidence)
            where value is distinct from after_evidence->key
        ), '{}'));
        after_value := jsonb_set(after_value, '{evidence}', coalesce((
          select jsonb_object_agg(key, value) from jsonb_each(after_evidence)
            where value is distinct from before_evidence->key
        ), '{}'));
      end if;
      latest_changes := latest_changes || jsonb_build_array(jsonb_build_object(
        'gameId', source_game.id, 'kind', case when before_value is null then 'added' else 'updated' end,
        'before', before_value, 'after', after_value));
    end if;
    insert into public.pickem_predictions (
      analysis_id, game_id, kickoff_at, away_team_id, away_team_name, home_team_id, home_team_name,
      winner_team_id, confidence, supporting_points, risks, model_name, analyzed_at, source_refreshed_at, data_warnings, evidence_snapshot, evidence_key
    ) values (
      saved.id, proposed.game_id, proposed.kickoff_at, proposed.away_team_id, proposed.away_team_name,
      proposed.home_team_id, proposed.home_team_name, proposed.winner_team_id, proposed.confidence,
      proposed.supporting_points, proposed.risks, proposed.model_name, proposed.analyzed_at,
      proposed.source_refreshed_at, coalesce(proposed.data_warnings, '[]'),
      proposed.evidence_snapshot, proposed.evidence_key
    ) on conflict (analysis_id, game_id) do update set
      kickoff_at = excluded.kickoff_at, away_team_id = excluded.away_team_id, away_team_name = excluded.away_team_name,
      home_team_id = excluded.home_team_id, home_team_name = excluded.home_team_name,
      winner_team_id = excluded.winner_team_id, confidence = excluded.confidence,
      supporting_points = excluded.supporting_points, risks = excluded.risks,
      model_name = excluded.model_name, analyzed_at = excluded.analyzed_at,
      source_refreshed_at = excluded.source_refreshed_at, data_warnings = excluded.data_warnings,
      evidence_snapshot = excluded.evidence_snapshot, evidence_key = excluded.evidence_key;
  end loop;

  for removed in select p.* from public.pickem_predictions p
    left join public.games g on g.id = p.game_id
    where p.analysis_id = saved.id and p.kickoff_at > clock_timestamp()
      and (g.id is null or g.status_short in ('CANC', 'PST')
        or g.season is distinct from requested_season or g.stage is distinct from requested_stage or g.week is distinct from requested_week)
      and (g.id is null or g.status_short in ('NS', 'CANC', 'PST'))
  loop
    latest_changes := latest_changes || jsonb_build_array(jsonb_build_object(
      'gameId', removed.game_id, 'kind', 'removed',
      'before', public.pickem_comparison(removed), 'after', null));
    delete from public.pickem_predictions where analysis_id = saved.id and game_id = removed.game_id;
  end loop;
  if exists (select 1 from public.games where id = any(submitted_ids)
    and game_timestamp <= extract(epoch from clock_timestamp())) then
    raise exception 'Kickoff passed during the save. Reload the week and retry.';
  end if;
  update public.pickem_analyses set
    revision = expected_revision + 1, updated_at = clock_timestamp(), changes = latest_changes,
    summary = case when expected_revision = 0 then 'Initial outright predictions saved.'
      when jsonb_array_length(latest_changes) = 0 then 'No prediction changes.'
      else jsonb_array_length(latest_changes)::text || ' game predictions changed versus the previous analysis.' end
    where id = saved.id;
  return saved.id;
end;
$$;

create function public.grade_pickem_analysis(requested_id uuid)
returns integer language plpgsql set search_path = '' as $$
declare affected integer;
begin
  perform 1 from public.pickem_analyses where id = requested_id for update;
  update public.pickem_predictions p set
    result = case when g.status_short = 'CANC' then 'void'
      when g.away_total = g.home_total then 'tie'
      when (p.winner_team_id = p.home_team_id and g.home_total > g.away_total)
        or (p.winner_team_id = p.away_team_id and g.away_total > g.home_total) then 'win' else 'loss' end,
    final_away_score = case when g.status_short <> 'CANC' then g.away_total end,
    final_home_score = case when g.status_short <> 'CANC' then g.home_total end,
    graded_at = clock_timestamp()
  from public.games g where p.analysis_id = requested_id and p.game_id = g.id and p.result = 'pending'
    and (g.status_short = 'CANC' or (g.status_short in ('FT', 'AOT') and g.away_total >= 0 and g.home_total >= 0));
  get diagnostics affected = row_count;
  return affected;
end;
$$;

create function public.lock_started_pickem_prediction()
returns trigger language plpgsql set search_path = '' as $$
begin
  if (old.kickoff_at <= clock_timestamp() or old.result <> 'pending'
    or exists (select 1 from public.games g where g.id = old.game_id
      and (g.game_timestamp <= extract(epoch from clock_timestamp())
        or g.status_short not in ('NS', 'PST', 'CANC'))))
    and (to_jsonb(new) - array['result', 'final_away_score', 'final_home_score', 'graded_at'])
      is distinct from (to_jsonb(old) - array['result', 'final_away_score', 'final_home_score', 'graded_at']) then
    raise exception 'Started Pickem predictions are locked.';
  end if;
  return new;
end;
$$;
create trigger lock_started_pickem_prediction before update on public.pickem_predictions
  for each row execute function public.lock_started_pickem_prediction();

alter table public.pickem_analyses enable row level security;
alter table public.pickem_predictions enable row level security;
revoke all on public.pickem_analyses, public.pickem_predictions from anon, authenticated;
grant all on public.pickem_analyses, public.pickem_predictions to service_role;
create policy pickem_analyses_service on public.pickem_analyses for all to service_role using (true) with check (true);
create policy pickem_predictions_service on public.pickem_predictions for all to service_role using (true) with check (true);
revoke all on function public.pickem_comparison(public.pickem_predictions),
  public.save_pickem_analysis(integer, text, text, integer, jsonb), public.grade_pickem_analysis(uuid),
  public.lock_started_pickem_prediction() from public, anon, authenticated;
grant execute on function public.pickem_comparison(public.pickem_predictions),
  public.save_pickem_analysis(integer, text, text, integer, jsonb), public.grade_pickem_analysis(uuid),
  public.lock_started_pickem_prediction() to service_role;
