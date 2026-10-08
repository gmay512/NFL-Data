import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { FormEvent, MouseEvent } from 'react'
import { useLocation, useSearchParams } from 'react-router-dom'
import {
  deleteAnalysisSession,
  getAnalysisSession,
  getAnalyticsMetadata,
  getLlmHealth,
  listAnalysisSessionPage,
  postAnalysisFollowUp,
  queryAnalyticsOverview,
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
} from '../api/contracts'
import { analyticsKey, invalidateAnalyticsReads, useAnalyticsRead } from '../data/analytics-repository'
import { AnalyticsReadStatuses } from '../features/analytics/AnalyticsReadStatus'
import { AnalyticsModelHelp, AnalyticsModelStatus } from '../features/analytics/AnalyticsModelStatus'
import { AnalyticsNav } from '../features/analytics/AnalyticsNav'
import { AnalyticsGroundingDetails } from '../features/analytics/AnalyticsGroundingDetails'
import { AnalyticsReportContent } from '../features/analytics/AnalyticsReportContent'
import { AnalyticsPrintButton } from '../features/analytics/AnalyticsPrintButton'
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
    matchup_preview: 'Matchup preview',
    trend_comparison: 'Trend comparison',
  }[preset]
}

function defaultTitle(preset: AnalyticsPreset, filters: AnalyticsFilters, metadata: AnalyticsFilterMetadata | null) {
  const team = metadata?.teams.find((item) => item.id === filters.teamId)?.name
  const comparison = metadata?.teams.find((item) => item.id === filters.comparisonTeamId)?.name
  if (preset === 'game_review') return `${filters.season} game ${filters.gameId} review`
  if (preset === 'matchup_preview') return `${filters.season} game ${filters.gameId} preview`
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

type SortDirection = 1 | -1
type TeamSortField = 'team' | 'ats' | 'atsRate' | 'totals' | 'averageSpreadDelta'
type GameSortField = 'date' | 'matchup' | 'final' | 'closingSpread' | 'spreadResult' | 'closingTotal' | 'totalResult'
type TeamTrend = AnalyticsSnapshot['teamTrends']['items'][number]
type GameResult = AnalyticsSnapshot['games']['items'][number]

function compareValues(left: string | number | null, right: string | number | null, direction: SortDirection) {
  if (left == null) return right == null ? 0 : 1
  if (right == null) return -1
  return (typeof left === 'string'
    ? left.localeCompare(String(right))
    : left - Number(right)) * direction
}

function compareTeamTrends(left: TeamTrend, right: TeamTrend, field: TeamSortField, direction: SortDirection) {
  const values: Record<TeamSortField, [string | number | null, string | number | null]> = {
    team: [left.teamName, right.teamName],
    ats: [left.atsWins - left.atsLosses, right.atsWins - right.atsLosses],
    atsRate: [left.atsWinRate, right.atsWinRate],
    totals: [left.overs - left.unders, right.overs - right.unders],
    averageSpreadDelta: [left.averageTeamSpreadDelta, right.averageTeamSpreadDelta],
  }
  return compareValues(...values[field], direction) || left.teamId - right.teamId
}

function compareGames(left: GameResult, right: GameResult, field: GameSortField, direction: SortDirection) {
  const values: Record<GameSortField, [string | number | null, string | number | null]> = {
    date: [left.gameDate, right.gameDate],
    matchup: [`${left.awayTeamName} at ${left.homeTeamName}`, `${right.awayTeamName} at ${right.homeTeamName}`],
    final: [left.finalTotal, right.finalTotal],
    closingSpread: [left.closingHomeSpread, right.closingHomeSpread],
    spreadResult: [left.spreadDelta, right.spreadDelta],
    closingTotal: [left.closingTotal, right.closingTotal],
    totalResult: [left.totalDelta, right.totalDelta],
  }
  return compareValues(...values[field], direction) || left.gameId - right.gameId
}

export function AnalyticsPage() {
  const [searchParams, setSearchParams] = useSearchParams()
  const location = useLocation()
  const [olderSessions, setOlderSessions] = useState<AnalysisSessionSummary[]>([])
  const [sessionCursor, setSessionCursor] = useState<{ updatedAt: string; id: string } | null | undefined>()
  const [isLoadingMore, setIsLoadingMore] = useState(false)
  const [activeSession, setActiveSession] = useState<AnalysisSession | null>(null)
  const [isAnalyzing, setIsAnalyzing] = useState(false)
  const [isStreaming, setIsStreaming] = useState(false)
  const [pendingAnswer, setPendingAnswer] = useState('')
  const [answerSaved, setAnswerSaved] = useState(false)
  const [question, setQuestion] = useState('')
  const [lastQuestion, setLastQuestion] = useState('')
  const [canRetryQuestion, setCanRetryQuestion] = useState(false)
  const [streamController, setStreamController] = useState<AbortController | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [conversationError, setConversationError] = useState<string | null>(null)
  const [isLoadingMessages, setIsLoadingMessages] = useState(false)
  const [isOpeningSession, setIsOpeningSession] = useState(false)
  const [requestedSessionId, setRequestedSessionId] = useState<string | null>(null)
  const sessionController = useRef<AbortController | null>(null)
  const reportController = useRef<AbortController | null>(null)
  const streamingController = useRef<AbortController | null>(null)
  const messagesController = useRef<AbortController | null>(null)
  const paginationController = useRef<AbortController | null>(null)
  const sessionGeneration = useRef(0)
  const [gameDraft, setGameDraft] = useState<{ locationKey: string; value: string } | null>(null)
  const gameInput = gameDraft?.locationKey === location.key ? gameDraft.value : searchParams.get('game') ?? ''
  const [teamSort, setTeamSort] = useState<{ field: TeamSortField; direction: SortDirection }>({
    field: 'team',
    direction: 1,
  })
  const [gameSort, setGameSort] = useState<{ field: GameSortField; direction: SortDirection }>({
    field: 'date',
    direction: -1,
  })

  const season = numberParam(searchParams.get('season'))
  const stage = searchParams.get('stage') || undefined
  const week = searchParams.get('week') || undefined
  const teamId = numberParam(searchParams.get('team'))
  const comparisonTeamId = teamId ? numberParam(searchParams.get('compare')) : undefined
  const gameId = numberParam(searchParams.get('game'))
  const linkedSessionId = searchParams.get('session')
  const filters = useMemo<AnalyticsFilters | null>(() => season ? {
    season,
    ...(stage ? { stage } : {}),
    ...(week ? { week } : {}),
    ...(teamId ? { teamId } : {}),
    ...(comparisonTeamId ? { comparisonTeamId } : {}),
    ...(gameId ? { gameId } : {}),
  } : null, [comparisonTeamId, gameId, season, stage, teamId, week])
  const preset = filters ? selectedPreset(filters) : 'season_overview'
  const metadataRead = useAnalyticsRead(analyticsKey('metadata', { season }),
    (signal) => getAnalyticsMetadata(season, { signal }), 300_000)
  const sessionsRead = useAnalyticsRead('sessions:initial', (signal) => listAnalysisSessionPage(undefined, { signal }))
  const overviewRead = useAnalyticsRead(filters ? analyticsKey('overview', { ...filters, preset }) : null,
    (signal) => queryAnalyticsOverview(preset, filters!, { signal }))
  const healthRead = useAnalyticsRead('health', (signal) => getLlmHealth({ signal }), 5_000, { retainExpired: false })
  const metadata = metadataRead.data
  const sessions = [...new Map([...sessionsRead.data?.sessions ?? [], ...olderSessions]
    .map((session) => [session.id, session])).values()]
  const snapshot = overviewRead.data?.snapshot ?? null
  const llmHealth = healthRead.data
  const isLoading = filters ? overviewRead.isLoading : metadataRead.isLoading

  const setFilter = (name: string, value: string) => {
    const next = new URLSearchParams(searchParams)
    if (name !== 'season' && gameDraft?.locationKey === location.key) {
      if (gameDraft.value) next.set('game', gameDraft.value)
      else next.delete('game')
      setGameDraft(null)
    }
    if (value) next.set(name, value)
    else next.delete(name)
    if (name === 'season') {
      setGameDraft(null)
      next.delete('stage')
      next.delete('week')
      next.delete('game')
    }
    if (name === 'team' && !value) next.delete('compare')
    setSearchParams(next, { replace: true })
  }

  const reloadSessions = async () => {
    paginationController.current?.abort()
    paginationController.current = null
    setIsLoadingMore(false)
    setOlderSessions([])
    setSessionCursor(undefined)
    invalidateAnalyticsReads('sessions', { preserveData: true })
  }

  useEffect(() => {
      if (!season && metadata?.selectedSeason) {
        setSearchParams((current) => {
          const next = new URLSearchParams(current)
          next.set('season', String(metadata.selectedSeason))
          return next
        }, { replace: true })
      }
  }, [metadata, season, setSearchParams])

  useEffect(() => {
    if (gameInput === (searchParams.get('game') ?? '')) return
    const timer = window.setTimeout(() => {
      setSearchParams((current) => {
        const next = new URLSearchParams(current)
        if (gameInput) next.set('game', gameInput)
        else next.delete('game')
        return next
      }, { replace: true })
      setGameDraft(null)
    }, 300)
    return () => window.clearTimeout(timer)
  }, [gameInput, searchParams, setSearchParams])

  useEffect(() => () => {
    sessionGeneration.current++
    sessionController.current?.abort()
    reportController.current?.abort()
    streamingController.current?.abort()
    messagesController.current?.abort()
    paginationController.current?.abort()
  }, [])

  useEffect(() => {
    if (!linkedSessionId) return
    sessionController.current?.abort()
    streamingController.current?.abort()
    messagesController.current?.abort()
    reportController.current?.abort()
    sessionGeneration.current++
    const controller = new AbortController()
    sessionController.current = controller
    void Promise.resolve().then(async () => {
      if (controller.signal.aborted) return
      setRequestedSessionId(linkedSessionId)
      setIsOpeningSession(true)
      setIsAnalyzing(false)
      setIsStreaming(false)
      setStreamController(null)
      setActiveSession(null)
      setPendingAnswer('')
      setAnswerSaved(false)
      setLastQuestion('')
      setCanRetryQuestion(false)
      setConversationError(null)
      messagesController.current = null
      setIsLoadingMessages(false)
      const payload = await getAnalysisSession(linkedSessionId, { signal: controller.signal })
      if (controller.signal.aborted) return
      setActiveSession(payload.session)
      setPendingAnswer('')
      setConversationError(null)
    }).catch((sessionError) => {
      if (!controller.signal.aborted) {
        setConversationError(sessionError instanceof Error ? sessionError.message : 'Could not load the linked analysis session.')
      }
    }).finally(() => {
      if (sessionController.current === controller) setIsOpeningSession(false)
    })
    return () => controller.abort()
  }, [linkedSessionId])

  const sortedTeamTrends = useMemo(() => {
    return [...(snapshot?.teamTrends.items ?? [])]
      .sort((left, right) => compareTeamTrends(left, right, teamSort.field, teamSort.direction))
  }, [snapshot, teamSort])

  const sortedGames = useMemo(() => {
    return [...(snapshot?.games.items ?? [])]
      .sort((left, right) => compareGames(left, right, gameSort.field, gameSort.direction))
  }, [snapshot, gameSort])

  const changeTeamSort = (field: TeamSortField) => {
    setTeamSort((current) => current.field === field
      ? { field, direction: current.direction === 1 ? -1 : 1 }
      : { field, direction: 1 })
  }

  const changeGameSort = (field: GameSortField) => {
    setGameSort((current) => current.field === field
      ? { field, direction: current.direction === 1 ? -1 : 1 }
      : { field, direction: -1 })
  }

  function sortHeader<Field extends string>(
    label: string,
    field: Field,
    current: { field: Field; direction: SortDirection },
    change: (field: Field) => void,
  ) {
    return (
    <th aria-sort={current.field === field ? current.direction === 1 ? 'ascending' : 'descending' : 'none'}>
      <button type="button" onClick={() => change(field)}>
        {label}<span aria-hidden="true">{current.field === field ? current.direction === 1 ? ' ↑' : ' ↓' : ''}</span>
      </button>
    </th>
    )
  }

  const createReport = async (requestedPreset: AnalyticsPreset) => {
    if (!filters) return
    sessionController.current?.abort()
    streamingController.current?.abort()
    messagesController.current?.abort()
    messagesController.current = null
    setIsLoadingMessages(false)
    sessionGeneration.current++
    const controller = new AbortController()
    reportController.current = controller
    setIsAnalyzing(true)
    setError(null)
    try {
      const payload = await runAnalysis(defaultTitle(requestedPreset, filters, metadata), requestedPreset, filters, { signal: controller.signal })
      if (controller.signal.aborted) return
      streamingController.current?.abort()
      sessionController.current?.abort()
      sessionGeneration.current++
      setActiveSession(payload.session)
      setRequestedSessionId(payload.session.id)
      setPendingAnswer('')
      setAnswerSaved(false)
      setConversationError(null)
      setLastQuestion('')
      setCanRetryQuestion(false)
      setCanRetryQuestion(false)
      setIsStreaming(false)
      setStreamController(null)
      setIsOpeningSession(false)
      await reloadSessions()
    } catch (analysisError) {
      if (!controller.signal.aborted) setError(analysisError instanceof Error ? analysisError.message : 'Could not run local analysis.')
    } finally {
      if (reportController.current === controller) {
        reportController.current = null
        setIsAnalyzing(false)
      }
    }
  }

  const openSession = useCallback(async (event: MouseEvent<HTMLButtonElement>) => {
    const id = event.currentTarget.dataset.sessionId
    if (!id) {
      setConversationError('The saved analysis identifier is missing.')
      return
    }
    sessionController.current?.abort()
    streamingController.current?.abort()
    messagesController.current?.abort()
    messagesController.current = null
    setIsLoadingMessages(false)
    reportController.current?.abort()
    const controller = new AbortController()
    sessionController.current = controller
    sessionGeneration.current++
    setRequestedSessionId(id)
    setIsOpeningSession(true)
    setActiveSession(null)
    setPendingAnswer('')
    setAnswerSaved(false)
    setIsAnalyzing(false)
    setIsStreaming(false)
    setStreamController(null)
    setLastQuestion('')
    setConversationError(null)
    try {
      const payload = await getAnalysisSession(id, { signal: controller.signal })
      if (controller.signal.aborted) return
      setActiveSession(payload.session)
      setPendingAnswer('')
    } catch (sessionError) {
      if (!controller.signal.aborted) setConversationError(sessionError instanceof Error ? sessionError.message : 'Could not load analysis session.')
    } finally {
      if (sessionController.current === controller) setIsOpeningSession(false)
    }
  }, [])

  const loadMoreSessions = async () => {
    const cursor = sessionCursor === undefined ? sessionsRead.data?.next : sessionCursor
    if (!cursor || isLoadingMore) return
    const controller = new AbortController()
    paginationController.current = controller
    setIsLoadingMore(true)
    try {
      const page = await listAnalysisSessionPage(cursor, { signal: controller.signal })
      if (controller.signal.aborted) return
      setOlderSessions((current) => [...current, ...page.sessions.filter((item) => !current.some((saved) => saved.id === item.id))])
      setSessionCursor(page.next)
    } catch (loadError) {
      if (!controller.signal.aborted) setError(loadError instanceof Error ? loadError.message : 'Could not load older analyses.')
    } finally {
      if (paginationController.current === controller) setIsLoadingMore(false)
    }
  }

  const loadOlderMessages = async () => {
    if (!activeSession?.nextMessageId || isLoadingMessages || isOpeningSession || isAnalyzing || isStreaming) return
    setIsLoadingMessages(true)
    setCanRetryQuestion(false)
    setConversationError(null)
    const selected = activeSession
    const generation = sessionGeneration.current
    const controller = new AbortController()
    messagesController.current = controller
    try {
      const payload = await getAnalysisSession(selected.id, { signal: controller.signal, beforeMessage: selected.nextMessageId ?? undefined })
      if (controller.signal.aborted || generation !== sessionGeneration.current) return
      setActiveSession((current) => current?.id === selected.id ? {
        ...current, nextMessageId: payload.session.nextMessageId,
        messages: [...new Map([...payload.session.messages, ...current.messages].map((message) => [message.id, message])).values()],
      } : current)
    } catch (loadError) {
      if (!controller.signal.aborted && generation === sessionGeneration.current) {
        setConversationError(loadError instanceof Error ? loadError.message : 'Could not load older messages.')
      }
    } finally {
      if (messagesController.current === controller) setIsLoadingMessages(false)
    }
  }

  const prepareOriginalReport = async (signal: AbortSignal) => {
    if (!activeSession) throw new Error('No saved analysis is selected.')
    const generation = sessionGeneration.current
    let page = activeSession
    let original = page.messages.find((message) => message.role === 'assistant')
    const seen = new Set<number>()
    while (page.nextMessageId != null) {
      signal.throwIfAborted()
      const cursor = page.nextMessageId
      if (seen.has(cursor)) throw new Error('The earlier-message pages did not advance; the original report could not be identified.')
      seen.add(cursor)
      const payload = await getAnalysisSession(activeSession.id, { signal, beforeMessage: cursor })
      signal.throwIfAborted()
      if (generation !== sessionGeneration.current) throw new Error('The selected analysis changed before printing.')
      const older = payload.session
      if (older.id !== activeSession.id || !older.messages.length || older.messages.some((message) => message.id >= cursor)
        || (older.nextMessageId != null && older.nextMessageId >= cursor)) {
        throw new Error('The earlier-message page was invalid; the original report could not be identified.')
      }
      original = older.messages.find((message) => message.role === 'assistant') ?? original
      page = older
    }
    signal.throwIfAborted()
    if (generation !== sessionGeneration.current) throw new Error('The selected analysis changed before printing.')
    if (!original) throw new Error('The saved analysis contains no original assistant report.')
    return original.content
  }

  const renameSession = async (event: MouseEvent<HTMLButtonElement>) => {
    const session = sessions.find((item) => item.id === event.currentTarget.dataset.sessionId)
    if (!session) {
      setError('The saved analysis could not be found.')
      return
    }
    const title = window.prompt('Analysis name', session.title)?.trim()
    if (!title || title === session.title) return
    try {
      await renameAnalysisSession(session.id, title)
      setActiveSession((current) => current?.id === session.id ? { ...current, title } : current)
      await reloadSessions()
    } catch (renameError) {
      setError(renameError instanceof Error ? renameError.message : 'Could not rename analysis.')
    }
  }

  const removeSession = async (event: MouseEvent<HTMLButtonElement>) => {
    const session = sessions.find((item) => item.id === event.currentTarget.dataset.sessionId)
    if (!session) {
      setError('The saved analysis could not be found.')
      return
    }
    if (!window.confirm(`Delete "${session.title}"?`)) return
    try {
      await deleteAnalysisSession(session.id)
      if (activeSession?.id === session.id || requestedSessionId === session.id) {
        sessionGeneration.current++
        sessionController.current?.abort()
        messagesController.current?.abort()
        streamingController.current?.abort()
        setRequestedSessionId(null)
        setPendingAnswer('')
        setIsOpeningSession(false)
        setIsStreaming(false)
        setConversationError(null)
      }
      setActiveSession((current) => current?.id === session.id ? null : current)
      await reloadSessions()
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : 'Could not delete analysis.')
    }
  }

  const submitQuestion = async (event?: FormEvent, retryQuestion?: string) => {
    event?.preventDefault()
    if (!activeSession || isStreaming || isAnalyzing || isOpeningSession) return
    const nextQuestion = (retryQuestion ?? question).trim()
    if (!nextQuestion) return
    const controller = new AbortController()
    streamingController.current = controller
    const generation = sessionGeneration.current
    setStreamController(controller)
    setIsStreaming(true)
    setPendingAnswer('')
    setAnswerSaved(false)
    setLastQuestion(nextQuestion)
    setQuestion('')
    setConversationError(null)
    setCanRetryQuestion(false)
    let exchangeSaved = false
    try {
      const stream = await postAnalysisFollowUp(activeSession.id, nextQuestion, controller.signal)
      let streamError: string | null = null
      await readAnalysisStream(stream, (streamEvent) => {
        if (controller.signal.aborted || generation !== sessionGeneration.current) return
        if (streamEvent.type === 'content') setPendingAnswer((current) => current + streamEvent.content)
        if (streamEvent.type === 'error') streamError = streamEvent.error
        if (streamEvent.type === 'complete') {
          exchangeSaved = true
          setAnswerSaved(true)
          setLastQuestion('')
        }
      }, controller.signal)
      if (streamError) throw new Error(streamError)
      const payload = await getAnalysisSession(activeSession.id, { signal: controller.signal })
      if (controller.signal.aborted || generation !== sessionGeneration.current) return
      setActiveSession(payload.session)
      setPendingAnswer('')
      await reloadSessions()
    } catch (streamError) {
      if (!controller.signal.aborted) {
        const message = streamError instanceof Error ? streamError.message : 'The local analysis stream failed.'
        setConversationError(exchangeSaved ? `The reply was saved, but the conversation could not be refreshed: ${message}` : message)
        setCanRetryQuestion(!exchangeSaved)
      }
    } finally {
      if (streamingController.current === controller) {
        streamingController.current = null
        setIsStreaming(false)
        setStreamController(null)
      }
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
      <AnalyticsNav />
      <header className="analytics-hero panel">
        <div>
          <p className="eyebrow">Historical analytics</p>
          <h1>Lines, results, and grounded analysis</h1>
          <p>Review closing consensus spread and total outcomes. Figures are descriptive historical analysis, not betting advice.</p>
        </div>
        <AnalyticsModelStatus health={llmHealth} checking={healthRead.isLoading} />
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
        <label>Game ID<input type="number" min="1" value={gameInput} placeholder="All games" onChange={(event) => setGameDraft({ locationKey: location.key, value: event.target.value })} /></label>
      </section>

      {error && <StatusMessage title="Analytics error" message={error} error />}
      <AnalyticsReadStatuses reads={[
        { title: 'Analytics', error: overviewRead.error, refreshing: overviewRead.isRefreshing, retry: overviewRead.retry },
        { title: 'Filters', error: metadataRead.error, refreshing: metadataRead.isRefreshing, retry: metadataRead.retry },
        { title: 'Saved analyses', error: sessionsRead.error, refreshing: sessionsRead.isRefreshing, retry: sessionsRead.retry },
        { title: 'Local model', error: healthRead.error, retry: healthRead.retry },
      ]} />
      {isLoading && <StatusMessage title="Calculating analytics" message="Loading closing-line results and team trends." />}
      {!isLoading && snapshot && <section className="analytics-kpis">
        <article className="stat-card"><span className="stat-label">Completed games</span><p className="stat-value">{snapshot.summary.games}</p></article>
        <article className="stat-card"><span className="stat-label">Over rate</span><p className="stat-value">{percent(snapshot.summary.totals.overRate)}</p><small>{snapshot.summary.totals.overs}-{snapshot.summary.totals.unders}-{snapshot.summary.totals.pushes}</small></article>
        <article className="stat-card"><span className="stat-label">Home cover rate</span><p className="stat-value">{percent(snapshot.summary.spread.homeCoverRate)}</p><small>{snapshot.summary.spread.homeCovers} home / {snapshot.summary.spread.awayCovers} away</small></article>
        <article className="stat-card"><span className="stat-label">Ungraded lines</span><p className="stat-value">{snapshot.dataQuality.gamesMissingSpread + snapshot.dataQuality.gamesMissingTotal}</p><small>Spread + total</small></article>
      </section>}

      <section className={`analysis-overview ${!snapshot ? 'without-actions' : ''}`}>
        <div className="analysis-sidebar">
          {!isLoading && snapshot && (
            <aside className="panel panel-wide analysis-actions">
              <div className="section-heading"><h2>Local analysis</h2></div>
              <p>Generate a saved report of validated, model-selected facts from the current source data.</p>
              {availablePresets.map((item) => <button key={item} type="button" disabled={isAnalyzing || llmHealth?.status !== 'available'} onClick={() => void createReport(item)}>
                {isAnalyzing ? 'Analyzing…' : presetLabel(item)}
              </button>)}
              <AnalyticsModelHelp health={llmHealth} checking={healthRead.isLoading}
                unavailableMessage="Start llama-server to enable model analysis. Historical metrics remain available." />
            </aside>
          )}

          <aside className="panel saved-analyses">
            <div className="section-heading"><h2>Saved analyses</h2></div>
            {sessions.length ? sessions.map((session) => <div className={`saved-analysis ${activeSession?.id === session.id ? 'is-active' : ''}`} key={session.id}>
              <button className="saved-analysis-open" data-session-id={session.id} type="button" onClick={openSession}>
                <strong>{session.title}</strong><small>{presetLabel(session.preset)} · {session.filters.season}</small>
              </button>
              <button type="button" data-session-id={session.id} disabled={isAnalyzing || isStreaming} aria-label={`Rename ${session.title}`} onClick={renameSession}>✎</button>
              <button type="button" data-session-id={session.id} disabled={isAnalyzing || isStreaming} aria-label={`Delete ${session.title}`} onClick={removeSession}>×</button>
            </div>) : <p className="empty-state">{sessionsRead.isLoading ? 'Loading saved analyses...' : 'No saved analyses yet.'}</p>}
            {(sessionCursor === undefined ? sessionsRead.data?.next : sessionCursor) && <button type="button" disabled={isLoadingMore} onClick={() => void loadMoreSessions()}>Load older analyses</button>}
          </aside>
        </div>

        <article className="panel analysis-chat">
          {conversationError && <StatusMessage title="Conversation error" message={conversationError} error />}
          {conversationError && requestedSessionId && !canRetryQuestion && <button type="button" data-session-id={requestedSessionId} onClick={openSession}>Retry conversation</button>}
          {isOpeningSession && <StatusMessage title="Loading conversation" message="Loading the selected saved analysis." />}
          {activeSession ? <>
            <header><div><p className="eyebrow">{presetLabel(activeSession.preset)}</p><h2>{activeSession.title}</h2></div>
              <div className="analysis-header-actions">
                <span>{activeSession.model}</span>
                {activeSession.preset === 'matchup_preview' && <AnalyticsPrintButton key={activeSession.id}
                  prepareContent={prepareOriginalReport} title={activeSession.title} disabled={isAnalyzing || isOpeningSession} />}
              </div>
            </header>
            <div className="analysis-messages">
              {activeSession.nextMessageId && <button type="button" disabled={isLoadingMessages || isAnalyzing || isStreaming} onClick={() => void loadOlderMessages()}>Load older messages</button>}
              {activeSession.messages.map((message) => <div className={`analysis-message is-${message.role}`} key={message.id}>
                <strong>{message.role === 'assistant' ? 'Local model' : 'You'}</strong>
                {message.role === 'assistant' ? <>
                  {activeSession.preset === 'matchup_preview' && <AnalyticsPrintButton content={message.content} title={activeSession.title} />}
                  <AnalyticsReportContent content={message.content} />
                </> : <p>{message.content}</p>}
              </div>)}
              {pendingAnswer && <div className={`analysis-message is-assistant ${isStreaming ? 'is-streaming' : ''}`}><strong>{answerSaved ? 'Local model (saved)' : isStreaming ? 'Local model' : 'Local model (save not confirmed)'}</strong>
                {activeSession.preset === 'matchup_preview' && answerSaved && !isStreaming && <AnalyticsPrintButton content={pendingAnswer} title={activeSession.title} />}
                <AnalyticsReportContent content={pendingAnswer} />
              </div>}
            </div>
            <AnalyticsGroundingDetails snapshot={activeSession.context} />
            {isStreaming && !pendingAnswer && <p role="status">Generating and validating the answer before display...</p>}
            <form className="analysis-chat-form" onSubmit={(event) => void submitQuestion(event)}>
              <textarea value={question} maxLength={4000} disabled={isStreaming || isAnalyzing || isOpeningSession} placeholder="Ask a follow-up grounded in this saved dataset…" onChange={(event) => setQuestion(event.target.value)} />
              <div>
                {isStreaming ? <button type="button" onClick={() => streamController?.abort()}>Stop</button> : <button type="submit" disabled={isAnalyzing || isOpeningSession || !question.trim() || llmHealth?.status !== 'available'}>Send</button>}
                {!isStreaming && canRetryQuestion && conversationError && lastQuestion && <button type="button" onClick={() => void submitQuestion(undefined, lastQuestion)}>Retry</button>}
              </div>
            </form>
          </> : <div className="analysis-chat-empty"><h2>Grounded conversation</h2><p>Open or generate a saved analysis to ask follow-up questions against its immutable data snapshot.</p></div>}
        </article>
      </section>

      {!isLoading && snapshot && <>
        <section className="panel panel-wide">
          <div className="section-heading"><h2>Team trends</h2><span>{snapshot.teamTrends.total} teams</span></div>
          {sortedTeamTrends.length ? <div className="table-wrap analytics-table-scroll"><table className="analytics-data-table team-trends-table">
            <thead><tr>
              {sortHeader('Team', 'team', teamSort, changeTeamSort)}
              {sortHeader('ATS', 'ats', teamSort, changeTeamSort)}
              {sortHeader('ATS rate', 'atsRate', teamSort, changeTeamSort)}
              {sortHeader('O/U/P', 'totals', teamSort, changeTeamSort)}
              {sortHeader('Avg ATS delta', 'averageSpreadDelta', teamSort, changeTeamSort)}
            </tr></thead>
            <tbody>{sortedTeamTrends.map((team) => <tr key={team.teamId}>
              <th>{team.teamName}</th><td>{team.atsWins}-{team.atsLosses}-{team.atsPushes}</td>
              <td><span className="trend-bar"><i style={{ width: `${(team.atsWinRate ?? 0) * 100}%` }} /></span>{percent(team.atsWinRate)}</td>
              <td>{team.overs}-{team.unders}-{team.totalPushes}</td><td>{signed(team.averageTeamSpreadDelta)}</td>
            </tr>)}</tbody>
          </table></div> : <p className="empty-state">No team trends match these filters.</p>}
        </section>

        <section className="panel panel-wide">
          <div className="section-heading"><h2>Game results</h2><span>{snapshot.games.total} matching games{snapshot.games.truncated ? `; showing ${snapshot.games.included}` : ''}</span></div>
          {sortedGames.length ? <div className="table-wrap analytics-table-scroll"><table className="analytics-data-table analytics-results-table">
            <thead><tr>
              {sortHeader('Date', 'date', gameSort, changeGameSort)}
              {sortHeader('Matchup', 'matchup', gameSort, changeGameSort)}
              {sortHeader('Final', 'final', gameSort, changeGameSort)}
              {sortHeader('Closing spread', 'closingSpread', gameSort, changeGameSort)}
              {sortHeader('ATS result', 'spreadResult', gameSort, changeGameSort)}
              {sortHeader('Closing total', 'closingTotal', gameSort, changeGameSort)}
              {sortHeader('Total result', 'totalResult', gameSort, changeGameSort)}
            </tr></thead>
            <tbody>{sortedGames.map((game) => <tr key={game.gameId}>
              <td>{game.gameDate ?? '—'}</td><th>{game.awayTeamName} at {game.homeTeamName}<small>Game {game.gameId}</small></th>
              <td>{game.awayScore}-{game.homeScore}</td><td>{game.closingHomeSpread ?? '—'}</td>
              <td><b className={`result-pill is-${game.spreadResult}`}>{game.spreadResult.replace('_', ' ')}</b><small>{signed(game.spreadDelta)}</small></td>
              <td>{game.closingTotal ?? '—'}</td><td><b className={`result-pill is-${game.totalResult}`}>{game.totalResult}</b><small>{signed(game.totalDelta)}</small></td>
            </tr>)}</tbody>
          </table></div> : <p className="empty-state">No completed games match these filters.</p>}
        </section>
      </>}
    </main>
  )
}
