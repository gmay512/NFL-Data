import { memo } from 'react'
import { Link } from 'react-router-dom'
import {
  formatScheduleGameDate,
  formatScheduleGameStatus,
  formatScore,
  formatScoringEventContext,
  formatScoringEventDescription,
  isWinningTeam,
} from '../../lib/game-format'
import type { GameOddsRow, GameRow, GameTeamStatRow, LatestGameEventRow, TeamRow } from '../../types/nfl'
import { GameOddsDisplay } from '../odds/GameOddsDisplay'

function TeamMark({ team, fallback }: { team?: TeamRow; fallback: string }) {
  return <span className="team-mark">{team?.logo_url ? <img src={team.logo_url} alt="" /> : fallback}</span>
}

export const ScheduleGameCard = memo(function ScheduleGameCard({
  game,
  awayTeam,
  homeTeam,
  teamId,
  stats,
  dashboardPath,
  isUpdated = false,
  latestEvent,
  odds,
}: {
  game: GameRow
  awayTeam?: TeamRow
  homeTeam?: TeamRow
  teamId?: number
  stats?: GameTeamStatRow
  dashboardPath: string
  isUpdated?: boolean
  latestEvent?: LatestGameEventRow
  odds?: GameOddsRow
}) {
  return (
    <article className={`schedule-game ${teamId ? 'has-team-stats' : ''} ${isUpdated ? 'is-updated' : ''}`}>
      <Link className="schedule-game-details" to={`/games/${game.id}`} state={{ dashboardPath }}>
        <div className="schedule-game-meta">
          <span>{[game.stage, game.week, formatScheduleGameStatus(game)].filter(Boolean).join(' · ')}</span>
          <time>{formatScheduleGameDate(game)}</time>
        </div>
        <div className="schedule-matchup">
          <div className={`schedule-team ${isWinningTeam(game, 'away') ? 'is-winner' : ''}`}>
            <TeamMark team={awayTeam} fallback="A" />
            <div className="schedule-team-name">
              <span>Away</span>
              <strong>{awayTeam?.name ?? `Away team ${game.away_team_id ?? ''}`}</strong>
            </div>
            <b>{formatScore(game.away_total)}</b>
          </div>
          <div className={`schedule-team schedule-team-home ${isWinningTeam(game, 'home') ? 'is-winner' : ''}`}>
            <TeamMark team={homeTeam} fallback="H" />
            <div className="schedule-team-name">
              <span>Home</span>
              <strong>{homeTeam?.name ?? `Home team ${game.home_team_id ?? ''}`}</strong>
            </div>
            <b>{formatScore(game.home_total)}</b>
          </div>
        </div>
        <GameOddsDisplay
          odds={odds}
          awayTeamName={awayTeam?.name}
          homeTeamName={homeTeam?.name}
        />
        {latestEvent && (
          <div className="live-game-event">
            <div className="live-game-event-heading">
              <span>Latest scoring play</span>
              <small>{formatScoringEventContext(latestEvent)}</small>
            </div>
            <p>{formatScoringEventDescription(latestEvent)}</p>
          </div>
        )}
        <span className="game-chevron" aria-hidden="true">›</span>
      </Link>
      {teamId && (
        <div className="team-game-stats">
          <div className="team-game-stat-summary">
            <span><b>{formatScore(stats?.yards_total)}</b> yards</span>
            <span><b>{formatScore(stats?.pass_yards)}</b> passing</span>
            <span><b>{formatScore(stats?.rush_yards)}</b> rushing</span>
            <span><b>{formatScore(stats?.turnovers_total)}</b> turnovers</span>
          </div>
          <Link className="team-game-stats-link" to={`/games/${game.id}/teams/${teamId}`} state={{ dashboardPath }}>
            View all stats
          </Link>
        </div>
      )}
    </article>
  )
})

export function StatusMessage({ title, message, error = false }: { title: string; message: string; error?: boolean }) {
  return (
    <section className={`status-message ${error ? 'is-error' : ''}`}>
      <strong>{title}</strong>
      <span>{message}</span>
    </section>
  )
}
