-- Persist grounded, per-suggestion explanations for graded weekly losses.

create table public.betting_suggestion_loss_analyses (
  id bigint generated always as identity primary key,
  suggestion_id bigint not null unique
    references public.betting_suggestions(id) on delete cascade,
  analysis_version smallint not null,
  model_name text not null,
  evidence_snapshot jsonb not null,
  summary text not null,
  clues jsonb not null,
  missing_metrics text[] not null default '{}',
  created_at timestamptz not null default now(),
  constraint betting_loss_analysis_version_check check (analysis_version > 0),
  constraint betting_loss_analysis_model_check check (length(btrim(model_name)) between 1 and 200),
  constraint betting_loss_analysis_evidence_check check (jsonb_typeof(evidence_snapshot) = 'object'),
  constraint betting_loss_analysis_summary_check check (length(btrim(summary)) between 1 and 500),
  constraint betting_loss_analysis_clues_check check (
    jsonb_typeof(clues) = 'array'
    and jsonb_array_length(clues) between 1 and 5
  )
);

create index betting_loss_analyses_created_at_idx
  on public.betting_suggestion_loss_analyses (created_at desc);

create function public.enforce_betting_loss_analysis()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  suggestion_result text;
  suggestion_stage text;
begin
  select result, stage
    into suggestion_result, suggestion_stage
    from public.betting_suggestions
    where id = new.suggestion_id;

  if suggestion_result is null then
    raise exception 'Betting suggestion was not found.';
  end if;
  if suggestion_result <> 'loss' then
    raise exception 'Only losing betting suggestions can be analyzed.';
  end if;
  if lower(regexp_replace(coalesce(suggestion_stage, ''), '[[:space:]-]', '', 'g')) = 'preseason' then
    raise exception 'Preseason betting suggestions cannot be analyzed.';
  end if;
  if tg_op = 'UPDATE' then
    raise exception 'Betting loss analyses are immutable.';
  end if;
  return new;
end;
$$;

create trigger enforce_betting_loss_analysis_insert
before insert on public.betting_suggestion_loss_analyses
for each row execute function public.enforce_betting_loss_analysis();

create trigger prevent_betting_loss_analysis_updates
before update on public.betting_suggestion_loss_analyses
for each row execute function public.enforce_betting_loss_analysis();

alter table public.betting_suggestion_loss_analyses enable row level security;

revoke all on public.betting_suggestion_loss_analyses from anon, authenticated;
grant all on public.betting_suggestion_loss_analyses to service_role;
grant usage, select on sequence public.betting_suggestion_loss_analyses_id_seq to service_role;

create policy betting_suggestion_loss_analyses_all_service_role
  on public.betting_suggestion_loss_analyses
  for all to service_role
  using (true)
  with check (true);

revoke all on function public.enforce_betting_loss_analysis() from public, anon, authenticated;
grant execute on function public.enforce_betting_loss_analysis() to service_role;

comment on table public.betting_suggestion_loss_analyses is
  'Immutable local-LLM explanations grounded in post-game stats and the saved pregame snapshot';
