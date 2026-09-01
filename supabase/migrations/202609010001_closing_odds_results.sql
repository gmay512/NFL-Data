-- Select auditable pre-kickoff closing lines and grade completed games against them.

create index if not exists idx_odds_game_bookmaker_bet_provider_updated
  on public.odds (game_id, bookmaker_id, bet_id, provider_updated_at desc);

create or replace view public.game_closing_consensus_odds
with (security_invoker = true)
as
with target_markets as (
  select
    max(id) filter (where name = 'Asian Handicap') as spread_bet_id,
    max(id) filter (where name = 'Over/Under') as total_bet_id
  from public.bet_types
),
latest_bookmaker_market_snapshots as (
  select
    odds.game_id,
    odds.bookmaker_id,
    odds.bet_id,
    max(odds.provider_updated_at) as provider_updated_at
  from public.odds
  join public.games
    on games.id = odds.game_id
  cross join target_markets
  where games.game_timestamp is not null
    and odds.bet_id in (target_markets.spread_bet_id, target_markets.total_bet_id)
    and odds.provider_updated_at <= to_timestamp(games.game_timestamp)
  group by odds.game_id, odds.bookmaker_id, odds.bet_id
),
latest_market_rows as (
  select
    odds.game_id,
    odds.bookmaker_id,
    odds.bet_id,
    split_part(odds.bet_value, ' ', 1) as outcome,
    case
      when odds.bet_value ~ '[+-]?[0-9]+([.][0-9]+)?$'
        then substring(odds.bet_value from '([+-]?[0-9]+([.][0-9]+)?)$')::numeric
      else null
    end as line,
    odds.odd,
    odds.provider_updated_at
  from public.odds
  join latest_bookmaker_market_snapshots
    on latest_bookmaker_market_snapshots.game_id = odds.game_id
    and latest_bookmaker_market_snapshots.bookmaker_id = odds.bookmaker_id
    and latest_bookmaker_market_snapshots.bet_id = odds.bet_id
    and latest_bookmaker_market_snapshots.provider_updated_at = odds.provider_updated_at
  where odds.odd is not null
),
spread_pairs as (
  select
    home.game_id,
    home.bookmaker_id,
    abs(home.line) as line,
    home.line as home_line,
    coalesce(same_line_away.line, opposite_line_away.line) as away_line,
    home.odd as home_odd,
    coalesce(same_line_away.odd, opposite_line_away.odd) as away_odd,
    home.provider_updated_at
  from latest_market_rows home
  left join latest_market_rows same_line_away
    on same_line_away.game_id = home.game_id
    and same_line_away.bookmaker_id = home.bookmaker_id
    and same_line_away.bet_id = home.bet_id
    and same_line_away.outcome = 'Away'
    and same_line_away.line = home.line
  left join latest_market_rows opposite_line_away
    on opposite_line_away.game_id = home.game_id
    and opposite_line_away.bookmaker_id = home.bookmaker_id
    and opposite_line_away.bet_id = home.bet_id
    and opposite_line_away.outcome = 'Away'
    and opposite_line_away.line = -home.line
    and same_line_away.line is null
  cross join target_markets
  where home.bet_id = target_markets.spread_bet_id
    and home.outcome = 'Home'
    and home.line is not null
    and coalesce(same_line_away.line, opposite_line_away.line) is not null
),
ranked_spreads as (
  select
    spread_pairs.*,
    row_number() over (
      partition by spread_pairs.game_id, spread_pairs.bookmaker_id
      order by
        abs(spread_pairs.home_odd - spread_pairs.away_odd),
        abs(((spread_pairs.home_odd + spread_pairs.away_odd) / 2) - 1.91),
        abs(spread_pairs.line)
    ) as line_rank
  from spread_pairs
  where spread_pairs.home_odd is not null
    and spread_pairs.away_odd is not null
    and (
      spread_pairs.home_odd <> spread_pairs.away_odd
      or sign(spread_pairs.home_line) <> sign(spread_pairs.away_line)
      or spread_pairs.line = 0
    )
),
bookmaker_spreads as (
  select
    ranked_spreads.game_id,
    ranked_spreads.bookmaker_id,
    case
      when sign(ranked_spreads.home_line) <> sign(ranked_spreads.away_line)
        then ranked_spreads.home_line
      when ranked_spreads.home_odd < ranked_spreads.away_odd then -abs(ranked_spreads.line)
      else abs(ranked_spreads.line)
    end as home_spread,
    ranked_spreads.provider_updated_at
  from ranked_spreads
  where ranked_spreads.line_rank = 1
),
spread_consensus as (
  select
    bookmaker_spreads.game_id,
    percentile_cont(0.5) within group (order by bookmaker_spreads.home_spread)::numeric as home_spread,
    count(*)::integer as spread_bookmaker_count,
    min(bookmaker_spreads.provider_updated_at) as spread_source_first_updated_at,
    max(bookmaker_spreads.provider_updated_at) as spread_source_last_updated_at
  from bookmaker_spreads
  group by bookmaker_spreads.game_id
),
total_pairs as (
  select
    latest_market_rows.game_id,
    latest_market_rows.bookmaker_id,
    latest_market_rows.line,
    max(latest_market_rows.odd) filter (where latest_market_rows.outcome = 'Over') as over_odd,
    max(latest_market_rows.odd) filter (where latest_market_rows.outcome = 'Under') as under_odd,
    max(latest_market_rows.provider_updated_at) as provider_updated_at
  from latest_market_rows
  cross join target_markets
  where latest_market_rows.bet_id = target_markets.total_bet_id
    and latest_market_rows.line is not null
  group by latest_market_rows.game_id, latest_market_rows.bookmaker_id, latest_market_rows.line
),
ranked_totals as (
  select
    total_pairs.*,
    row_number() over (
      partition by total_pairs.game_id, total_pairs.bookmaker_id
      order by
        abs(total_pairs.over_odd - total_pairs.under_odd),
        abs(((total_pairs.over_odd + total_pairs.under_odd) / 2) - 1.91),
        total_pairs.line
    ) as line_rank
  from total_pairs
  where total_pairs.over_odd is not null
    and total_pairs.under_odd is not null
),
bookmaker_totals as (
  select
    ranked_totals.game_id,
    ranked_totals.bookmaker_id,
    ranked_totals.line as total,
    ranked_totals.provider_updated_at
  from ranked_totals
  where ranked_totals.line_rank = 1
),
total_consensus as (
  select
    bookmaker_totals.game_id,
    percentile_cont(0.5) within group (order by bookmaker_totals.total)::numeric as total,
    count(*)::integer as total_bookmaker_count,
    min(bookmaker_totals.provider_updated_at) as total_source_first_updated_at,
    max(bookmaker_totals.provider_updated_at) as total_source_last_updated_at
  from bookmaker_totals
  group by bookmaker_totals.game_id
)
select
  coalesce(spread_consensus.game_id, total_consensus.game_id) as game_id,
  spread_consensus.home_spread,
  spread_consensus.spread_bookmaker_count,
  spread_consensus.spread_source_first_updated_at,
  spread_consensus.spread_source_last_updated_at,
  total_consensus.total,
  total_consensus.total_bookmaker_count,
  total_consensus.total_source_first_updated_at,
  total_consensus.total_source_last_updated_at
from spread_consensus
full join total_consensus using (game_id);

grant select on public.game_closing_consensus_odds to anon, authenticated, service_role;

comment on view public.game_closing_consensus_odds is
  'Median full-game spread and total from each bookmaker latest valid snapshot at or before kickoff';

create or replace view public.game_betting_results
with (security_invoker = true)
as
select
  games.id as game_id,
  games.season,
  games.stage,
  games.week,
  games.game_date,
  games.game_timestamp,
  games.away_team_id,
  away_teams.name as away_team_name,
  games.home_team_id,
  home_teams.name as home_team_name,
  games.away_total as away_score,
  games.home_total as home_score,
  games.away_total + games.home_total as final_total,
  games.home_total - games.away_total as home_margin,
  closing_odds.home_spread as closing_home_spread,
  closing_odds.spread_bookmaker_count,
  closing_odds.spread_source_first_updated_at,
  closing_odds.spread_source_last_updated_at,
  case
    when closing_odds.home_spread is null then null
    else games.home_total - games.away_total + closing_odds.home_spread
  end as spread_delta,
  case
    when closing_odds.home_spread is null then 'ungraded'
    when games.home_total - games.away_total + closing_odds.home_spread > 0 then 'home_cover'
    when games.home_total - games.away_total + closing_odds.home_spread < 0 then 'away_cover'
    else 'push'
  end as spread_result,
  closing_odds.total as closing_total,
  closing_odds.total_bookmaker_count,
  closing_odds.total_source_first_updated_at,
  closing_odds.total_source_last_updated_at,
  case
    when closing_odds.total is null then null
    else games.away_total + games.home_total - closing_odds.total
  end as total_delta,
  case
    when closing_odds.total is null then 'ungraded'
    when games.away_total + games.home_total > closing_odds.total then 'over'
    when games.away_total + games.home_total < closing_odds.total then 'under'
    else 'push'
  end as total_result
from public.games
join public.teams away_teams
  on away_teams.id = games.away_team_id
join public.teams home_teams
  on home_teams.id = games.home_team_id
left join public.game_closing_consensus_odds closing_odds
  on closing_odds.game_id = games.id
where games.status_short in ('FT', 'AOT')
  and games.away_total is not null
  and games.home_total is not null;

grant select on public.game_betting_results to anon, authenticated, service_role;

comment on view public.game_betting_results is
  'Completed games graded against the auditable pre-kickoff closing consensus spread and total';
