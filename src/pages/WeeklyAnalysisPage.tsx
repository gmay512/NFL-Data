import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import {
  analyzeWeeklySuggestionLoss,
  deleteWeeklyAnalysisRun,
  deleteWeeklyLossAnalysis,
  getAnalyticsMetadata,
  getLlmHealth,
  gradeWeeklySuggestions,
  listWeeklySummaries,
  getWeeklyRun,
  postWeeklyAnalysisStream,
  readWeeklyAnalysisStream,
  refreshSeasonOdds,
} from '../api/app-api'
import type { WeeklyRunView } from '../api/contracts'
import type { WeeklyRunSummary, WeeklyRecord } from '../../server/weekly-analysis'
import { analyticsKey, invalidateAnalyticsReads, seedAnalyticsRead, useAnalyticsRead } from '../data/analytics-repository'
import { AnalyticsReadStatuses } from '../features/analytics/AnalyticsReadStatus'
import { AnalyticsModelHelp, AnalyticsModelStatus } from '../features/analytics/AnalyticsModelStatus'
import { AnalyticsNav } from '../features/analytics/AnalyticsNav'
import { StatusMessage } from '../features/dashboard/DashboardComponents'

type WeeklyRunGroup = {
  key: string
  label: string
  runs: WeeklyRunSummary[]
}

function groupKey(run: Pick<WeeklyRunSummary, 'season' | 'stage' | 'week'>) {
  return `${run.season}\u0000${run.stage ?? ''}\u0000${run.week}`
}

function isPreseason(stage: string | null) {
  return stage != null && /^pre[\s-]*season$/i.test(stage.trim())
}

function groupWeeklyRuns(runs: WeeklyRunSummary[]): WeeklyRunGroup[] {
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

function runRecord(run: WeeklyRunView) {
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

function pickSelection(pick: WeeklyRunView['suggestions'][number]) {
  if (pick.market === 'total') return `${pick.selection.toUpperCase()} ${pick.lockedLine}`
  const selectedTeam = pick.selection === 'home' ? pick.homeTeamName : pick.awayTeamName
  return `${selectedTeam} ${pick.lockedLine > 0 ? '+' : ''}${pick.lockedLine}`
}

export function WeeklyAnalysisPage() {
  const [searchParams, setSearchParams] = useSearchParams()
  const [olderPage, setOlderPage] = useState<{
    key: string; runs: WeeklyRunSummary[]; cursor: { createdAt: string; id: string } | null
  } | null>(null)
  const [loadingMoreKey, setLoadingMoreKey] = useState<string | null>(null)
  const [seasonOverride, setSeasonOverride] = useState<number | null>(null)
  const [isAnalyzing, setIsAnalyzing] = useState(false)
  const [analysisStatus, setAnalysisStatus] = useState('')
  const [isGrading, setIsGrading] = useState(false)
  const [gradingStatus, setGradingStatus] = useState<string | null>(null)
  const [isDeleting, setIsDeleting] = useState(false)
  const [analyzingLossId, setAnalyzingLossId] = useState<number | null>(null)
  const [deletingLossAnalysisId, setDeletingLossAnalysisId] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)
  const analysisController = useRef<AbortController | null>(null)
  const lossController = useRef<AbortController | null>(null)
  const paginationController = useRef<AbortController | null>(null)
  const isBusy = isAnalyzing || isGrading || isDeleting || analyzingLossId != null || deletingLossAnalysisId != null
  const selectedRunId = searchParams.get('run')
  const selectedWeekParam = searchParams.get('week')
  const metadataRead = useAnalyticsRead(analyticsKey('metadata', {}), (signal) => getAnalyticsMetadata(undefined, { signal }), 300_000)
  const currentSeason = seasonOverride ?? metadataRead.data?.selectedSeason ?? null
  const summaryKey = analyticsKey('weekly-summary', { season: currentSeason, week: selectedWeekParam })
  const summaryRead = useAnalyticsRead(summaryKey,
    (signal) => listWeeklySummaries({ season: currentSeason ?? undefined, week: selectedWeekParam ?? undefined }, { signal }))
  const healthRead = useAnalyticsRead('health', (signal) => getLlmHealth({ signal }), 5_000, { retainExpired: false })
  const cursor = olderPage?.key === summaryKey ? olderPage.cursor : undefined
  const isLoadingMore = loadingMoreKey === summaryKey
  const runs = useMemo(() => [...new Map([
    ...summaryRead.data?.runs ?? [], ...(olderPage?.key === summaryKey ? olderPage.runs : []),
  ].map((run) => [run.id, run])).values()], [summaryRead.data, olderPage, summaryKey])
  const hasCurrentSeasonMetadata = metadataRead.data?.selectedSeason != null
  const llmHealth = healthRead.data
  const isLoading = summaryRead.isLoading
  const effectiveSeason = currentSeason ?? metadataRead.data?.selectedSeason ?? summaryRead.data?.selectedSeason ?? null
  const detailId = selectedRunId ?? runs[0]?.id ?? null
  const detailRead = useAnalyticsRead(detailId ? analyticsKey('weekly-detail', { id: detailId }) : null,
    (signal) => getWeeklyRun(detailId!, { signal }))
  const currentSeasonRuns = useMemo(
    () => effectiveSeason == null
      ? []
      : runs
          .filter((run) => run.season === effectiveSeason && !isPreseason(run.stage))
          .sort((left, right) => right.createdAt.localeCompare(left.createdAt)),
    [effectiveSeason, runs],
  )
  const weekOptions = useMemo(
    () => summaryRead.data?.weeks ?? [...new Set(currentSeasonRuns.map((run) => run.week))],
    [currentSeasonRuns, summaryRead.data],
  )
  const detail = detailRead.data?.run
  const requestedRun = currentSeasonRuns.find((run) => run.id === selectedRunId)
    ?? (detail?.season === effectiveSeason && !isPreseason(detail.stage) ? detail : null)
  const selectedWeek = selectedWeekParam && weekOptions.includes(selectedWeekParam)
    ? selectedWeekParam
    : requestedRun?.week ?? weekOptions[0] ?? null
  const filteredRuns = useMemo(
    () => selectedWeek ? currentSeasonRuns.filter((run) => run.week === selectedWeek) : [],
    [currentSeasonRuns, selectedWeek],
  )
  const groups = useMemo(() => groupWeeklyRuns(filteredRuns), [filteredRuns])
  const selectedRun = detail?.season === effectiveSeason && detail.week === selectedWeek && !isPreseason(detail.stage) ? detail : null
  const finalRunId = filteredRuns.find((run) => run.isFinal)?.id ?? filteredRuns[0]?.id
  const isFinal = Boolean(selectedRun && (selectedRun.isFinal ?? finalRunId === selectedRun.id))
  const selectedRecord = selectedRun ? runRecord(selectedRun) : null
  const overallRecord: WeeklyRecord = summaryRead.data?.record ?? { wins: 0, losses: 0, pushes: 0, pending: 0 }

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
    paginationController.current?.abort()
    paginationController.current = null
    setLoadingMoreKey(null)
    setOlderPage(null)
  }

  useEffect(() => () => {
    analysisController.current?.abort()
    lossController.current?.abort()
    paginationController.current?.abort()
    analysisController.current = null
  }, [])

  useEffect(() => () => paginationController.current?.abort(), [summaryKey])

  useEffect(() => {
    if (isLoading) return
    if (selectedRunId && (detailRead.isLoading || detailRead.error)) return
    if (!filteredRuns.length && !requestedRun) {
      if (selectedRunId || selectedWeekParam) setSelection(selectedWeek, null)
      return
    }
    const id = requestedRun?.week === selectedWeek ? requestedRun.id : filteredRuns[0]?.id ?? null
    if (selectedWeekParam !== selectedWeek || selectedRunId !== id) {
      setSelection(selectedWeek, id)
    }
  }, [detailRead.error, detailRead.isLoading, filteredRuns, isLoading, requestedRun, selectedRunId, selectedWeek, selectedWeekParam, setSelection])

  const createAnalysis = async () => {
    if (!currentSeason) return
    const controller = new AbortController()
    analysisController.current = controller
    setIsAnalyzing(true)
    setAnalysisStatus('Refreshing odds…')
    setError(null)
    setGradingStatus(null)
    try {
      await refreshSeasonOdds(currentSeason, { signal: controller.signal })
      const stream = await postWeeklyAnalysisStream(currentSeason, controller.signal)
      let streamError: string | null = null
      const completed: { run: WeeklyRunView | null } = { run: null }
      await readWeeklyAnalysisStream(stream, (event) => {
        if (event.type === 'progress') setAnalysisStatus(event.message)
        if (event.type === 'complete') completed.run = event.run
        if (event.type === 'error') streamError = event.error
      }, controller.signal)
      if (streamError) throw new Error(streamError)
      if (!completed.run) throw new Error('Weekly analysis ended without a completed run.')
      await reloadRuns()
      const saved = completed.run
      const savedRecord = runRecord(saved)
      const nextSummaryKey = analyticsKey('weekly-summary', { season: currentSeason, week: saved.week })
      const previous = summaryRead.data
      seedAnalyticsRead(nextSummaryKey, {
        runs: [{
          id: saved.id, season: saved.season, stage: saved.stage, week: saved.week, model: saved.model,
          createdAt: saved.createdAt, picks: saved.suggestions.length, record: savedRecord, isFinal: true,
        }, ...previous?.runs.filter((run) => run.week === saved.week && run.id !== saved.id)
          .map((run) => groupKey(run) === groupKey(saved) ? { ...run, isFinal: false } : run) ?? []],
        weeks: [...new Set([saved.week, ...previous?.weeks ?? []])],
        total: (previous?.total ?? 0) + 1,
        selectedSeason: saved.season,
        next: selectedWeekParam === saved.week ? previous?.next ?? null : null,
        record: {
          wins: overallRecord.wins + savedRecord.wins, losses: overallRecord.losses + savedRecord.losses,
          pushes: overallRecord.pushes + savedRecord.pushes, pending: overallRecord.pending + savedRecord.pending,
        },
      })
      invalidateAnalyticsReads(nextSummaryKey, { preserveData: true })
      seedAnalyticsRead(analyticsKey('weekly-detail', { id: completed.run.id }), { run: { ...completed.run, isFinal: true } })
      setSelection(completed.run.week, completed.run.id)
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
    setGradingStatus(null)
    try {
      const result = await gradeWeeklySuggestions()
      await reloadRuns()
      setGradingStatus(result.graded
        ? `Graded ${result.graded} pick${result.graded === 1 ? '' : 's'} after refreshing ${result.refreshedGames} game${result.refreshedGames === 1 ? '' : 's'}.`
        : result.requestedGames
          ? `Refreshed ${result.refreshedGames} game${result.refreshedGames === 1 ? '' : 's'}, but no completed results were available yet.`
          : 'No pending picks have reached kickoff yet.')
    } catch (gradingError) {
      setError(gradingError instanceof Error ? gradingError.message : 'Could not grade completed picks.')
    } finally {
      setIsGrading(false)
    }
  }

  const analyzeLoss = async (suggestionId: number) => {
    const controller = new AbortController()
    lossController.current = controller
    setAnalyzingLossId(suggestionId)
    setError(null)
    setGradingStatus(null)
    try {
      const result = await analyzeWeeklySuggestionLoss(suggestionId, { signal: controller.signal })
      if (controller.signal.aborted) return
      if (selectedRun) seedAnalyticsRead(analyticsKey('weekly-detail', { id: selectedRun.id }), { run: {
        ...selectedRun, suggestions: selectedRun.suggestions.map((pick) =>
          pick.id === suggestionId ? { ...pick, lossAnalysis: result.analysis } : pick),
      } })
      await reloadRuns()
      setGradingStatus('The loss analysis was saved for this game.')
    } catch (analysisError) {
      if (!controller.signal.aborted) setError(analysisError instanceof Error ? analysisError.message : 'Could not analyze this loss.')
    } finally {
      setAnalyzingLossId(null)
    }
  }

  const removeLossAnalysis = async (analysisId: number, matchup: string) => {
    if (!window.confirm(`Delete the stored loss analysis for ${matchup}?`)) return
    setDeletingLossAnalysisId(analysisId)
    setError(null)
    setGradingStatus(null)
    try {
      await deleteWeeklyLossAnalysis(analysisId)
      if (selectedRun) seedAnalyticsRead(analyticsKey('weekly-detail', { id: selectedRun.id }), { run: {
        ...selectedRun, suggestions: selectedRun.suggestions.map((pick) =>
          pick.lossAnalysis?.id === analysisId ? { ...pick, lossAnalysis: null } : pick),
      } })
      await reloadRuns()
      setGradingStatus('The stored loss analysis was deleted.')
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : 'Could not delete this loss analysis.')
    } finally {
      setDeletingLossAnalysisId(null)
    }
  }

  const removeRun = async () => {
    if (!selectedRun || !window.confirm(`Delete the analysis from ${new Date(selectedRun.createdAt).toLocaleString()}?`)) return
    setIsDeleting(true)
    setError(null)
    setGradingStatus(null)
    const deletedGroupKey = groupKey(selectedRun)
    try {
      await deleteWeeklyAnalysisRun(selectedRun.id)
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : 'Could not delete weekly analysis.')
      setIsDeleting(false)
      return
    }

    const remaining = runs.filter((run) => run.id !== selectedRun.id)
    if (summaryRead.data) {
      const record = runRecord(selectedRun)
      const canSubtract = (['wins', 'losses', 'pushes', 'pending'] as const)
        .every((name) => overallRecord[name] >= record[name])
      seedAnalyticsRead(summaryKey, {
        ...summaryRead.data, runs: summaryRead.data.runs.filter((run) => run.id !== selectedRun.id),
        total: Math.max(0, summaryRead.data.total - 1),
        record: canSubtract ? {
          wins: overallRecord.wins - record.wins, losses: overallRecord.losses - record.losses,
          pushes: overallRecord.pushes - record.pushes, pending: overallRecord.pending - record.pending,
        } : summaryRead.data.record,
      })
      invalidateAnalyticsReads(summaryKey, { preserveData: true })
    }
    setOlderPage((current) => current ? { ...current, runs: current.runs.filter((run) => run.id !== selectedRun.id) } : null)
    const currentRemaining = remaining
        .filter((run) => run.season === effectiveSeason)
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

  const loadMore = async () => {
    const next = cursor === undefined ? summaryRead.data?.next : cursor
    if (!next || isLoadingMore) return
    const controller = new AbortController()
    paginationController.current = controller
    setLoadingMoreKey(summaryKey)
    try {
      const page = await listWeeklySummaries({
        season: currentSeason ?? undefined, week: selectedWeekParam ?? undefined, before: next,
      }, { signal: controller.signal })
      if (controller.signal.aborted) return
      setOlderPage((current) => ({
        key: summaryKey,
        runs: [...(current?.key === summaryKey ? current.runs : []), ...page.runs],
        cursor: page.next,
      }))
    } catch (loadError) {
      if (!controller.signal.aborted) setError(loadError instanceof Error ? loadError.message : 'Could not load older weekly analyses.')
    } finally {
      if (paginationController.current === controller) setLoadingMoreKey(null)
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
        <AnalyticsModelStatus health={llmHealth} checking={healthRead.isLoading} />
      </header>

      <section className="panel weekly-toolbar weekly-screen-only">
        <label>
          Analysis season
          <select value={effectiveSeason ?? ''} disabled={!effectiveSeason || isBusy} onChange={(event) => setSeasonOverride(Number(event.target.value))}>
            {effectiveSeason && <option value={effectiveSeason}>{effectiveSeason}</option>}
          </select>
        </label>
        <label>
          Week
          <select
            value={selectedWeek ?? ''}
            disabled={!weekOptions.length || isBusy}
            onChange={(event) => {
              const nextWeek = event.target.value
              setOlderPage(null)
              const nextRun = currentSeasonRuns.find((run) => run.week === nextWeek) ?? null
              setSelection(nextWeek || null, nextRun?.id ?? null)
            }}
          >
            {!weekOptions.length && <option value="">No saved weeks</option>}
            {weekOptions.map((week) => <option key={week} value={week}>{week}</option>)}
          </select>
        </label>
        <div className="weekly-actions">
          <button type="button" disabled={!currentSeason || !hasCurrentSeasonMetadata || isBusy || llmHealth?.status !== 'available'} onClick={() => void createAnalysis()}>
            {isAnalyzing ? analysisStatus || 'Analyzing…' : 'Analyze upcoming week'}
          </button>
          <button type="button" disabled={isBusy || overallRecord.pending === 0} onClick={() => void gradePicks()}>
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
      <div className="weekly-screen-only">
        <AnalyticsReadStatuses reads={[
          { title: 'Weekly analysis', error: summaryRead.error, refreshing: summaryRead.isRefreshing, retry: summaryRead.retry },
          { title: 'Selected analysis', error: detailRead.error, refreshing: detailRead.isRefreshing, retry: detailRead.retry },
          { title: 'Season metadata', error: metadataRead.error, refreshing: metadataRead.isRefreshing, retry: metadataRead.retry },
          { title: 'Local model', error: healthRead.error, retry: healthRead.retry },
        ]} />
      </div>
      {gradingStatus && <div className="weekly-screen-only"><StatusMessage title="Weekly grading complete" message={gradingStatus} /></div>}
      {isLoading && <div className="weekly-screen-only"><StatusMessage title="Loading weekly analyses" message="Loading saved model outputs and tracked picks." /></div>}

      {!isLoading && <section className="weekly-workspace">
        <aside className="panel weekly-run-browser weekly-screen-only">
          <div className="section-heading">
            <h2>Saved analyses</h2>
            <span>{summaryRead.data?.total ?? runs.length} total</span>
          </div>
          {groups.length ? groups.map((group) => (
            <section className="weekly-run-group" key={group.key}>
              <h3>{group.label}</h3>
              {group.runs.map((run) => {
                const record = run.record
                return (
                  <button
                    type="button"
                    className={`weekly-run-option ${selectedRun?.id === run.id ? 'is-active' : ''}`}
                    aria-pressed={selectedRun?.id === run.id}
                    disabled={isBusy}
                    key={run.id}
                    onClick={() => setSelection(run.week, run.id)}
                  >
                    <span>
                      <strong>{new Date(run.createdAt).toLocaleString()}</strong>
                      {run.id === finalRunId && <b className="final-badge">Final</b>}
                    </span>
                    <small>{run.picks} picks · {record.wins}-{record.losses}-{record.pushes} · {record.pending} pending</small>
                  </button>
                )
              })}
            </section>
          )) : <p className="empty-state">No upcoming-week analyses have been saved.</p>}
          {(cursor === undefined ? summaryRead.data?.next : cursor) && <button type="button" disabled={isLoadingMore} onClick={() => void loadMore()}>Load older analyses</button>}
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
                <button type="button" className="danger-button" disabled={isBusy} onClick={() => void removeRun()}>
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
                    {pick.supportingPoints ? (
                      <ul className="weekly-supporting-points" aria-label="Facts supporting this suggestion">
                        {pick.supportingPoints.map((point, index) => <li key={index}>{point.text}</li>)}
                      </ul>
                    ) : <p>{pick.rationale}</p>}
                    {pick.finalAwayScore != null && pick.finalHomeScore != null
                      ? <small>Final {pick.awayTeamName} {pick.finalAwayScore}, {pick.homeTeamName} {pick.finalHomeScore} · margin {signed(pick.resultDelta)}</small>
                      : <small>Kickoff {new Date(pick.kickoffAt).toLocaleString()}</small>}
                    {pick.result === 'loss' && !pick.lossAnalysis && (
                      <div className="weekly-loss-actions weekly-screen-only">
                        <button
                          type="button"
                          disabled={llmHealth?.status !== 'available' || isBusy}
                          onClick={() => void analyzeLoss(pick.id)}
                        >
                          {analyzingLossId === pick.id ? 'Analyzing…' : 'Analyze loss'}
                        </button>
                        <AnalyticsModelHelp health={llmHealth} checking={healthRead.isLoading}
                          unavailableMessage="Start the local LLM to analyze this loss." />
                      </div>
                    )}
                    {pick.lossAnalysis && (
                      <section className="weekly-loss-analysis" aria-label="Stored loss analysis">
                        <header>
                          <div>
                            <strong>Why this suggestion may have lost</strong>
                            <small>{pick.lossAnalysis.model} · {new Date(pick.lossAnalysis.createdAt).toLocaleString()}</small>
                          </div>
                          <button
                            type="button"
                            className="danger-button weekly-screen-only"
                            disabled={isBusy}
                            onClick={() => void removeLossAnalysis(
                              pick.lossAnalysis!.id,
                              `${pick.awayTeamName} at ${pick.homeTeamName}`,
                            )}
                          >
                            {deletingLossAnalysisId === pick.lossAnalysis.id ? 'Deleting…' : 'Delete loss analysis'}
                          </button>
                        </header>
                        <p>{pick.lossAnalysis.summary}</p>
                        <ol>
                          {pick.lossAnalysis.clues.map((clue, index) => (
                            <li key={`${clue.category}-${index}`}>
                              <strong>{clue.title}</strong>
                              <p>{clue.explanation}</p>
                              {clue.metricKeys.length > 0 && (
                                <ul>
                                  {clue.metricKeys.map((key) => {
                                    const metric = pick.lossAnalysis!.evidence.metrics[key]
                                    return <li key={key}>{metric.label}: <b>{metric.value}</b></li>
                                  })}
                                </ul>
                              )}
                            </li>
                          ))}
                        </ol>
                        {pick.lossAnalysis.missingMetrics.length > 0 && (
                          <details>
                            <summary>{pick.lossAnalysis.missingMetrics.length} unavailable metric{pick.lossAnalysis.missingMetrics.length === 1 ? '' : 's'}</summary>
                            <p>{pick.lossAnalysis.missingMetrics.join(', ')}</p>
                          </details>
                        )}
                      </section>
                    )}
                  </section>
                ))}
              </div> : <p className="empty-state">The model found no supported bets for this run.</p>}
              <p className="weekly-disclaimer">
                Lines shown are the consensus values locked when this analysis was generated. Model analysis is not betting advice.
              </p>
            </>
          ) : <p className="empty-state">{detailRead.isLoading ? 'Loading selected analysis...' : 'Select a saved analysis to view its output.'}</p>}
        </article>
      </section>}
    </main>
  )
}
