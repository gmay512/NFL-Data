import type { AnalyticsSnapshot } from './analytics-core'
import { buildAnalyticsFacts, type AnalyticsFact, type AnalyticsFactSection } from './analytics-facts'
import { analyticsProvenance } from '../src/lib/analytics-provenance'

export class AnalyticsReportError extends Error {
  readonly code = 'invalid_report_output'
}

export const MAX_REPORT_OBSERVATIONS = 40

export const ANALYTICS_REPORT_INSTRUCTIONS = [
  'Return JSON only: {"observations":[{"kind":"fact","factId":"catalog ID"},',
  '{"kind":"comparison","leftFactId":"catalog ID","rightFactId":"catalog ID"}]}.',
  `Select 1 to ${MAX_REPORT_OBSERVATIONS} distinct observations relevant to the requested report or question.`,
  'Use only catalog IDs. Do not supply prose, values, scores, lines, entities, or extra fields.',
  'Comparisons require finite values, different teams, and identical comparisonKey and units.',
  'For unsupported questions select relevant limitation facts. Conversation claims are unverified.',
].join(' ')

export function buildAnalyticsReportSchema(snapshot: AnalyticsSnapshot) {
  const { facts } = buildAnalyticsFacts(snapshot)
  const factReference = { type: 'string', enum: facts.map((fact) => fact.id) }
  const comparable = facts.filter((fact) =>
    fact.comparisonKey && fact.teamId != null && fact.value != null && Number.isFinite(fact.value))
  const observations = [{
    type: 'object',
    properties: { kind: { const: 'fact' }, factId: factReference },
    required: ['kind', 'factId'],
    additionalProperties: false,
  }, ...(comparable.length ? [{
    type: 'object',
    properties: {
      kind: { const: 'comparison' },
      leftFactId: { type: 'string', enum: comparable.map((fact) => fact.id) },
      rightFactId: { type: 'string', enum: comparable.map((fact) => fact.id) },
    },
    required: ['kind', 'leftFactId', 'rightFactId'],
    additionalProperties: false,
  }] : [])]
  return {
    type: 'object',
    properties: {
      observations: {
        type: 'array', minItems: 1, maxItems: MAX_REPORT_OBSERVATIONS,
        items: { anyOf: observations },
      },
    },
    required: ['observations'],
    additionalProperties: false,
  }
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new AnalyticsReportError('The model report must contain JSON objects, not factual prose.')
  }
  return value as Record<string, unknown>
}

function exactKeys(value: Record<string, unknown>, keys: string[]) {
  const actual = Object.keys(value).sort()
  if (actual.length !== keys.length || actual.some((key, index) => key !== [...keys].sort()[index])) {
    throw new AnalyticsReportError('The model report contains unsupported fields.')
  }
}

export function markdownText(value: string) {
  return value.replace(/\s*\r?\n\s*/g, ' ').trim()
    .replace(/[\\`*_[\]<>|~#&]/g, '\\$&')
    .replace(/^([-+])/, '\\$1')
    .replace(/^(\d+)([.)])(?=\s)/, '$1\\$2')
}

function cite(fact: AnalyticsFact) {
  const ids = [
    ...(fact.teamId == null ? [] : [`teamId ${fact.teamId}`]),
    ...(fact.playerId == null ? [] : [`playerId ${fact.playerId}`]),
    ...(fact.gameIds.length ? [`gameIds ${fact.gameIds.join(', ')}`] : []),
  ]
  return `${markdownText(fact.statement)}${ids.length ? ` **Evidence:** ${ids.join('; ')}.` : ''}`
}

const reportSections: Array<[AnalyticsFactSection, string]> = [
  ['matchup', 'Matchup and current odds'],
  ['results', 'Selected-game results'],
  ['team', 'Team trends'],
  ['statistics', 'Team statistics'],
  ['standings', 'Season standings'],
  ['injuries', 'Reported injuries'],
  ['players', 'Player statistics'],
]

export function renderAnalyticsReport(content: string, snapshot: AnalyticsSnapshot, finishReason: string | null) {
  if (finishReason !== 'stop') throw new AnalyticsReportError('The model report did not finish normally; no validated report was saved.')
  let parsed: unknown
  try {
    parsed = JSON.parse(content)
  } catch (error) {
    throw new AnalyticsReportError('The model did not return valid report-selection JSON.', { cause: error })
  }
  const root = record(parsed)
  exactKeys(root, ['observations'])
  if (!Array.isArray(root.observations) || !root.observations.length || root.observations.length > MAX_REPORT_OBSERVATIONS) {
    throw new AnalyticsReportError(`The model report requires 1 to ${MAX_REPORT_OBSERVATIONS} observations.`)
  }
  const catalog = buildAnalyticsFacts(snapshot)
  const byId = new Map(catalog.facts.map((fact) => [fact.id, fact]))
  function fact(id: unknown) {
    if (typeof id !== 'string' || !byId.has(id)) {
      throw new AnalyticsReportError('The model selected a fact outside the supplied report catalog.')
    }
    return byId.get(id)!
  }
  const seen = new Set<string>()
  const observations = root.observations.map((value) => {
    const observation = record(value)
    let key: string
    let section: AnalyticsFactSection
    let markdown: string
    if (observation.kind === 'fact') {
      exactKeys(observation, ['kind', 'factId'])
      const selected = fact(observation.factId)
      key = selected.id
      section = selected.section
      markdown = `- ${cite(selected)}`
    } else if (observation.kind === 'comparison') {
      exactKeys(observation, ['kind', 'leftFactId', 'rightFactId'])
      const left = fact(observation.leftFactId)
      const right = fact(observation.rightFactId)
      if (!left.comparisonKey || left.comparisonKey !== right.comparisonKey
        || left.unit !== right.unit || left.teamId == null || right.teamId == null
        || left.teamId === right.teamId || left.value == null || right.value == null
        || !Number.isFinite(left.value) || !Number.isFinite(right.value)) {
        throw new AnalyticsReportError('The model selected facts with incompatible comparison scopes or unavailable values.')
      }
      key = [left.id, right.id].sort().join('|')
      section = left.section
      const difference = Number(Math.abs(left.value - right.value).toFixed(3))
      markdown = [
        '**Team comparison**',
        '',
        '| Source | Supplied value | Unit |',
        '| --- | ---: | --- |',
        `| First: teamId ${left.teamId} | ${left.value} | ${markdownText(left.unit ?? '')} |`,
        `| Second: teamId ${right.teamId} | ${right.value} | ${markdownText(right.unit ?? '')} |`,
        '',
        `- ${cite(left)}`,
        `- ${cite(right)}`,
        '',
        `**Difference:** The first supplied value is ${left.value === right.value ? 'equal to the second' : `${difference} ${markdownText(left.unit ?? '')} ${left.value > right.value ? 'higher' : 'lower'} than the second`}. This is descriptive, not a predictive conclusion.`,
      ].join('\n')
    } else {
      throw new AnalyticsReportError('The model selected an unsupported observation template.')
    }
    if (seen.has(key)) throw new AnalyticsReportError('The model report contains duplicate observations.')
    seen.add(key)
    return { section, markdown }
  })
  const sections = reportSections.flatMap(([section, heading]) => {
    const selected = observations.filter((observation) => observation.section === section)
    return selected.length ? [`## ${heading}`, ...selected.map((observation) => observation.markdown)] : []
  })
  const limitations = [
    ...observations.filter((observation) => observation.section === 'limitations').map((observation) => observation.markdown),
    ...analyticsProvenance(snapshot).map((note) => `- ${markdownText(note)}`),
    ...(catalog.truncated ? [`- Fact catalog bounded to ${catalog.facts.length} of ${catalog.total} facts; omitted facts cannot be cited.`] : []),
  ]
  return [
    '# Validated factual report',
    ...sections,
    '## Source scope and limitations',
    ...new Set(limitations),
    '**Interpretation:** These observations are descriptive, not predictive probabilities or betting advice.',
  ].join('\n\n')
}
