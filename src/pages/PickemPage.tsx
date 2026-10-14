import { useCallback, useEffect, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import {
  getAnalyticsMetadata, getLlmHealth, getPickemWeek, getPickemWeeks, gradePickemWeek,
  postPickemStream, readPickemStream,
} from '../api/app-api'
import type { PickemAnalysis, PickemChange, PickemRecord, PickemWeek } from '../api/contracts'
import { analyticsKey, invalidateAnalyticsReads, seedAnalyticsRead, useAnalyticsRead } from '../data/analytics-repository'
import { AnalyticsModelHelp, AnalyticsModelStatus } from '../features/analytics/AnalyticsModelStatus'
import { AnalyticsNav } from '../features/analytics/AnalyticsNav'
import { AnalyticsReadStatuses } from '../features/analytics/AnalyticsReadStatus'

const emptyRecord: PickemRecord = { wins: 0, losses: 0, ties: 0, pending: 0, void: 0 }
function weekValue(week: PickemWeek) { return JSON.stringify([week.stage, week.week]) }
function date(value: string | null) { return value ? new Date(value).toLocaleString() : 'Date unavailable' }
function RecordDisplay({ record, label }: { record: PickemRecord; label: string }) {
  const decisions = record.wins + record.losses
  return <div className="weekly-record" aria-label={label}>
    <span><strong>{record.wins}</strong> wins</span><span><strong>{record.losses}</strong> losses</span>
    <span><strong>{record.ties}</strong> ties</span><span><strong>{record.pending}</strong> pending</span>
    {record.void > 0 && <span><strong>{record.void}</strong> void</span>}
    <span><strong>{decisions ? `${(record.wins / decisions * 100).toFixed(1)}%` : 'Not graded'}</strong> accuracy</span>
  </div>
}
function ChangeDisplay({ change }: { change: PickemChange }) {
  const before = change.before
  const after = change.after
  if (!before) return <p className="pickem-change">New prediction added.</p>
  if (!after) return <p className="pickem-change">Prediction removed from the active slate: {before.winnerTeamName} ({before.confidence}% confidence).</p>
  const pointsChanged = JSON.stringify(before.supportingPoints) !== JSON.stringify(after.supportingPoints)
  const risksChanged = JSON.stringify(before.risks) !== JSON.stringify(after.risks)
  const evidenceChanged = JSON.stringify(before.evidence) !== JSON.stringify(after.evidence)
  return <details className="pickem-change">
    <summary>Changed versus previous analysis</summary>
    {before.winnerTeamId !== after.winnerTeamId && <p>Winner: <del>{before.winnerTeamName}</del> → <strong>{after.winnerTeamName}</strong></p>}
    {before.confidence !== after.confidence && <p>Confidence: {before.confidence}% → {after.confidence}%</p>}
    {pointsChanged && <div><strong>Previous supporting factors</strong><ul>{before.supportingPoints.map((point, i) => <li key={i}>{point.text}</li>)}</ul></div>}
    {risksChanged && <div><strong>Previous risks</strong><ul>{before.risks.map((point, i) => <li key={i}>{point.text}</li>)}</ul></div>}
    {evidenceChanged && <div>
      <strong>Matchup evidence updated</strong>
      {before.evidence.spread !== after.evidence.spread && <p>Home spread: {String(before.evidence.spread ?? 'unavailable')} → {String(after.evidence.spread ?? 'unavailable')}</p>}
      {[...new Set([...Object.keys(before.evidence), ...Object.keys(after.evidence)])].filter((field) => field !== 'spread').filter((field) =>
        JSON.stringify(before.evidence[field]) !== JSON.stringify(after.evidence[field])).map((field) =>
        <details key={field}><summary>{field === 'performance' ? 'Team performance' : field} changed</summary>
          <p>Before</p><pre>{JSON.stringify(before.evidence[field], null, 2)}</pre>
          <p>After</p><pre>{JSON.stringify(after.evidence[field], null, 2)}</pre>
        </details>)}
    </div>}
  </details>
}

export function PickemPage() {
  const [params, setParams] = useSearchParams()
  const [analyzing, setAnalyzing] = useState(false)
  const [gradingKey, setGradingKey] = useState<string | null>(null)
  const [status, setStatus] = useState<{ key: string; message: string; error: boolean } | null>(null)
  const [progress, setProgress] = useState('')
  const analysisController = useRef<AbortController | null>(null)
  const gradeController = useRef<AbortController | null>(null)
  const explicitSeason = params.get('season') ? Number(params.get('season')) : undefined
  const metadata = useAnalyticsRead(analyticsKey('metadata', { season: explicitSeason }),
    (signal) => getAnalyticsMetadata(explicitSeason, { signal }), 300_000)
  const season = explicitSeason ?? metadata.data?.selectedSeason ?? null
  const weeks = useAnalyticsRead(season == null ? null : analyticsKey('pickem-weeks', { season }),
    (signal) => getPickemWeeks(season!, { signal }))
  const health = useAnalyticsRead('health', (signal) => getLlmHealth({ signal }), 5_000, { retainExpired: false })
  const weekParam = params.get('week')
  const stageParam = params.get('stage')
  const selected = weeks.data?.weeks.find((item) => weekParam
    ? item.week === weekParam && (stageParam == null || item.stage === stageParam)
    : item.week === weeks.data?.defaultWeek?.week && item.stage === weeks.data?.defaultWeek?.stage)
  const week: PickemWeek | null = selected ? { season: selected.season, stage: selected.stage, week: selected.week } : null
  const detailKey = week ? analyticsKey('pickem-week', week) : null
  const selectedStage = selected?.stage
  const selectedWeek = selected?.week
  const autoTargetsKey = JSON.stringify(week ? [
    week,
    ...weeks.data?.weeks.filter((item) => item.analysisId && weekValue(item) !== weekValue(week))
      .map((item) => ({ season: item.season, stage: item.stage, week: item.week })) ?? [],
  ] : [])
  const detail = useAnalyticsRead(detailKey, (signal) => getPickemWeek(week!, { signal }))
  const saved = detail.data?.analysis
  const grading = detailKey != null && gradingKey === detailKey
  const busy = analyzing || grading
  const activeStatus = status?.key === detailKey ? status : null

  const selectWeek = (next: PickemWeek) => setParams({
    season: String(next.season), stage: next.stage ?? '', week: next.week,
  }, { replace: true })

  const refreshResults = useCallback(async (targets: PickemWeek[], key: string, signal?: AbortSignal) => {
    setGradingKey(key)
    setStatus(null)
    try {
      let graded = 0
      const errors: string[] = []
      for (const target of targets) {
        signal?.throwIfAborted()
        const result = await gradePickemWeek(target, { signal })
        graded += result.graded
        if (result.refreshError) errors.push(result.refreshError)
      }
      if (signal?.aborted) return
      setStatus({
        key, message: errors.length ? errors.join(' ') : `${graded} completed prediction${graded === 1 ? '' : 's'} graded. Ties are excluded from win/loss accuracy.`,
        error: errors.length > 0,
      })
    } catch (error) {
      if (!signal?.aborted) setStatus({ key, message: error instanceof Error ? error.message : 'Could not refresh Pickem results.', error: true })
    } finally {
      if (!signal?.aborted) setGradingKey((current) => current === key ? null : current)
    }
  }, [])

  useEffect(() => {
    if (!detailKey || season == null || selectedStage == null || selectedWeek == null) return
    const controller = new AbortController()
    gradeController.current = controller
    const targets = JSON.parse(autoTargetsKey) as PickemWeek[]
    void Promise.resolve().then(() => {
      if (!controller.signal.aborted) return refreshResults(targets, detailKey, controller.signal)
    })
    return () => {
      controller.abort()
      if (gradeController.current === controller) gradeController.current = null
    }
  }, [detailKey, season, selectedStage, selectedWeek, autoTargetsKey, refreshResults])

  useEffect(() => () => {
    analysisController.current?.abort()
    gradeController.current?.abort()
  }, [])

  const generate = async () => {
    if (!week || !detailKey || !detail.data) return
    const controller = new AbortController()
    analysisController.current = controller
    setAnalyzing(true)
    setStatus(null)
    setProgress('Starting source refresh...')
    const key = detailKey
    const current = detail.data
    try {
      const stream = await postPickemStream(week, current.analysis?.revision ?? 0, controller.signal)
      const completed: { analysis: PickemAnalysis | null; error: string | null } = { analysis: null, error: null }
      await readPickemStream(stream, (event) => {
        if (event.type === 'progress') setProgress(event.message)
        if (event.type === 'complete') completed.analysis = event.analysis
        if (event.type === 'error') completed.error = event.error
      }, controller.signal)
      if (completed.error) throw new Error(completed.error)
      if (!completed.analysis) throw new Error('Pickem ended without a saved analysis.')
      const next = completed.analysis
      if (next.season !== week.season || next.stage !== week.stage || next.week !== week.week) {
        throw new Error('Pickem returned a completion for a different week. Reload the selected week.')
      }
      seedAnalyticsRead(key, {
        ...current, analysis: next,
        record: {
          wins: next.predictions.filter((pick) => pick.result === 'win').length,
          losses: next.predictions.filter((pick) => pick.result === 'loss').length,
          ties: next.predictions.filter((pick) => pick.result === 'tie').length,
          pending: next.predictions.filter((pick) => pick.result === 'pending').length,
          void: next.predictions.filter((pick) => pick.result === 'void').length,
        },
      })
      invalidateAnalyticsReads(key, { preserveData: true })
      setStatus({ key, message: next.summary, error: false })
    } catch (error) {
      setStatus({ key, message: controller.signal.aborted
        ? 'Analysis request cancelled. Reloading the week to confirm its saved state.'
        : error instanceof Error ? error.message : 'Pickem analysis failed.', error: !controller.signal.aborted })
    } finally {
      if (analysisController.current === controller) {
        analysisController.current = null
        setAnalyzing(false)
        setProgress('')
        invalidateAnalyticsReads(key, { preserveData: true })
        invalidateAnalyticsReads('overview', { preserveData: true })
        invalidateAnalyticsReads('metadata', { preserveData: true })
      }
    }
  }

  return <main className="analytics-page pickem-page">
    <section className="pickem-header">
      <div><p className="eyebrow">Analytics</p><h1>Pickem</h1><p>Local-model predictions for outright NFL winners, not against the spread.</p></div>
      <AnalyticsModelStatus health={health.data} checking={health.isLoading || health.isRefreshing} />
    </section>
    <AnalyticsNav />
    <AnalyticsModelHelp health={health.data} checking={health.isLoading || health.isRefreshing}
      unavailableMessage="Start the configured local LLM to generate predictions. Saved Pickem analyses remain available." />
    <section className="panel weekly-toolbar pickem-toolbar">
      <label>Season<select aria-label="Season" value={season ?? ''} disabled={busy || season == null}
        onChange={(event) => setParams({ season: event.target.value }, { replace: true })}>
        {season == null && <option value="">Loading seasons</option>}
        {[...new Set([...(metadata.data?.seasons ?? []), ...(season == null ? [] : [season])])].map((value) => <option key={value} value={value}>{value}</option>)}
      </select></label>
      <label>Week<select aria-label="Week" value={week ? weekValue(week) : ''} disabled={busy || !weeks.data?.weeks.length}
        onChange={(event) => {
          const next = weeks.data?.weeks.find((item) => weekValue(item) === event.target.value)
          if (next) selectWeek(next)
        }}>
        {!week && <option value="">{weeks.isLoading ? 'Loading weeks' : 'Select a week'}</option>}
        {weeks.data?.weeks.map((item) => <option key={weekValue(item)} value={weekValue(item)}>{item.stage} · {item.week}{item.analysisId ? ' · Saved' : ''}</option>)}
      </select></label>
      <div className="weekly-actions">
        <button type="button" onClick={() => void generate()}
          disabled={busy || health.data?.status !== 'available' || !detail.data?.games.some((game) => game.eligible)}>
          {analyzing ? 'Analyzing...' : saved ? 'Update analysis' : 'Generate analysis'}
        </button>
        {analyzing && <button type="button" onClick={() => analysisController.current?.abort()}>Cancel analysis</button>}
        <button type="button" disabled={busy || !week || !detailKey} onClick={() => {
          if (!week || !detailKey) return
          const controller = new AbortController()
          gradeController.current = controller
          void refreshResults([week], detailKey, controller.signal)
        }}>{grading ? 'Refreshing results...' : 'Refresh results'}</button>
      </div>
    </section>
    <section className="panel pickem-record-panel"><h2>Season record</h2>
      <RecordDisplay record={weeks.data?.record ?? emptyRecord} label="Pickem season record" />
    </section>
    <AnalyticsReadStatuses reads={[
      { title: 'Season metadata', error: metadata.error, refreshing: metadata.isRefreshing, retry: metadata.retry },
      { title: 'Pickem weeks', error: weeks.error, refreshing: weeks.isRefreshing, retry: weeks.retry },
      { title: 'Selected Pickem week', error: detail.error, refreshing: detail.isRefreshing, retry: detail.retry },
      { title: 'Local model', error: health.error, retry: health.retry },
    ]} />
    {analyzing && <p role="status">{progress} Previously saved predictions remain visible until the complete update is saved.</p>}
    {activeStatus && <p className={`status-message ${activeStatus.error ? 'is-error' : ''}`} role={activeStatus.error ? 'alert' : 'status'}>{activeStatus.message}</p>}
    {(weeks.isLoading || detail.isLoading) && <p role="status">Loading Pickem...</p>}
    {!weeks.isLoading && !week && <p className="empty-state">No matching regular-season or playoff week is available. Select a stored season/week or refresh its schedule from the dashboard.</p>}
    {detail.data && <section className="panel weekly-run-detail">
      <header><p className="eyebrow">{week?.stage}</p><h2>{week?.season} {week?.week}</h2>
        {saved ? <p>Created {date(saved.createdAt)} · Updated {date(saved.updatedAt)} · Revision {saved.revision}</p>
          : <p>No analysis saved for this week.</p>}
      </header>
      <RecordDisplay record={detail.data.record} label="Pickem weekly record" />
      <p className="weekly-disclaimer">Spreads inform the analysis only. Model confidence is uncalibrated, not a verified probability. Predictions and interpretations are uncertain. Ties and void games are excluded from accuracy.</p>
      {saved && <p className="weekly-summary">{saved.summary}</p>}
      <p className="weekly-disclaimer">Started-game picks are locked. Games without a saved pre-kickoff prediction are not scored as losses.</p>
      <div className="pickem-games">
        {detail.data.games.map((game) => {
          const pick = saved?.predictions.find((item) => item.gameId === game.gameId)
          const change = saved?.changes.find((item) => item.gameId === game.gameId)
          const winner = pick?.winnerTeamId === pick?.homeTeamId ? pick?.homeTeamName : pick?.awayTeamName
          const result = pick?.result ?? (game.status === 'CANC' ? 'Cancelled' : game.locked ? 'Not predicted before kickoff' : 'Not predicted')
          return <article className={`pickem-game ${change && saved!.revision > 1 ? 'has-changes' : ''}`} key={game.gameId}>
            <header><h3>{game.awayTeamName} at {game.homeTeamName}</h3><b className={`result-pill is-${pick?.result ?? 'ungraded'}`}>{result}</b></header>
            <p>{date(game.kickoffAt)} · {game.status ?? 'Schedule record unavailable'}{game.locked && pick ? ' · Pick locked' : ''}</p>
            <p>Current home spread (context only): {game.homeSpread == null ? 'Unavailable' : `${game.homeSpread > 0 ? '+' : ''}${game.homeSpread}`}</p>
            {pick && <>
              <p><strong>Outright winner: {winner}</strong> · {pick.confidence}% model confidence</p>
              <h4>Supporting factors</h4><ul aria-label="Supporting factors">{pick.supportingPoints.map((point, i) => <li key={i}>{point.text}</li>)}</ul>
              <h4>Risks and data gaps</h4><ul aria-label="Risks and data gaps">{pick.risks.map((point, i) => <li key={i}>{point.text}</li>)}</ul>
              {pick.dataWarnings.length > 0 && <div className="pickem-data-warnings"><h4>Source limitations</h4>
                <ul aria-label="Source limitations">{pick.dataWarnings.map((warning, i) => <li key={i}>{warning}</li>)}</ul>
              </div>}
              <small>Generated {date(pick.analyzedAt)} · {pick.model}{game.locked ? ' · Original prediction retained' : ''}</small>
              <p className="weekly-disclaimer">Sources refreshed {date(pick.sourceRefreshedAt)}. Provider observation times are not known for all sources.</p>
              {pick.finalAwayScore != null && pick.finalHomeScore != null && <p>Final: {pick.awayTeamName} {pick.finalAwayScore} — {pick.homeTeamName} {pick.finalHomeScore}</p>}
              {pick.result === 'pending' && game.status === null && <p>Source game unavailable; result cannot be graded.</p>}
            </>}
            {change && saved!.revision > 1 && <ChangeDisplay change={change} />}
          </article>
        })}
      </div>
      {saved && saved.revision > 1 && saved.changes.filter((change) => change.kind === 'removed'
        && !detail.data!.games.some((game) => game.gameId === change.gameId)).map((change) =>
        <ChangeDisplay key={change.gameId} change={change} />)}
    </section>}
  </main>
}
