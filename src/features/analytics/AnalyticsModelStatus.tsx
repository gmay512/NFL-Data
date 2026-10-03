import type { LlmHealthResponse } from '../../api/contracts'

type ModelStatus = {
  health: LlmHealthResponse | null
  checking: boolean
}

export function AnalyticsModelStatus({ health, checking }: ModelStatus) {
  const label = health?.status === 'available' ? health.model : checking ? 'Checking local LLM...' : 'Local LLM offline'
  return <span className={`llm-status ${health?.status === 'available' ? 'is-online' : ''}`} aria-busy={checking}>
    <i />
    <span className="llm-status-label" title={label}>{label}</span>
  </span>
}

export function AnalyticsModelHelp({ health, checking, unavailableMessage }: ModelStatus & {
  unavailableMessage: string
}) {
  const unavailable = !checking && health?.status !== 'available'
  return <small className="analytics-model-help">
    <span className={checking ? 'is-active' : ''} aria-hidden={!checking}>Checking local LLM availability...</span>
    <span className={unavailable ? 'is-active' : ''} aria-hidden={!unavailable}>{unavailableMessage}</span>
  </small>
}
