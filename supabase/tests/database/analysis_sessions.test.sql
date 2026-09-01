begin;

select plan(20);

select has_table('public', 'analysis_sessions', 'creates the analysis sessions table');
select has_table('public', 'analysis_messages', 'creates the analysis messages table');
select col_is_pk('public', 'analysis_sessions', 'id', 'uses a session primary key');
select col_is_pk('public', 'analysis_messages', 'id', 'uses a message primary key');
select col_is_fk(
  'public',
  'analysis_messages',
  'session_id',
  'links messages to their session'
);

select ok(
  not has_table_privilege('anon', 'public.analysis_sessions', 'select'),
  'does not expose analysis sessions to anonymous clients'
);
select ok(
  not has_table_privilege('authenticated', 'public.analysis_messages', 'select'),
  'does not expose analysis messages directly to authenticated clients'
);
select ok(
  has_table_privilege('service_role', 'public.analysis_sessions', 'insert'),
  'allows the service role to create sessions'
);
select ok(
  has_table_privilege('service_role', 'public.analysis_messages', 'insert'),
  'allows the service role to append messages'
);

insert into public.analysis_sessions (
  id,
  title,
  preset_type,
  filter_snapshot,
  context_snapshot,
  model_name,
  updated_at
)
values (
  '99000000-0000-0000-0000-000000000001',
  '2099 season overview',
  'season_overview',
  '{"season": 2099}'::jsonb,
  '{"metrics": {"games": 10}}'::jsonb,
  'test-model',
  '2000-01-01 00:00:00+00'
);

select is(
  (select title from public.analysis_sessions where id = '99000000-0000-0000-0000-000000000001'),
  '2099 season overview',
  'persists a named session'
);
select is(
  (select filter_snapshot from public.analysis_sessions where id = '99000000-0000-0000-0000-000000000001'),
  '{"season": 2099}'::jsonb,
  'persists the filter snapshot'
);
select is(
  (select context_snapshot from public.analysis_sessions where id = '99000000-0000-0000-0000-000000000001'),
  '{"metrics": {"games": 10}}'::jsonb,
  'persists the grounded context snapshot'
);

select throws_ok(
  $$
    update public.analysis_sessions
    set context_snapshot = '{"metrics": {"games": 11}}'::jsonb
    where id = '99000000-0000-0000-0000-000000000001'
  $$,
  'P0001',
  'Analysis session grounding fields are immutable.',
  'prevents grounded context from changing'
);

update public.analysis_sessions
set title = 'Renamed season overview'
where id = '99000000-0000-0000-0000-000000000001';

select is(
  (select title from public.analysis_sessions where id = '99000000-0000-0000-0000-000000000001'),
  'Renamed season overview',
  'allows session titles to be renamed'
);
select ok(
  (select updated_at > '2000-01-01 00:00:00+00'::timestamptz
   from public.analysis_sessions
   where id = '99000000-0000-0000-0000-000000000001'),
  'updates session activity time when renamed'
);

create temporary table analysis_session_before_message as
select updated_at
from public.analysis_sessions
where id = '99000000-0000-0000-0000-000000000001';

insert into public.analysis_messages (
  session_id,
  role,
  content,
  input_tokens,
  output_tokens,
  latency_ms
)
values
  ('99000000-0000-0000-0000-000000000001', 'user', 'Summarize this season.', 120, null, null),
  ('99000000-0000-0000-0000-000000000001', 'assistant', 'The supplied metrics cover ten games.', 120, 18, 250);

select is(
  (select count(*)::integer from public.analysis_messages where session_id = '99000000-0000-0000-0000-000000000001'),
  2,
  'persists conversation messages'
);
select results_eq(
  $$
    select role
    from public.analysis_messages
    where session_id = '99000000-0000-0000-0000-000000000001'
    order by id
  $$,
  array['user'::text, 'assistant'::text],
  'replays messages in insertion order'
);
select ok(
  (
    select sessions.updated_at > before_message.updated_at
    from public.analysis_sessions sessions
    cross join analysis_session_before_message before_message
    where sessions.id = '99000000-0000-0000-0000-000000000001'
  ),
  'touches session activity time when messages are appended'
);

delete from public.analysis_sessions
where id = '99000000-0000-0000-0000-000000000001';

select is(
  (select count(*)::integer from public.analysis_messages where session_id = '99000000-0000-0000-0000-000000000001'),
  0,
  'deletes messages when their session is deleted'
);

select throws_ok(
  $$
    insert into public.analysis_sessions (
      title,
      preset_type,
      filter_snapshot,
      context_snapshot,
      model_name
    )
    values ('Invalid filters', 'season_overview', '[]'::jsonb, '{}'::jsonb, 'test-model')
  $$,
  '23514',
  null,
  'requires filter snapshots to be JSON objects'
);

select * from finish();
rollback;
