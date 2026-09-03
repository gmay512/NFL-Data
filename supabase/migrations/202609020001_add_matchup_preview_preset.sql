-- Allow persisted pregame matchup analysis sessions.
alter table public.analysis_sessions
  drop constraint if exists analysis_sessions_preset_type_check;

alter table public.analysis_sessions
  add constraint analysis_sessions_preset_type_check
  check (preset_type in (
    'season_overview',
    'team_analysis',
    'game_review',
    'matchup_preview',
    'trend_comparison'
  ));

grant select on public.game_consensus_odds to service_role;
