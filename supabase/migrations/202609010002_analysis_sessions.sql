-- Persist grounded analytics conversations behind the service-role API.

create table public.analysis_sessions (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  preset_type text not null,
  filter_snapshot jsonb not null default '{}'::jsonb,
  context_snapshot jsonb not null,
  model_name text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint analysis_sessions_title_check
    check (length(btrim(title)) between 1 and 160),
  constraint analysis_sessions_preset_type_check
    check (preset_type in ('season_overview', 'team_analysis', 'game_review', 'trend_comparison')),
  constraint analysis_sessions_filter_snapshot_check
    check (jsonb_typeof(filter_snapshot) = 'object'),
  constraint analysis_sessions_context_snapshot_check
    check (jsonb_typeof(context_snapshot) = 'object'),
  constraint analysis_sessions_model_name_check
    check (length(btrim(model_name)) between 1 and 200)
);

create index analysis_sessions_updated_at_idx
  on public.analysis_sessions (updated_at desc);

create index analysis_sessions_preset_type_idx
  on public.analysis_sessions (preset_type);

create table public.analysis_messages (
  id bigint generated always as identity primary key,
  session_id uuid not null references public.analysis_sessions(id) on delete cascade,
  role text not null,
  content text not null,
  input_tokens integer,
  output_tokens integer,
  latency_ms integer,
  created_at timestamptz not null default now(),
  constraint analysis_messages_role_check
    check (role in ('user', 'assistant')),
  constraint analysis_messages_content_check
    check (length(btrim(content)) > 0),
  constraint analysis_messages_input_tokens_check
    check (input_tokens is null or input_tokens >= 0),
  constraint analysis_messages_output_tokens_check
    check (output_tokens is null or output_tokens >= 0),
  constraint analysis_messages_latency_ms_check
    check (latency_ms is null or latency_ms >= 0)
);

create index analysis_messages_session_id_id_idx
  on public.analysis_messages (session_id, id);

create function public.enforce_analysis_session_snapshot_immutable()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.id is distinct from old.id
    or new.preset_type is distinct from old.preset_type
    or new.filter_snapshot is distinct from old.filter_snapshot
    or new.context_snapshot is distinct from old.context_snapshot
    or new.model_name is distinct from old.model_name
    or new.created_at is distinct from old.created_at
  then
    raise exception 'Analysis session grounding fields are immutable.';
  end if;

  return new;
end;
$$;

create trigger enforce_analysis_session_snapshot_immutable
before update on public.analysis_sessions
for each row execute function public.enforce_analysis_session_snapshot_immutable();

create function public.set_analysis_session_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at = clock_timestamp();
  return new;
end;
$$;

create trigger set_analysis_session_updated_at
before update on public.analysis_sessions
for each row execute function public.set_analysis_session_updated_at();

create function public.touch_analysis_session_from_message()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    update public.analysis_sessions
    set updated_at = clock_timestamp()
    where id = old.session_id;
  elsif tg_op = 'UPDATE' then
    update public.analysis_sessions
    set updated_at = clock_timestamp()
    where id in (old.session_id, new.session_id);
  else
    update public.analysis_sessions
    set updated_at = clock_timestamp()
    where id = new.session_id;
  end if;

  return null;
end;
$$;

create trigger touch_analysis_session_from_message
after insert or update or delete on public.analysis_messages
for each row execute function public.touch_analysis_session_from_message();

alter table public.analysis_sessions enable row level security;
alter table public.analysis_messages enable row level security;

revoke all on public.analysis_sessions, public.analysis_messages from anon, authenticated;
grant all on public.analysis_sessions, public.analysis_messages to service_role;
grant usage, select on sequence public.analysis_messages_id_seq to service_role;

create policy analysis_sessions_all_service_role
  on public.analysis_sessions for all to service_role using (true) with check (true);

create policy analysis_messages_all_service_role
  on public.analysis_messages for all to service_role using (true) with check (true);

revoke all on function public.enforce_analysis_session_snapshot_immutable() from public, anon, authenticated;
revoke all on function public.set_analysis_session_updated_at() from public, anon, authenticated;
revoke all on function public.touch_analysis_session_from_message() from public, anon, authenticated;

grant execute on function public.enforce_analysis_session_snapshot_immutable() to service_role;
grant execute on function public.set_analysis_session_updated_at() to service_role;
grant execute on function public.touch_analysis_session_from_message() to service_role;

comment on table public.analysis_sessions is
  'Named local-LLM analysis sessions with immutable filters and grounded analytics context';

comment on table public.analysis_messages is
  'Ordered user and assistant messages persisted for an analysis session';

comment on column public.analysis_messages.id is
  'Global insertion order used with session_id to replay a conversation deterministically';
