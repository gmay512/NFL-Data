import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import {
  deleteWeeklyAnalysisRun,
  getAnalyticsMetadata,
  getLlmHealth,
  gradeWeeklySuggestions,
  listWeeklyAnalysisRuns,
  postWeeklyAnalysisStream,
  readWeeklyAnalysisStream,
  refreshSeasonOdds,
} from '../api/app-api'
import type { LlmHealthResponse, WeeklyAnalysisRun } from '../api/contracts'
import { AnalyticsNav } from '../features/analytics/AnalyticsNav'
import { StatusMessage } from '../features/dashboard/DashboardComponents'

type WeeklyRunGroup = {
  key: string
  label: string
  runs: WeeklyAnalysisRun[]
}

function groupKey(run: WeeklyAnalysisRun) {
  return `${run.season}\u0000${run.stage ?? ''}\u0000${run.week}`
}

function isPreseason(stage: string | null) {
  return stage != null && /^pre[\s-]*season$/i.test(stage.trim())
}

function groupWeeklyRuns(runs: WeeklyAnalysisRun[]): WeeklyRunGroup[] {
  const groups = new Map<string, WeeklyRunGroup>()
  for (const run of [...runs].sort((left, right) => right.createdAt.localeCompare(left.createdAt))) {
    const key = groupKey(run)
    const group = groups.get(key) ?? {
      key,
      label: `${run.season} ${run.stage ?? 'Scheduled'} · ${run.week}`,
      runs: [],
    }
    group.runs.push(run)
    groups.set(key, group)
  }
  return [...groups.values()]
}

function runRecord(run: WeeklyAnalysisRun) {
  return {
    wins: run.suggestions.filter((pick) => pick.result === 'win').length,
    losses: run.suggestions.filter((pick) => pick.result === 'loss').length,
    pushes: run.suggestions.filter((pick) => pick.result === 'push').length,
    pending: run.suggestions.filter((pick) => pick.result === 'ungraded').length,
  }
}

function signed(value: number | null) {
  if (value == null) return '—'
  return `${value > 0 ? '+' : ''}${value}`
}

function pickSelection(pick: WeeklyAnalysisRun['suggestions'][number]) {
  if (pick.market === 'total') return `${pick.selection.toUpperCase()} ${pick.lockedLine}`
  const selectedTeam = pick.selection === 'home' ? pick.homeTeamName : pick.awayTeamName
  return `${selectedTeam} ${pick.lockedLine > 0 ? '+' : ''}${pick.lockedLine}`
}

export function WeeklyAnalysisPage() {
  const [searchParams, setSearchParams] = useSearchParams()
  const [runs, setRuns] = useState<WeeklyAnalysisRun[]>([])
  const [currentSeason, setCurrentSeason] = useState<number | null>(null)
  const [hasCurrentSeasonMetadata, setHasCurrentSeasonMetadata] = useState(false)
  const [llmHealth, setLlmHealth] = useState<LlmHealthResponse | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [isAnalyzing, setIsAnalyzing] = useState(false)
  const [analysisStatus, setAnalysisStatus] = useState('')
  const [isGrading, setIsGrading] = useState(false)
  const [isDeleting, setIsDeleting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const analysisController = useRef<AbortController | null>(null)
  const selectedRunId = searchParams.get('run')
  const selectedWeekParam = searchParams.get('week')
  const currentSeasonRuns = useMemo(
    () => currentSeason == null
      ? []
      : runs
          .filter((run) => run.season === currentSeason && !isPreseason(run.stage))
          .sort((left, right) => right.createdAt.localeCompare(left.createdAt)),
    [currentSeason, runs],
  )
  const weekOptions = useMemo(
    () => [...new Set(currentSeasonRuns.map((run) => run.week))],
    [currentSeasonRuns],
  )
  const requestedRun = currentSeasonRuns.find((run) => run.id === selectedRunId)
  const selectedWeek = selectedWeekParam && weekOptions.includes(selectedWeekParam)
    ? selectedWeekParam
    : requestedRun?.week ?? weekOptions[0] ?? null
  const filteredRuns = useMemo(
    () => selectedWeek ? currentSeasonRuns.filter((run) => run.week === selectedWeek) : [],
    [currentSeasonRuns, selectedWeek],
  )
  const groups = useMemo(() => groupWeeklyRuns(filteredRuns), [filteredRuns])
  const selectedRun = filteredRuns.find((run) => run.id === selectedRunId) ?? filteredRuns[0] ?? null
  const finalRunId = filteredRuns[0]?.id
  const isFinal = Boolean(selectedRun && finalRunId === selectedRun.id)
  const selectedRecord = selectedRun ? runRecord(selectedRun) : null
  const overallRecord = useMemo(() => {
    const suggestions = currentSeasonRuns.flatMap((run) => run.suggestions)
    return {
      wins: suggestions.filter((pick) => pick.result === 'win').length,
      losses: suggestions.filter((pick) => pick.result === 'loss').length,
      pushes: suggestions.filter((pick) => pick.result === 'push').length,
      pending: suggestions.filter((pick) => pick.result === 'ungraded').length,
    }
  }, [currentSeasonRuns])

  const setSelection = useCallback((week: string | null, id: string | null) => {
    setSearchParams((current) => {
      const next = new URLSearchParams(current)
      if (week) next.set('week', week)
      else next.delete('week')
      if (id) next.set('run', id)
      else next.delete('run')
      return next
    }, { replace: true })
  }, [setSearchParams])

  const reloadRuns = async () => {
    const payload = await listWeeklyAnalysisRuns()
    setRuns(payload.runs)
    return payload.runs
  }

  useEffect(() => {
    const controller = new AbortController()
    void Promise.allSettled([
      listWeeklyAnalysisRuns({ signal: controller.signal }),
      getAnalyticsMetadata(undefined, { signal: controller.signal }),
    ]).then(([weeklyResult, metadataResult]) => {
      if (controller.signal.aborted) return
      const loadedRuns = weeklyResult.status === 'fulfilled' ? weeklyResult.value.runs : []
      setRuns(loadedRuns)
      if (weeklyResult.status === 'rejected') {
        setError(weeklyResult.reason instanceof Error ? weeklyResult.reason.message : 'Could not load weekly analyses.')
      }
      if (metadataResult.status === 'fulfilled') {
        const current = metadataResult.value.selectedSeason
        const fallback = loadedRuns.length ? Math.max(...loadedRuns.map((run) => run.season)) : null
        setHasCurrentSeasonMetadata(current != null)
        setCurrentSeason(current ?? fallback)
        if (current == null) setError('The current season could not be identified. Saved analyses remain available, but new analysis is disabled.')
      } else {
        setHasCurrentSeasonMetadata(false)
        setCurrentSeason(loadedRuns.length ? Math.max(...loadedRuns.map((run) => run.season)) : null)
        setError(metadataResult.reason instanceof Error ? metadataResult.reason.message : 'Could not load the current season.')
      }
      setIsLoading(false)
    })
    void getLlmHealth({ signal: controller.signal }).then((health) => {
      setLlmHealth(health)
    }).catch((loadError) => {
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

  useEffect(() => () => {
    analysisController.current?.abort()
    analysisController.current = null
  }, [])

  useEffect(() => {
    if (isLoading) return
    if (!filteredRuns.length) {
      if (selectedRunId || selectedWeekParam) setSelection(selectedWeek, null)
      return
    }
    if (selectedWeekParam !== selectedWeek || selectedRunId !== selectedRun?.id) {
      setSelection(selectedWeek, selectedRun?.id ?? null)
    }
  }, [filteredRuns, isLoading, selectedRun, selectedRunId, selectedWeek, selectedWeekParam, setSelection])

  const createAnalysis = async () => {
    if (!currentSeason) return
    const controller = new AbortController()
    analysisController.current = controller
    setIsAnalyzing(true)
    setAnalysisStatus('Refreshing odds…')
    setError(null)
    try {
      await refreshSeasonOdds(currentSeason, { signal: controller.signal })
      const stream = await postWeeklyAnalysisStream(currentSeason, controller.signal)
      let streamError: string | null = null
      let completedRun: WeeklyAnalysisRun | null = null
      await readWeeklyAnalysisStream(stream, (event) => {
        if (event.type === 'progress') setAnalysisStatus(event.message)
        if (event.type === 'complete') completedRun = event.run
        if (event.type === 'error') streamError = event.error
      })
      if (streamError) throw new Error(streamError)
      if (!completedRun) throw new Error('Weekly analysis ended without a completed run.')
      await reloadRuns()
      setSelection((completedRun as WeeklyAnalysisRun).week, (completedRun as WeeklyAnalysisRun).id)
    } catch (analysisError) {
      if (!controller.signal.aborted) {
        setError(analysisError instanceof Error ? analysisError.message : 'Could not analyze the upcoming week.')
      }
    } finally {
      if (analysisController.current === controller) {
        analysisController.current = null
        setIsAnalyzing(false)
        setAnalysisStatus('')
      }
    }
  }

  const gradePicks = async () => {
    setIsGrading(true)
    setError(null)
    try {
      await gradeWeeklySuggestions()
      await reloadRuns()
    } catch (gradingError) {
      setError(gradingError instanceof Error ? gradingError.message : 'Could not grade completed picks.')
    } finally {
      setIsGrading(false)
    }
  }

  const removeRun = async () => {
    if (!selectedRun || !window.confirm(`Delete the analysis from ${new Date(selectedRun.createdAt).toLocaleString()}?`)) return
    setIsDeleting(true)
    setError(null)
    const deletedGroupKey = groupKey(selectedRun)
    try {
      await deleteWeeklyAnalysisRun(selectedRun.id)
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : 'Could not delete weekly analysis.')
      setIsDeleting(false)
      return
    }

    const remaining = runs.filter((run) => run.id !== selectedRun.id)
    setRuns(remaining)
    const currentRemaining = remaining
        .filter((run) => run.season === currentSeason)
        .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
    const fallback = currentRemaining.find((run) => groupKey(run) === deletedGroupKey) ?? currentRemaining[0] ?? null
    setSelection(fallback?.week ?? null, fallback?.id ?? null)
    try {
      await reloadRuns()
    } catch (reloadError) {
      setError(reloadError instanceof Error
        ? `Analysis deleted, but the saved list could not be refreshed: ${reloadError.message}`
        : 'Analysis deleted, but the saved list could not be refreshed.')
    } finally {
      setIsDeleting(false)
    }
  }

  return (
    <main className="analytics-page weekly-analysis-page">
      <AnalyticsNav />
      <header className="analytics-hero panel weekly-screen-only">
        <div>
          <p className="eyebrow">Weekly analysis</p>
          <h1>Upcoming-week picks</h1>
          <p>Compare saved model outputs, track results, and print a single selected analysis.</p>
        </div>
        <span className={`llm-status ${llmHealth?.status === 'available' ? 'is-online' : ''}`}>
          <i />{llmHealth?.status === 'available' ? llmHealth.model : 'Local LLM offline'}
        </span>
      </header>

      <section className="panel weekly-toolbar weekly-screen-only">
        <label>
          Analysis season
          <select value={currentSeason ?? ''} disabled={!currentSeason} onChange={(event) => setCurrentSeason(Number(event.target.value))}>
            {currentSeason && <option value={currentSeason}>{currentSeason}</option>}
          </select>
        </label>
        <label>
          Week
          <select
            value={selectedWeek ?? ''}
            disabled={!weekOptions.length}
            onChange={(event) => {
              const nextWeek = event.target.value
              const nextRun = currentSeasonRuns.find((run) => run.week === nextWeek) ?? null
              setSelection(nextWeek || null, nextRun?.id ?? null)
            }}
          >
            {!weekOptions.length && <option value="">No saved weeks</option>}
            {weekOptions.map((week) => <option key={week} value={week}>{week}</option>)}
          </select>
        </label>
        <div className="weekly-actions">
          <button type="button" disabled={!currentSeason || !hasCurrentSeasonMetadata || isAnalyzing || llmHealth?.status !== 'available'} onClick={() => void createAnalysis()}>
            {isAnalyzing ? analysisStatus || 'Analyzing…' : 'Analyze upcoming week'}
          </button>
          <button type="button" disabled={isGrading || overallRecord.pending === 0} onClick={() => void gradePicks()}>
            {isGrading ? 'Grading…' : 'Grade completed picks'}
          </button>
        </div>
        <div className="weekly-record" aria-label="Tracked suggestion record">
          <span><strong>{overallRecord.wins}</strong> wins</span>
          <span><strong>{overallRecord.losses}</strong> losses</span>
          <span><strong>{overallRecord.pushes}</strong> pushes</span>
          <span><strong>{overallRecord.pending}</strong> pending</span>
        </div>
      </section>

      {error && <div className="weekly-screen-only"><StatusMessage title="Weekly analysis error" message={error} error /></div>}
      {isLoading && <div className="weekly-screen-only"><StatusMessage title="Loading weekly analyses" message="Loading saved model outputs and tracked picks." /></div>}

      {!isLoading && <section className="weekly-workspace">
        <aside className="panel weekly-run-browser weekly-screen-only">
          <div className="section-heading">
            <h2>Saved analyses</h2>
            <span>{runs.length} total</span>
          </div>
          {groups.length ? groups.map((group) => (
            <section className="weekly-run-group" key={group.key}>
              <h3>{group.label}</h3>
              {group.runs.map((run) => {
                const record = runRecord(run)
                return (
                  <button
                    type="button"
                    className={`weekly-run-option ${selectedRun?.id === run.id ? 'is-active' : ''}`}
                    aria-pressed={selectedRun?.id === run.id}
                    key={run.id}
                    onClick={() => setSelection(run.week, run.id)}
                  >
                    <span>
                      <strong>{new Date(run.createdAt).toLocaleString()}</strong>
                      {run.id === finalRunId && <b className="final-badge">Final</b>}
                    </span>
                    <small>{run.suggestions.length} picks · {record.wins}-{record.losses}-{record.pushes} · {record.pending} pending</small>
                  </button>
                )
              })}
            </section>
          )) : <p className="empty-state">No upcoming-week analyses have been saved.</p>}
        </aside>

        <article className="panel weekly-run-detail weekly-print-area">
          {selectedRun && selectedRecord ? (
            <>
              <header className="weekly-run-detail-header">
                <div>
                  <p className="eyebrow">Selected analysis</p>
                  <h2>{selectedRun.season} {selectedRun.week}</h2>
                  <p>{selectedRun.stage ?? 'Scheduled'} · {new Date(selectedRun.createdAt).toLocaleString()} · {selectedRun.model}</p>
                </div>
                {isFinal && <span className="final-badge">Final analysis</span>}
              </header>
              <div className="weekly-detail-actions weekly-screen-only">
                <button type="button" onClick={() => window.print()}>Print analysis</button>
                <button type="button" className="danger-button" disabled={isDeleting} onClick={() => void removeRun()}>
                  {isDeleting ? 'Deleting…' : 'Delete analysis'}
                </button>
              </div>
              <div className="weekly-record" aria-label="Selected analysis record">
                <span><strong>{selectedRecord.wins}</strong> wins</span>
                <span><strong>{selectedRecord.losses}</strong> losses</span>
                <span><strong>{selectedRecord.pushes}</strong> pushes</span>
                <span><strong>{selectedRecord.pending}</strong> pending</span>
              </div>
              <p className="weekly-summary">{selectedRun.summary}</p>
              {selectedRun.suggestions.length ? <div className="weekly-picks">
                {selectedRun.suggestions.map((pick) => (
                  <section className="weekly-pick" key={pick.id}>
                    <div>
                      <strong>{pick.awayTeamName} at {pick.homeTeamName}</strong>
                      <small>{pickSelection(pick)} · {pick.confidence}% confidence</small>
                    </div>
                    <b className={`result-pill is-${pick.result}`}>{pick.result}</b>
                    <p>{pick.rationale}</p>
                    {pick.finalAwayScore != null && pick.finalHomeScore != null
                      ? <small>Final {pick.awayTeamName} {pick.finalAwayScore}, {pick.homeTeamName} {pick.finalHomeScore} · margin {signed(pick.resultDelta)}</small>
                      : <small>Kickoff {new Date(pick.kickoffAt).toLocaleString()}</small>}
                  </section>
                ))}
              </div> : <p className="empty-state">The model found no supported bets for this run.</p>}
              <p className="weekly-disclaimer">
                Lines shown are the consensus values locked when this analysis was generated. Model analysis is not betting advice.
              </p>
            </>
          ) : <p className="empty-state">Select a saved analysis to view its output.</p>}
        </article>
      </section>}
    </main>
  )
}
