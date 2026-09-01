import { useEffect, useMemo, useState } from 'react'
import type { FormEvent } from 'react'
import { useSearchParams } from 'react-router-dom'
import {
  deleteAnalysisSession,
  getAnalysisSession,
  getAnalyticsMetadata,
  getLlmHealth,
  listAnalysisSessions,
  postAnalysisFollowUp,
  queryAnalytics,
  readAnalysisStream,
  renameAnalysisSession,
  runAnalysis,
} from '../api/app-api'
import type {
  AnalysisSession,
  AnalysisSessionSummary,
  AnalyticsFilterMetadata,
  AnalyticsFilters,
  AnalyticsPreset,
  AnalyticsSnapshot,
  LlmHealthResponse,
} from '../api/contracts'
import { StatusMessage } from '../features/dashboard/DashboardComponents'

function numberParam(value: string | null) {
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined
}

function percent(value: number | null) {
  return value == null ? '—' : `${Math.round(value * 100)}%`
}

function signed(value: number | null) {
  if (value == null) return '—'
  return `${value > 0 ? '+' : ''}${value}`
}

function presetLabel(preset: AnalyticsPreset) {
  return {
    season_overview: 'Season overview',
    team_analysis: 'Team analysis',
    game_review: 'Game review',
    trend_comparison: 'Trend comparison',
  }[preset]
}

function defaultTitle(preset: AnalyticsPreset, filters: AnalyticsFilters, metadata: AnalyticsFilterMetadata | null) {
  const team = metadata?.teams.find((item) => item.id === filters.teamId)?.name
  const comparison = metadata?.teams.find((item) => item.id === filters.comparisonTeamId)?.name
  if (preset === 'game_review') return `${filters.season} game ${filters.gameId} review`
  if (preset === 'team_analysis') return `${filters.season} ${team ?? `team ${filters.teamId}`} analysis`
  if (preset === 'trend_comparison') return `${team ?? filters.teamId} vs ${comparison ?? filters.comparisonTeamId}`
  return `${filters.season} season overview`
}

function selectedPreset(filters: AnalyticsFilters): AnalyticsPreset {
  if (filters.gameId) return 'game_review'
  if (filters.teamId && filters.comparisonTeamId) return 'trend_comparison'
  if (filters.teamId) return 'team_analysis'
  return 'season_overview'
}

export function AnalyticsPage() {
  const [searchParams, setSearchParams] = useSearchParams()
  const [metadata, setMetadata] = useState<AnalyticsFilterMetadata | null>(null)
  const [snapshot, setSnapshot] = useState<AnalyticsSnapshot | null>(null)
  const [sessions, setSessions] = useState<AnalysisSessionSummary[]>([])
  const [activeSession, setActiveSession] = useState<AnalysisSession | null>(null)
  const [llmHealth, setLlmHealth] = useState<LlmHealthResponse | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [isAnalyzing, setIsAnalyzing] = useState(false)
  const [isStreaming, setIsStreaming] = useState(false)
  const [pendingAnswer, setPendingAnswer] = useState('')
  const [question, setQuestion] = useState('')
  const [lastQuestion, setLastQuestion] = useState('')
  const [streamController, setStreamController] = useState<AbortController | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [sort, setSort] = useState<{ field: 'date' | 'spread' | 'total'; direction: 1 | -1 }>({
    field: 'date',
    direction: -1,
  })

  const season = numberParam(searchParams.get('season'))
  const stage = searchParams.get('stage') || undefined
  const week = searchParams.get('week') || undefined
  const teamId = numberParam(searchParams.get('team'))
  const comparisonTeamId = teamId ? numberParam(searchParams.get('compare')) : undefined
  const gameId = numberParam(searchParams.get('game'))
  const filters = useMemo<AnalyticsFilters | null>(() => season ? {
    season,
    ...(stage ? { stage } : {}),
    ...(week ? { week } : {}),
    ...(teamId ? { teamId } : {}),
    ...(comparisonTeamId ? { comparisonTeamId } : {}),
    ...(gameId ? { gameId } : {}),
  } : null, [comparisonTeamId, gameId, season, stage, teamId, week])
  const preset = filters ? selectedPreset(filters) : 'season_overview'

  const setFilter = (name: string, value: string) => {
    const next = new URLSearchParams(searchParams)
    if (value) next.set(name, value)
    else next.delete(name)
    if (name === 'season') {
      next.delete('stage')
      next.delete('week')
      next.delete('game')
    }
    if (name === 'team' && !value) next.delete('compare')
    setSearchParams(next, { replace: true })
  }

  const reloadSessions = async () => {
    const payload = await listAnalysisSessions()
    setSessions(payload.sessions)
  }

  useEffect(() => {
    const controller = new AbortController()
    void Promise.all([
      getAnalyticsMetadata(season, { signal: controller.signal }),
      listAnalysisSessions({ signal: controller.signal }),
    ]).then(([nextMetadata, saved]) => {
      setMetadata(nextMetadata)
      setSessions(saved.sessions)
      if (!season && nextMetadata.selectedSeason) {
        setSearchParams((current) => {
          const next = new URLSearchParams(current)
          next.set('season', String(nextMetadata.selectedSeason))
          return next
        }, { replace: true })
      }
    }).catch((loadError) => {
      if (!controller.signal.aborted) setError(loadError instanceof Error ? loadError.message : 'Could not load analytics.')
    })
    return () => controller.abort()
  }, [season, setSearchParams])

  useEffect(() => {
    const controller = new AbortController()
    void getLlmHealth({ signal: controller.signal }).then(setLlmHealth).catch((loadError) => {
      if (!controller.signal.aborted) {
        setLlmHealth({
          status: 'unavailable',
          code: 'health_request_failed',
          message: loadError instanceof Error ? loadError.message : 'Could not check the local model.',
        })
      }
    })
    return () => controller.abort()
  }, [])

  useEffect(() => {
    if (!filters) return
    let cancelled = false
    void Promise.resolve().then(() => {
      if (cancelled) return null
      setIsLoading(true)
      setError(null)
      setSnapshot(null)
      return queryAnalytics(preset, filters)
    }).then((payload) => {
      if (!cancelled && payload) setSnapshot(payload.snapshot)
    }).catch((loadError) => {
      if (!cancelled) setError(loadError instanceof Error ? loadError.message : 'Could not calculate analytics.')
    }).finally(() => {
      if (!cancelled) setIsLoading(false)
    })
    return () => {
      cancelled = true
    }
  }, [filters, preset])

  const sortedGames = useMemo(() => {
    const games = [...(snapshot?.games.items ?? [])]
    return games.sort((left, right) => {
      const leftValue = sort.field === 'date' ? left.gameDate ?? '' : sort.field === 'spread' ? left.spreadDelta ?? -Infinity : left.totalDelta ?? -Infinity
      const rightValue = sort.field === 'date' ? right.gameDate ?? '' : sort.field === 'spread' ? right.spreadDelta ?? -Infinity : right.totalDelta ?? -Infinity
      return (leftValue < rightValue ? -1 : leftValue > rightValue ? 1 : left.gameId - right.gameId) * sort.direction
    })
  }, [snapshot, sort])

  const changeSort = (field: typeof sort.field) => {
    setSort((current) => current.field === field
      ? { field, direction: current.direction === 1 ? -1 : 1 }
      : { field, direction: -1 })
  }

  const createReport = async (requestedPreset: AnalyticsPreset) => {
    if (!filters) return
    setIsAnalyzing(true)
    setError(null)
    try {
      const payload = await runAnalysis(defaultTitle(requestedPreset, filters, metadata), requestedPreset, filters)
      setActiveSession(payload.session)
      await reloadSessions()
    } catch (analysisError) {
      setError(analysisError instanceof Error ? analysisError.message : 'Could not run local analysis.')
    } finally {
      setIsAnalyzing(false)
    }
  }

  const openSession = async (id: string) => {
    try {
      const payload = await getAnalysisSession(id)
      setActiveSession(payload.session)
      setPendingAnswer('')
      setError(null)
    } catch (sessionError) {
      setError(sessionError instanceof Error ? sessionError.message : 'Could not load analysis session.')
    }
  }

  const renameSession = async (session: AnalysisSessionSummary) => {
    const title = window.prompt('Analysis name', session.title)?.trim()
    if (!title || title === session.title) return
    try {
      await renameAnalysisSession(session.id, title)
      if (activeSession?.id === session.id) setActiveSession({ ...activeSession, title })
      await reloadSessions()
    } catch (renameError) {
      setError(renameError instanceof Error ? renameError.message : 'Could not rename analysis.')
    }
  }

  const removeSession = async (session: AnalysisSessionSummary) => {
    if (!window.confirm(`Delete "${session.title}"?`)) return
    try {
      await deleteAnalysisSession(session.id)
      if (activeSession?.id === session.id) setActiveSession(null)
      await reloadSessions()
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : 'Could not delete analysis.')
    }
  }

  const submitQuestion = async (event?: FormEvent, retryQuestion?: string) => {
    event?.preventDefault()
    if (!activeSession) return
    const nextQuestion = (retryQuestion ?? question).trim()
    if (!nextQuestion) return
    const controller = new AbortController()
    setStreamController(controller)
    setIsStreaming(true)
    setPendingAnswer('')
    setLastQuestion(nextQuestion)
    setQuestion('')
    setError(null)
    try {
      const stream = await postAnalysisFollowUp(activeSession.id, nextQuestion, controller.signal)
      let streamError: string | null = null
      await readAnalysisStream(stream, (streamEvent) => {
        if (streamEvent.type === 'content') setPendingAnswer((current) => current + streamEvent.content)
        if (streamEvent.type === 'error') streamError = streamEvent.error
      })
      if (streamError) throw new Error(streamError)
      const payload = await getAnalysisSession(activeSession.id)
      setActiveSession(payload.session)
      setPendingAnswer('')
      await reloadSessions()
    } catch (streamError) {
      if (!controller.signal.aborted) {
        setError(streamError instanceof Error ? streamError.message : 'The local analysis stream failed.')
      }
    } finally {
      setIsStreaming(false)
      setStreamController(null)
    }
  }

  const availablePresets: AnalyticsPreset[] = [
    'season_overview',
    ...(teamId ? ['team_analysis' as const] : []),
    ...(gameId ? ['game_review' as const] : []),
    ...(teamId && comparisonTeamId ? ['trend_comparison' as const] : []),
  ]

  return (
    <main className="analytics-page">
      <header className="analytics-hero panel">
        <div>
          <p className="eyebrow">Historical analytics</p>
          <h1>Lines, results, and grounded analysis</h1>
          <p>Review closing consensus spread and total outcomes. Figures are descriptive historical analysis, not betting advice.</p>
        </div>
        <span className={`llm-status ${llmHealth?.status === 'available' ? 'is-online' : ''}`}>
          <i />{llmHealth?.status === 'available' ? llmHealth.model : 'Local LLM offline'}
        </span>
      </header>

      <section className="analytics-filters panel" aria-label="Analytics filters">
        <label>Season<select value={season ?? ''} onChange={(event) => setFilter('season', event.target.value)}>
          {(metadata?.seasons ?? []).map((value) => <option key={value} value={value}>{value}</option>)}
        </select></label>
        <label>Stage<select value={stage ?? ''} onChange={(event) => setFilter('stage', event.target.value)}>
          <option value="">All stages</option>
          {(metadata?.stages ?? []).map((value) => <option key={value}>{value}</option>)}
        </select></label>
        <label>Week<select value={week ?? ''} onChange={(event) => setFilter('week', event.target.value)}>
          <option value="">All weeks</option>
          {(metadata?.weeks ?? []).map((value) => <option key={value}>{value}</option>)}
        </select></label>
        <label>Team<select value={teamId ?? ''} onChange={(event) => setFilter('team', event.target.value)}>
          <option value="">All teams</option>
          {(metadata?.teams ?? []).map((team) => <option key={team.id} value={team.id}>{team.name}</option>)}
        </select></label>
        <label>Compare<select disabled={!teamId} value={comparisonTeamId ?? ''} onChange={(event) => setFilter('compare', event.target.value)}>
          <option value="">No comparison</option>
          {(metadata?.teams ?? []).filter((team) => team.id !== teamId).map((team) => <option key={team.id} value={team.id}>{team.name}</option>)}
        </select></label>
        <label>Game ID<input type="number" min="1" value={gameId ?? ''} placeholder="All games" onChange={(event) => setFilter('game', event.target.value)} /></label>
      </section>

      {error && <StatusMessage title="Analytics error" message={error} error />}
      {isLoading && <StatusMessage title="Calculating analytics" message="Loading deterministic results and supporting context." />}
      {!isLoading && snapshot && (
        <>
          <section className="analytics-kpis">
            <article className="stat-card"><span className="stat-label">Completed games</span><p className="stat-value">{snapshot.summary.games}</p></article>
            <article className="stat-card"><span className="stat-label">Over rate</span><p className="stat-value">{percent(snapshot.summary.totals.overRate)}</p><small>{snapshot.summary.totals.overs}-{snapshot.summary.totals.unders}-{snapshot.summary.totals.pushes}</small></article>
            <article className="stat-card"><span className="stat-label">Home cover rate</span><p className="stat-value">{percent(snapshot.summary.spread.homeCoverRate)}</p><small>{snapshot.summary.spread.homeCovers} home / {snapshot.summary.spread.awayCovers} away</small></article>
            <article className="stat-card"><span className="stat-label">Ungraded lines</span><p className="stat-value">{snapshot.dataQuality.gamesMissingSpread + snapshot.dataQuality.gamesMissingTotal}</p><small>Spread + total</small></article>
          </section>

          <section className="analytics-grid">
            <article className="panel panel-wide">
              <div className="section-heading"><h2>Team trends</h2></div>
              {snapshot.teamTrends.items.length ? <div className="table-wrap"><table>
                <thead><tr><th>Team</th><th>ATS</th><th>ATS rate</th><th>O/U/P</th><th>Avg ATS delta</th></tr></thead>
                <tbody>{snapshot.teamTrends.items.map((team) => <tr key={team.teamId}>
                  <th>{team.teamName}</th><td>{team.atsWins}-{team.atsLosses}-{team.atsPushes}</td>
                  <td><span className="trend-bar"><i style={{ width: `${(team.atsWinRate ?? 0) * 100}%` }} /></span>{percent(team.atsWinRate)}</td>
                  <td>{team.overs}-{team.unders}-{team.totalPushes}</td><td>{signed(team.averageTeamSpreadDelta)}</td>
                </tr>)}</tbody>
              </table></div> : <p className="empty-state">No team trends match these filters.</p>}
            </article>

            <aside className="panel panel-wide analysis-actions">
              <div className="section-heading"><h2>Local analysis</h2></div>
              <p>Generate a saved explanation grounded in the metrics currently shown.</p>
              {availablePresets.map((item) => <button key={item} type="button" disabled={isAnalyzing || llmHealth?.status !== 'available'} onClick={() => void createReport(item)}>
                {isAnalyzing ? 'Analyzing…' : presetLabel(item)}
              </button>)}
              {llmHealth?.status !== 'available' && <small>Start llama-server to enable model analysis. Historical metrics remain available.</small>}
            </aside>
          </section>

          <section className="panel panel-wide">
            <div className="section-heading"><h2>Game results</h2><span>{snapshot.games.total} matching games{snapshot.games.truncated ? `; showing ${snapshot.games.included}` : ''}</span></div>
            {sortedGames.length ? <div className="table-wrap"><table className="analytics-results-table">
              <thead><tr>
                <th><button onClick={() => changeSort('date')}>Date</button></th><th>Matchup</th><th>Final</th><th>Closing spread</th>
                <th><button onClick={() => changeSort('spread')}>ATS result</button></th><th>Closing total</th><th><button onClick={() => changeSort('total')}>Total result</button></th>
              </tr></thead>
              <tbody>{sortedGames.map((game) => <tr key={game.gameId}>
                <td>{game.gameDate ?? '—'}</td><th>{game.awayTeamName} at {game.homeTeamName}<small>Game {game.gameId}</small></th>
                <td>{game.awayScore}-{game.homeScore}</td><td>{game.closingHomeSpread ?? '—'}</td>
                <td><b className={`result-pill is-${game.spreadResult}`}>{game.spreadResult.replace('_', ' ')}</b><small>{signed(game.spreadDelta)}</small></td>
                <td>{game.closingTotal ?? '—'}</td><td><b className={`result-pill is-${game.totalResult}`}>{game.totalResult}</b><small>{signed(game.totalDelta)}</small></td>
              </tr>)}</tbody>
            </table></div> : <p className="empty-state">No completed games match these filters.</p>}
          </section>
        </>
      )}

      <section className="analysis-workspace">
        <aside className="panel saved-analyses">
          <div className="section-heading"><h2>Saved analyses</h2></div>
          {sessions.length ? sessions.map((session) => <div className={`saved-analysis ${activeSession?.id === session.id ? 'is-active' : ''}`} key={session.id}>
            <button className="saved-analysis-open" type="button" onClick={() => void openSession(session.id)}>
              <strong>{session.title}</strong><small>{presetLabel(session.preset)} · {session.filters.season}</small>
            </button>
            <button type="button" aria-label={`Rename ${session.title}`} onClick={() => void renameSession(session)}>✎</button>
            <button type="button" aria-label={`Delete ${session.title}`} onClick={() => void removeSession(session)}>×</button>
          </div>) : <p className="empty-state">No saved analyses yet.</p>}
        </aside>

        <article className="panel analysis-chat">
          {activeSession ? <>
            <header><div><p className="eyebrow">{presetLabel(activeSession.preset)}</p><h2>{activeSession.title}</h2></div><span>{activeSession.model}</span></header>
            <div className="analysis-messages">
              {activeSession.messages.map((message) => <div className={`analysis-message is-${message.role}`} key={message.id}>
                <strong>{message.role === 'assistant' ? 'Local model' : 'You'}</strong><p>{message.content}</p>
              </div>)}
              {pendingAnswer && <div className="analysis-message is-assistant is-streaming"><strong>Local model</strong><p>{pendingAnswer}</p></div>}
            </div>
            <details className="grounding-details"><summary>Grounding details</summary><pre>{JSON.stringify({
              filters: activeSession.filters,
              generatedAt: activeSession.context.generatedAt,
              dataQuality: activeSession.context.dataQuality,
              truncation: {
                games: activeSession.context.games.truncated,
                playerStats: activeSession.context.playerStats.truncated,
                injuries: activeSession.context.currentInjuries.truncated,
              },
            }, null, 2)}</pre></details>
            <form className="analysis-chat-form" onSubmit={(event) => void submitQuestion(event)}>
              <textarea value={question} maxLength={4000} disabled={isStreaming} placeholder="Ask a follow-up grounded in this saved dataset…" onChange={(event) => setQuestion(event.target.value)} />
              <div>
                {isStreaming ? <button type="button" onClick={() => streamController?.abort()}>Stop</button> : <button type="submit" disabled={!question.trim() || llmHealth?.status !== 'available'}>Send</button>}
                {!isStreaming && error && lastQuestion && <button type="button" onClick={() => void submitQuestion(undefined, lastQuestion)}>Retry</button>}
              </div>
            </form>
          </> : <div className="analysis-chat-empty"><h2>Grounded conversation</h2><p>Open or generate a saved analysis to ask follow-up questions against its immutable data snapshot.</p></div>}
        </article>
      </section>
    </main>
  )
}
