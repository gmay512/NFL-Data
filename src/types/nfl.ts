export type TeamRow = {
  id: number
  name: string
  code: string | null
  city: string | null
  coach: string | null
  owner: string | null
  stadium: string | null
  established: number | null
  logo_url: string | null
  country_name: string | null
  country_code: string | null
  country_flag_url: string | null
  created_at: string
}

export type PlayerRow = {
  id: number
  name: string
  age: number | null
  height: string | null
  weight: string | null
  college: string | null
  position_group: string | null
  position: string | null
  jersey_number: number | null
  salary_bracket: string | null
  experience_years: number | null
  image_url: string | null
  created_at: string
}

export type GameRow = {
  id: number
  season: number | null
  league_id: number | null
  stage: string | null
  week: string | null
  home_team_id: number | null
  away_team_id: number | null
  game_date: string | null
  date_timezone: string | null
  game_time: string | null
  game_timestamp: number | null
  venue_name: string | null
  venue_city: string | null
  status_short: string | null
  status_long: string | null
  status_timer: string | null
  home_q1: number | null
  home_q2: number | null
  home_q3: number | null
  home_q4: number | null
  home_ot: number | null
  home_total: number | null
  away_q1: number | null
  away_q2: number | null
  away_q3: number | null
  away_q4: number | null
  away_ot: number | null
  away_total: number | null
  venue: string | null
  created_at: string
}

export type GameEventRow = {
  id: number
  game_id: number
  team_id: number
  player_id: number | null
  quarter: string
  minute: string | null
  event_type: string
  comment: string | null
  score_home: number | null
  score_away: number | null
  created_at: string
}

export type LatestGameEventRow = Omit<GameEventRow, 'created_at' | 'id'>

export type LeagueRow = {
  id: number
  name: string
  logo_url: string | null
  country_name: string | null
  country_code: string | null
  country_flag_url: string | null
  created_at: string
}

export type LeagueSeasonRow = {
  id: number
  league_id: number
  season_year: number
  start_date: string | null
  end_date: string | null
  is_current: boolean
  cov_games_events: boolean | null
  cov_stats_teams: boolean | null
  cov_stats_players: boolean | null
  cov_season_players: boolean | null
  cov_players: boolean | null
  cov_injuries: boolean | null
  cov_standings: boolean | null
  created_at: string
}

export type InjuryRow = {
  id: number
  player_id: number
  team_id: number | null
  injury_date: string | null
  status: string | null
  description: string | null
  created_at: string
}

export type PlayerSeasonStatRow = {
  id: number
  player_id: number
  team_id: number
  season: number
  stat_group: string
  stat_name: string
  stat_value: string | null
  created_at: string
}

export type StandingRow = {
  id: number
  league_id: number
  season: number
  team_id: number
  conference: string | null
  division: string | null
  position: number | null
  won: number
  lost: number
  ties: number
  points_for: number | null
  points_against: number | null
  points_diff: number | null
  record_home: string | null
  record_road: string | null
  record_conference: string | null
  record_division: string | null
  streak: string | null
  created_at: string
}

export type GameTeamStatRow = {
  id: number
  game_id: number
  team_id: number
  fd_total: number | null
  fd_passing: number | null
  fd_rushing: number | null
  fd_penalties: number | null
  third_down_eff: string | null
  fourth_down_eff: string | null
  plays_total: number | null
  yards_total: number | null
  yards_per_play: string | null
  total_drives: string | null
  pass_yards: number | null
  pass_comp_att: string | null
  pass_yards_per: string | null
  pass_int: number | null
  sacks_yards_lost: string | null
  rush_yards: number | null
  rush_attempts: number | null
  rush_yards_per: string | null
  red_zone: string | null
  penalties: string | null
  turnovers_total: number | null
  fumbles_lost: number | null
  int_turnovers: number | null
  possession: string | null
  def_interceptions: number | null
  fumbles_recovered: number | null
  sacks: number | null
  safeties: number | null
  int_touchdowns: number | null
  points_against: number | null
  created_at: string
}

export type GamePlayerStatRow = {
  id: number
  game_id: number
  team_id: number
  player_id: number
  stat_group: string
  stat_name: string
  stat_value: string | null
  created_at: string
}

export type BookmakerRow = {
  id: number
  name: string
}

export type BetTypeRow = {
  id: number
  name: string
}

export type OddsRow = {
  id: number
  game_id: number
  bookmaker_id: number
  bet_id: number
  bet_value: string
  odd: number | null
}
