import { memo, useEffect, useRef } from 'react'
import { Link } from 'react-router-dom'
import type { AnalysisSession } from '../../api/contracts'
import {
  formatScheduleGameDate,
  formatScheduleGameStatus,
  formatScore,
  formatScoringEventContext,
  formatScoringEventDescription,
  getGameAnalysisPreset,
  isWinningTeam,
} from '../../lib/game-format'
import type { GameAnalysisPreset } from '../../lib/game-format'
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
  onAnalyze,
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
  onAnalyze?: (preset: GameAnalysisPreset) => void
}) {
  const analysisPreset = getGameAnalysisPreset(game)

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
      {analysisPreset && onAnalyze && (
        <div className="schedule-game-actions">
          <button type="button" onClick={() => onAnalyze(analysisPreset)}>
            Analyze matchup
          </button>
        </div>
      )}
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

export function GameAnalysisModal({
  title,
  preset,
  session,
  isLoading,
  error,
  onClose,
  onRetry,
}: {
  title: string
  preset: GameAnalysisPreset
  session: AnalysisSession | null
  isLoading: boolean
  error: string | null
  onClose: () => void
  onRetry: () => void
}) {
  const dialogRef = useRef<HTMLElement>(null)
  const closeRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    closeRef.current?.focus()

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        onClose()
        return
      }
      if (event.key !== 'Tab' || !dialogRef.current) return

      const focusable = [...dialogRef.current.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
      )]
      if (!focusable.length) return
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }

    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('keydown', handleKeyDown)
      document.body.style.overflow = previousOverflow
      previouslyFocused?.focus()
    }
  }, [onClose])

  const answer = [...(session?.messages ?? [])].reverse().find((message) => message.role === 'assistant')

  return (
    <div
      className="game-analysis-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <article
        ref={dialogRef}
        className="game-analysis-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="game-analysis-title"
        aria-describedby="game-analysis-status"
      >
        <header>
          <div>
            <p className="eyebrow">{preset === 'game_review' ? 'Completed game review' : 'Pregame preview'}</p>
            <h2 id="game-analysis-title">{title}</h2>
          </div>
          <button ref={closeRef} className="game-analysis-close" type="button" aria-label="Close matchup analysis" onClick={onClose}>×</button>
        </header>

        <div className="game-analysis-content" id="game-analysis-status" aria-live="polite">
          {isLoading && (
            <div className="game-analysis-loading">
              <span aria-hidden="true" />
              <strong>Analyzing matchup…</strong>
              <p>Building a grounded snapshot and waiting for the local model.</p>
            </div>
          )}
          {!isLoading && error && (
            <div className="game-analysis-error">
              <strong>Analysis failed</strong>
              <p>{error}</p>
              <button type="button" onClick={onRetry}>Retry analysis</button>
            </div>
          )}
          {!isLoading && !error && answer && (
            <div className="game-analysis-answer">
              <p>{answer.content}</p>
              <small>Generated by {session?.model}. Descriptive analysis only; not betting or financial advice.</small>
            </div>
          )}
        </div>

        {session && !isLoading && !error && (
          <footer>
            <Link to={`/analytics?session=${encodeURIComponent(session.id)}`}>Open full conversation</Link>
            <button type="button" onClick={onClose}>Close</button>
          </footer>
        )}
      </article>
    </div>
  )
}

export function StatusMessage({ title, message, error = false }: { title: string; message: string; error?: boolean }) {
  return (
    <section className={`status-message ${error ? 'is-error' : ''}`}>
      <strong>{title}</strong>
      <span>{message}</span>
    </section>
  )
}
