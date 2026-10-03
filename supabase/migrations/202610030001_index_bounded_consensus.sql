-- Apply the ID bound directly to each odds scan. A join to an unnested
-- parameter alone can make PostgreSQL scan/materialize the entire market catalog.
create or replace function public.get_game_consensus_odds(requested_game_ids integer[])
returns table (game_id integer, home_spread numeric, total numeric)
language sql
stable
security invoker
set search_path = ''
as $$
  select consensus.*
  from (
    select distinct id
    from unnest(coalesce(requested_game_ids, array[]::integer[])) requested(id)
    where id is not null
  ) requested
  cross join lateral (
  with target_markets as materialized (
    select
      max(id) filter (where name = 'Asian Handicap') as spread_bet_id,
      max(id) filter (where name = 'Over/Under') as total_bet_id
    from public.bet_types
  ),
  latest_bookmaker_snapshots as materialized (
    select distinct on (odds.game_id, odds.bookmaker_id)
      odds.game_id, odds.bookmaker_id, odds.provider_updated_at
    from public.odds
    cross join target_markets
    where odds.game_id = requested.id
      and odds.bet_id in (target_markets.spread_bet_id, target_markets.total_bet_id)
    order by odds.game_id, odds.bookmaker_id, odds.provider_updated_at desc
  ),
  latest_market_rows as materialized (
    select
      odds.game_id, odds.bookmaker_id, odds.bet_id,
      split_part(odds.bet_value, ' ', 1) as outcome,
      case when odds.bet_value ~ '[+-]?[0-9]+([.][0-9]+)?$'
        then substring(odds.bet_value from '([+-]?[0-9]+([.][0-9]+)?)$')::numeric
        else null
      end as line,
      odds.odd
    from latest_bookmaker_snapshots
    join public.odds
      on odds.game_id = latest_bookmaker_snapshots.game_id
      and odds.bookmaker_id = latest_bookmaker_snapshots.bookmaker_id
      and odds.provider_updated_at = latest_bookmaker_snapshots.provider_updated_at
    cross join target_markets
    where odds.game_id = requested.id
      and odds.bet_id in (target_markets.spread_bet_id, target_markets.total_bet_id)
      and odds.odd is not null
  ),
  spread_pairs as (
    select
      home.game_id, home.bookmaker_id,
      abs(home.line) as line, home.line as home_spread,
      home.odd as home_odd,
      coalesce(same_line_away.odd, opposite_line_away.odd) as away_odd
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
    select spread_pairs.*,
      row_number() over (
        partition by game_id, bookmaker_id
        order by abs(home_odd - away_odd),
          abs(((home_odd + away_odd) / 2) - 1.91), abs(line)
      ) as line_rank
    from spread_pairs
    where home_odd is not null and away_odd is not null
  ),
  spread_consensus as (
    select game_id,
      percentile_cont(0.5) within group (order by home_spread)::numeric as home_spread
    from ranked_spreads where line_rank = 1
    group by game_id
  ),
  total_pairs as (
    select latest_market_rows.game_id, latest_market_rows.bookmaker_id, latest_market_rows.line,
      max(odd) filter (where outcome = 'Over') as over_odd,
      max(odd) filter (where outcome = 'Under') as under_odd
    from latest_market_rows
    cross join target_markets
    where bet_id = target_markets.total_bet_id and line is not null
    group by latest_market_rows.game_id, latest_market_rows.bookmaker_id, latest_market_rows.line
  ),
  ranked_totals as (
    select total_pairs.*,
      row_number() over (
        partition by game_id, bookmaker_id
        order by abs(over_odd - under_odd),
          abs(((over_odd + under_odd) / 2) - 1.91), line
      ) as line_rank
    from total_pairs where over_odd is not null and under_odd is not null
  ),
  total_consensus as (
    select game_id, percentile_cont(0.5) within group (order by line)::numeric as total
    from ranked_totals where line_rank = 1 group by game_id
  ),
  consensus_game_ids as (
    select game_id from spread_consensus
    union
    select game_id from total_consensus
  )
  select consensus_game_ids.game_id, spread_consensus.home_spread, total_consensus.total
  from consensus_game_ids
  left join spread_consensus using (game_id)
  left join total_consensus using (game_id)
  ) consensus
  order by consensus.game_id;
$$;
