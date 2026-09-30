-- Keep bounded odds lookups index-driven as snapshot history grows.

create index if not exists idx_odds_game_bookmaker_updated_market
  on public.odds (game_id, bookmaker_id, provider_updated_at desc, bet_id)
  include (bet_value, odd);

create or replace function public.get_game_consensus_odds(requested_game_ids integer[])
returns table (
  game_id integer,
  home_spread numeric,
  total numeric
)
language sql
stable
security invoker
set search_path = ''
as $$
  with requested_games as materialized (
    select distinct requested.game_id
    from unnest(coalesce(requested_game_ids, array[]::integer[])) as requested(game_id)
    where requested.game_id is not null
  ),
  target_markets as materialized (
    select
      max(id) filter (where name = 'Asian Handicap') as spread_bet_id,
      max(id) filter (where name = 'Over/Under') as total_bet_id
    from public.bet_types
  ),
  latest_bookmaker_snapshots as materialized (
    select distinct on (odds.game_id, odds.bookmaker_id)
      odds.game_id,
      odds.bookmaker_id,
      odds.provider_updated_at
    from requested_games
    join public.odds using (game_id)
    cross join target_markets
    where odds.bet_id in (target_markets.spread_bet_id, target_markets.total_bet_id)
    order by odds.game_id, odds.bookmaker_id, odds.provider_updated_at desc
  ),
  latest_market_rows as materialized (
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
      odds.odd
    from latest_bookmaker_snapshots
    join public.odds
      on odds.game_id = latest_bookmaker_snapshots.game_id
      and odds.bookmaker_id = latest_bookmaker_snapshots.bookmaker_id
      and odds.provider_updated_at = latest_bookmaker_snapshots.provider_updated_at
    cross join target_markets
    where odds.bet_id in (target_markets.spread_bet_id, target_markets.total_bet_id)
      and odds.odd is not null
  ),
  spread_pairs as (
    select
      home.game_id,
      home.bookmaker_id,
      abs(home.line) as line,
      home.line as home_spread,
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
  ),
  bookmaker_spreads as (
    select ranked_spreads.game_id, ranked_spreads.home_spread
    from ranked_spreads
    where ranked_spreads.line_rank = 1
  ),
  spread_consensus as (
    select
      bookmaker_spreads.game_id,
      percentile_cont(0.5) within group (order by bookmaker_spreads.home_spread)::numeric as home_spread
    from bookmaker_spreads
    group by bookmaker_spreads.game_id
  ),
  total_pairs as (
    select
      latest_market_rows.game_id,
      latest_market_rows.bookmaker_id,
      latest_market_rows.line,
      max(latest_market_rows.odd) filter (where latest_market_rows.outcome = 'Over') as over_odd,
      max(latest_market_rows.odd) filter (where latest_market_rows.outcome = 'Under') as under_odd
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
    select ranked_totals.game_id, ranked_totals.line as total
    from ranked_totals
    where ranked_totals.line_rank = 1
  ),
  total_consensus as (
    select
      bookmaker_totals.game_id,
      percentile_cont(0.5) within group (order by bookmaker_totals.total)::numeric as total
    from bookmaker_totals
    group by bookmaker_totals.game_id
  ),
  consensus_game_ids as (
    select spread_consensus.game_id from spread_consensus
    union
    select total_consensus.game_id from total_consensus
  )
  select
    consensus_game_ids.game_id,
    spread_consensus.home_spread,
    total_consensus.total
  from consensus_game_ids
  left join spread_consensus using (game_id)
  left join total_consensus using (game_id)
  order by consensus_game_ids.game_id;
$$;

create or replace function public.get_game_betting_results(requested_game_ids integer[])
returns table (
  game_id integer,
  season integer,
  stage text,
  week text,
  game_date date,
  game_timestamp bigint,
  away_team_id integer,
  away_team_name text,
  home_team_id integer,
  home_team_name text,
  away_score integer,
  home_score integer,
  final_total integer,
  home_margin integer,
  closing_home_spread numeric,
  spread_bookmaker_count integer,
  spread_delta numeric,
  spread_result text,
  closing_total numeric,
  total_bookmaker_count integer,
  total_delta numeric,
  total_result text
)
language sql
stable
security invoker
set search_path = ''
as $$
  with requested_games as materialized (
    select distinct requested.game_id
    from unnest(coalesce(requested_game_ids, array[]::integer[])) as requested(game_id)
    where requested.game_id is not null
  ),
  eligible_games as materialized (
    select games.*
    from requested_games
    join public.games on games.id = requested_games.game_id
    where games.status_short in ('FT', 'AOT')
      and games.away_total is not null
      and games.home_total is not null
  ),
  target_markets as materialized (
    select
      max(id) filter (where name = 'Asian Handicap') as spread_bet_id,
      max(id) filter (where name = 'Over/Under') as total_bet_id
    from public.bet_types
  ),
  eligible_bookmakers as materialized (
    select distinct
      eligible_games.id as game_id,
      eligible_games.game_timestamp,
      odds.bookmaker_id
    from eligible_games
    join public.odds on odds.game_id = eligible_games.id
    cross join target_markets
    where odds.bet_id in (target_markets.spread_bet_id, target_markets.total_bet_id)
      and odds.provider_updated_at <= to_timestamp(eligible_games.game_timestamp)
      and odds.odd is not null
  ),
  bookmaker_spreads as (
    select
      eligible_bookmakers.game_id,
      eligible_bookmakers.bookmaker_id,
      spread.home_spread,
      spread.provider_updated_at
    from eligible_bookmakers
    join lateral (
      select
        selected_spread.home_spread,
        snapshots.provider_updated_at
      from (
        select distinct odds.provider_updated_at
        from public.odds
        cross join target_markets
        where odds.game_id = eligible_bookmakers.game_id
          and odds.bookmaker_id = eligible_bookmakers.bookmaker_id
          and odds.bet_id = target_markets.spread_bet_id
          and odds.provider_updated_at <= to_timestamp(eligible_bookmakers.game_timestamp)
        order by odds.provider_updated_at desc
      ) snapshots
      cross join lateral (
        select
          substring(home.bet_value from '([+-]?[0-9]+([.][0-9]+)?)$')::numeric as home_spread
        from public.odds home
        join lateral (
          select away.odd
          from public.odds away
          where away.game_id = home.game_id
            and away.bookmaker_id = home.bookmaker_id
            and away.bet_id = home.bet_id
            and away.provider_updated_at = home.provider_updated_at
            and split_part(away.bet_value, ' ', 1) = 'Away'
            and away.bet_value ~ '[+-]?[0-9]+([.][0-9]+)?$'
            and substring(away.bet_value from '([+-]?[0-9]+([.][0-9]+)?)$')::numeric in (
              substring(home.bet_value from '([+-]?[0-9]+([.][0-9]+)?)$')::numeric,
              -substring(home.bet_value from '([+-]?[0-9]+([.][0-9]+)?)$')::numeric
            )
            and away.odd is not null
          order by
            case
              when substring(away.bet_value from '([+-]?[0-9]+([.][0-9]+)?)$')::numeric
                = substring(home.bet_value from '([+-]?[0-9]+([.][0-9]+)?)$')::numeric
                then 0
              else 1
            end
          limit 1
        ) away on true
        cross join target_markets
        where home.game_id = eligible_bookmakers.game_id
          and home.bookmaker_id = eligible_bookmakers.bookmaker_id
          and home.bet_id = target_markets.spread_bet_id
          and home.provider_updated_at = snapshots.provider_updated_at
          and split_part(home.bet_value, ' ', 1) = 'Home'
          and home.bet_value ~ '[+-]?[0-9]+([.][0-9]+)?$'
          and home.odd is not null
        order by
          abs(home.odd - away.odd),
          abs(((home.odd + away.odd) / 2) - 1.91),
          abs(substring(home.bet_value from '([+-]?[0-9]+([.][0-9]+)?)$')::numeric)
        limit 1
      ) selected_spread
      order by snapshots.provider_updated_at desc
      limit 1
    ) spread on true
  ),
  spread_consensus as (
    select
      bookmaker_spreads.game_id,
      percentile_cont(0.5) within group (order by bookmaker_spreads.home_spread)::numeric as home_spread,
      count(*)::integer as spread_bookmaker_count
    from bookmaker_spreads
    group by bookmaker_spreads.game_id
  ),
  bookmaker_totals as (
    select
      eligible_bookmakers.game_id,
      eligible_bookmakers.bookmaker_id,
      selected_total.total,
      selected_total.provider_updated_at
    from eligible_bookmakers
    join lateral (
      select
        substring(over_row.bet_value from '([+-]?[0-9]+([.][0-9]+)?)$')::numeric as total,
        over_row.provider_updated_at
      from public.odds over_row
      join public.odds under_row
        on under_row.game_id = over_row.game_id
        and under_row.bookmaker_id = over_row.bookmaker_id
        and under_row.bet_id = over_row.bet_id
        and under_row.provider_updated_at = over_row.provider_updated_at
        and split_part(under_row.bet_value, ' ', 1) = 'Under'
        and under_row.bet_value ~ '[+-]?[0-9]+([.][0-9]+)?$'
        and substring(under_row.bet_value from '([+-]?[0-9]+([.][0-9]+)?)$')::numeric
          = substring(over_row.bet_value from '([+-]?[0-9]+([.][0-9]+)?)$')::numeric
        and under_row.odd is not null
      cross join target_markets
      where over_row.game_id = eligible_bookmakers.game_id
        and over_row.bookmaker_id = eligible_bookmakers.bookmaker_id
        and over_row.bet_id = target_markets.total_bet_id
        and over_row.provider_updated_at <= to_timestamp(eligible_bookmakers.game_timestamp)
        and split_part(over_row.bet_value, ' ', 1) = 'Over'
        and over_row.bet_value ~ '[+-]?[0-9]+([.][0-9]+)?$'
        and over_row.odd is not null
      order by
        over_row.provider_updated_at desc,
        abs(over_row.odd - under_row.odd),
        abs(((over_row.odd + under_row.odd) / 2) - 1.91),
        substring(over_row.bet_value from '([+-]?[0-9]+([.][0-9]+)?)$')::numeric
      limit 1
    ) selected_total on true
  ),
  total_consensus as (
    select
      bookmaker_totals.game_id,
      percentile_cont(0.5) within group (order by bookmaker_totals.total)::numeric as total,
      count(*)::integer as total_bookmaker_count
    from bookmaker_totals
    group by bookmaker_totals.game_id
  )
  select
    eligible_games.id as game_id,
    eligible_games.season,
    eligible_games.stage,
    eligible_games.week,
    eligible_games.game_date,
    eligible_games.game_timestamp,
    eligible_games.away_team_id,
    away_teams.name as away_team_name,
    eligible_games.home_team_id,
    home_teams.name as home_team_name,
    eligible_games.away_total as away_score,
    eligible_games.home_total as home_score,
    eligible_games.away_total + eligible_games.home_total as final_total,
    eligible_games.home_total - eligible_games.away_total as home_margin,
    spread_consensus.home_spread as closing_home_spread,
    spread_consensus.spread_bookmaker_count,
    case
      when spread_consensus.home_spread is null then null
      else eligible_games.home_total - eligible_games.away_total + spread_consensus.home_spread
    end as spread_delta,
    case
      when spread_consensus.home_spread is null then 'ungraded'
      when eligible_games.home_total - eligible_games.away_total + spread_consensus.home_spread > 0
        then 'home_cover'
      when eligible_games.home_total - eligible_games.away_total + spread_consensus.home_spread < 0
        then 'away_cover'
      else 'push'
    end as spread_result,
    total_consensus.total as closing_total,
    total_consensus.total_bookmaker_count,
    case
      when total_consensus.total is null then null
      else eligible_games.away_total + eligible_games.home_total - total_consensus.total
    end as total_delta,
    case
      when total_consensus.total is null then 'ungraded'
      when eligible_games.away_total + eligible_games.home_total > total_consensus.total then 'over'
      when eligible_games.away_total + eligible_games.home_total < total_consensus.total then 'under'
      else 'push'
    end as total_result
  from eligible_games
  join public.teams away_teams on away_teams.id = eligible_games.away_team_id
  join public.teams home_teams on home_teams.id = eligible_games.home_team_id
  left join spread_consensus on spread_consensus.game_id = eligible_games.id
  left join total_consensus on total_consensus.game_id = eligible_games.id
  order by eligible_games.game_timestamp desc, eligible_games.id desc;
$$;

revoke all on function public.get_game_consensus_odds(integer[]) from public;
grant execute on function public.get_game_consensus_odds(integer[]) to anon, authenticated, service_role;

revoke all on function public.get_game_betting_results(integer[]) from public;
grant execute on function public.get_game_betting_results(integer[]) to service_role;

comment on function public.get_game_consensus_odds(integer[]) is
  'Returns current consensus for requested games after reducing each bookmaker to its latest snapshot';

comment on function public.get_game_betting_results(integer[]) is
  'Returns graded requested games using index-driven latest valid pre-kickoff lines';
