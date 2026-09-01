export type SpreadBetResult = 'away_cover' | 'home_cover' | 'push' | 'ungraded'
export type TotalBetResult = 'over' | 'push' | 'under' | 'ungraded'

export type BettingResultInput = {
  awayScore: number | null
  closingHomeSpread: unknown
  closingTotal: unknown
  homeScore: number | null
  statusShort: string | null
}

export type BettingResult = {
  finalTotal: number | null
  homeMargin: number | null
  isCompleted: boolean
  spread: {
    delta: number | null
    line: number | null
    result: SpreadBetResult
  }
  total: {
    delta: number | null
    line: number | null
    result: TotalBetResult
  }
}

const COMPLETED_GAME_STATUSES = new Set(['AOT', 'FT'])
const NUMERIC_LINE_PATTERN = /^[+-]?(?:\d+(?:\.\d+)?|\.\d+)$/

function parseBettingLine(value: unknown) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value !== 'string') return null

  const normalized = value.trim()
  if (!NUMERIC_LINE_PATTERN.test(normalized)) return null

  const parsed = Number(normalized)
  return Number.isFinite(parsed) ? parsed : null
}

function isCompletedGame(
  input: BettingResultInput,
): input is BettingResultInput & { awayScore: number; homeScore: number } {
  return COMPLETED_GAME_STATUSES.has(input.statusShort?.trim().toUpperCase() ?? '')
    && input.homeScore != null
    && Number.isFinite(input.homeScore)
    && input.awayScore != null
    && Number.isFinite(input.awayScore)
}

export function gradeBettingResult(input: BettingResultInput): BettingResult {
  const isCompleted = isCompletedGame(input)
  const spreadLine = parseBettingLine(input.closingHomeSpread)
  const totalLine = parseBettingLine(input.closingTotal)

  if (!isCompleted) {
    return {
      finalTotal: null,
      homeMargin: null,
      isCompleted: false,
      spread: { delta: null, line: spreadLine, result: 'ungraded' },
      total: { delta: null, line: totalLine, result: 'ungraded' },
    }
  }

  const homeMargin = input.homeScore - input.awayScore
  const finalTotal = input.homeScore + input.awayScore
  const spreadDelta = spreadLine == null ? null : homeMargin + spreadLine
  const totalDelta = totalLine == null ? null : finalTotal - totalLine

  return {
    finalTotal,
    homeMargin,
    isCompleted: true,
    spread: {
      delta: spreadDelta,
      line: spreadLine,
      result: spreadDelta == null
        ? 'ungraded'
        : spreadDelta > 0
          ? 'home_cover'
          : spreadDelta < 0
            ? 'away_cover'
            : 'push',
    },
    total: {
      delta: totalDelta,
      line: totalLine,
      result: totalDelta == null
        ? 'ungraded'
        : totalDelta > 0
          ? 'over'
          : totalDelta < 0
            ? 'under'
            : 'push',
    },
  }
}
