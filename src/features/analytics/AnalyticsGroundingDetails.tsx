import type { AnalyticsSnapshot } from '../../api/contracts'
import { analyticsProvenance } from '../../lib/analytics-provenance'

export function AnalyticsGroundingDetails({ snapshot }: { snapshot: AnalyticsSnapshot }) {
  return <details className="grounding-details">
    <summary>Grounding details</summary>
    {analyticsProvenance(snapshot).map((note, index) => <p key={index}>{note}</p>)}
    <pre>{JSON.stringify({
      requestedFilters: snapshot.filters,
      effectiveScope: snapshot.evidenceScope ?? 'Unknown legacy scope',
      generatedAt: snapshot.generatedAt,
      dataQuality: snapshot.dataQuality,
      statCoverage: snapshot.teamStatTrends.items.map((trend) => ({
        teamId: trend.teamId, metricSamples: trend.metricSamples ?? 'Unknown legacy coverage',
      })),
      injuryObservations: snapshot.currentInjuries.items.map((injury) => ({
        playerId: injury.player_id, status: injury.status, injuryDate: injury.injury_date,
        lastObserved: injury.last_seen_at ?? null,
      })),
    }, null, 2)}</pre>
  </details>
}
