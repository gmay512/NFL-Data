-- Select the latest complete pre-kickoff market per bookmaker.

create or replace view public.game_closing_consensus_odds
with (security_invoker = true)
as
with target_markets as (
  select
    max(id) filter (where name = 'Asian Handicap') as spread_bet_id,
    max(id) filter (where name = 'Over/Under') as total_bet_id
  from public.bet_types
),
market_rows as (
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
  join public.games
    on games.id = odds.game_id
  cross join target_markets
  where games.game_timestamp is not null
    and odds.bet_id in (target_markets.spread_bet_id, target_markets.total_bet_id)
    and odds.provider_updated_at <= to_timestamp(games.game_timestamp)
    and odds.odd is not null
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
  from market_rows home
  left join market_rows same_line_away
    on same_line_away.game_id = home.game_id
    and same_line_away.bookmaker_id = home.bookmaker_id
    and same_line_away.bet_id = home.bet_id
    and same_line_away.provider_updated_at = home.provider_updated_at
    and same_line_away.outcome = 'Away'
    and same_line_away.line = home.line
  left join market_rows opposite_line_away
    on opposite_line_away.game_id = home.game_id
    and opposite_line_away.bookmaker_id = home.bookmaker_id
    and opposite_line_away.bet_id = home.bet_id
    and opposite_line_away.provider_updated_at = home.provider_updated_at
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
      partition by
        spread_pairs.game_id,
        spread_pairs.bookmaker_id,
        spread_pairs.provider_updated_at
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
  select distinct on (ranked_spreads.game_id, ranked_spreads.bookmaker_id)
    ranked_spreads.game_id,
    ranked_spreads.bookmaker_id,
    case
      when sign(ranked_spreads.home_line) <> sign(ranked_spreads.away_line)
        then ranked_spreads.home_line
      when ranked_spreads.home_odd < ranked_spreads.away_odd
        then -abs(ranked_spreads.line)
      else abs(ranked_spreads.line)
    end as home_spread,
    ranked_spreads.provider_updated_at
  from ranked_spreads
  where ranked_spreads.line_rank = 1
  order by
    ranked_spreads.game_id,
    ranked_spreads.bookmaker_id,
    ranked_spreads.provider_updated_at desc
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
    market_rows.game_id,
    market_rows.bookmaker_id,
    market_rows.line,
    market_rows.provider_updated_at,
    max(market_rows.odd) filter (where market_rows.outcome = 'Over') as over_odd,
    max(market_rows.odd) filter (where market_rows.outcome = 'Under') as under_odd
  from market_rows
  cross join target_markets
  where market_rows.bet_id = target_markets.total_bet_id
    and market_rows.line is not null
  group by
    market_rows.game_id,
    market_rows.bookmaker_id,
    market_rows.line,
    market_rows.provider_updated_at
),
ranked_totals as (
  select
    total_pairs.*,
    row_number() over (
      partition by
        total_pairs.game_id,
        total_pairs.bookmaker_id,
        total_pairs.provider_updated_at
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
  select distinct on (ranked_totals.game_id, ranked_totals.bookmaker_id)
    ranked_totals.game_id,
    ranked_totals.bookmaker_id,
    ranked_totals.line as total,
    ranked_totals.provider_updated_at
  from ranked_totals
  where ranked_totals.line_rank = 1
  order by
    ranked_totals.game_id,
    ranked_totals.bookmaker_id,
    ranked_totals.provider_updated_at desc
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
  'Median full-game spread and total from each bookmaker latest complete valid snapshot at or before kickoff';
