import { useEffect, useState } from 'react'
import { FeatureCard } from '../components/FeatureCard'
import { StatCard } from '../components/StatCard'
import { appStats, schemaLinks } from '../data/appContent'

type AvailableSeason = {
  season: number
  current: boolean
  startDate: string | null
  endDate: string | null
}

type IngestSummary = {
  season: number
  leagues: number
  leagueSeasons: number
  teams: number
  players: number
  games: number
  gameEvents: number
  injuries: number
  playerSeasonStats: number
  standings: number
  gameTeamStats: number
  gamePlayerStats: number
}

export function HomePage() {
  const [seasons, setSeasons] = useState<AvailableSeason[]>([])
  const [selectedSeason, setSelectedSeason] = useState('')
  const [isLoadingSeasons, setIsLoadingSeasons] = useState(true)
  const [isIngesting, setIsIngesting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [summary, setSummary] = useState<IngestSummary | null>(null)

  useEffect(() => {
    const loadSeasons = async () => {
      setIsLoadingSeasons(true)
      setError(null)

      try {
        const response = await fetch('/api/seasons')
        const payload = (await response.json()) as { seasons?: AvailableSeason[]; error?: string }

        if (!response.ok) {
          throw new Error(payload.error ?? 'Failed to load available seasons.')
        }

        const availableSeasons = payload.seasons ?? []
        setSeasons(availableSeasons)
        setSelectedSeason((current) => current || String(availableSeasons[0]?.season ?? ''))
      } catch (loadError) {
        setError(loadError instanceof Error ? loadError.message : 'Failed to load seasons.')
      } finally {
        setIsLoadingSeasons(false)
      }
    }

    void loadSeasons()
  }, [])

  const handleIngest = async () => {
    if (!selectedSeason) return

    setIsIngesting(true)
    setError(null)
    setSummary(null)

    try {
      const response = await fetch('/api/ingest-season', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ season: Number(selectedSeason) }),
      })

      const payload = (await response.json()) as { error?: string } & Partial<IngestSummary>
      if (!response.ok) {
        throw new Error(payload.error ?? 'Season ingest failed.')
      }

      setSummary(payload as IngestSummary)
    } catch (ingestError) {
      setError(ingestError instanceof Error ? ingestError.message : 'Season ingest failed.')
    } finally {
      setIsIngesting(false)
    }
  }

  const selectedSeasonMeta = seasons.find((season) => String(season.season) === selectedSeason)

  return (
    <main>
      <section className="hero">
        <p className="eyebrow">Local Supabase + NFL schema</p>
        <h1>Track NFL data with a clean, local-first dashboard.</h1>
        <p className="hero-copy">
          The schema is live in your Docker-backed Supabase database. Start from the
          links below to explore each table and validate ingestion.
        </p>

        <div className="stats-grid">
          {appStats.map((stat) => (
            <StatCard key={stat.label} {...stat} />
          ))}
        </div>

        <section className="panel ingest-panel" aria-label="Season ingest">
          <div className="section-heading">
            <p className="eyebrow">Season ingest</p>
            <h2>Choose a season and ingest the full dataset.</h2>
          </div>

          <div className="ingest-controls">
            <label className="ingest-field">
              <span>Available seasons</span>
              <select
                value={selectedSeason}
                onChange={(event) => setSelectedSeason(event.target.value)}
                disabled={isLoadingSeasons || isIngesting || seasons.length === 0}
              >
                <option value="">{isLoadingSeasons ? 'Loading seasons...' : 'Select a season'}</option>
                {seasons.map((season) => (
                  <option key={season.season} value={season.season}>
                    {season.season}
                    {season.current ? ' (current)' : ''}
                  </option>
                ))}
              </select>
            </label>

            <button
              type="button"
              className="ingest-button"
              onClick={handleIngest}
              disabled={!selectedSeason || isLoadingSeasons || isIngesting}
            >
              {isIngesting ? 'Ingesting season...' : 'Ingest season'}
            </button>
          </div>

          <p className="ingest-hint">
            The ingest route loads the selected season, then walks the documented parent and child endpoints for teams, players, injuries, season stats, standings, games, and game stats.
          </p>

          {selectedSeasonMeta && (
            <p className="ingest-meta">
              Selected season: <strong>{selectedSeasonMeta.season}</strong>
              {selectedSeasonMeta.current ? ' · current season' : ''}
            </p>
          )}

          {summary && (
            <div className="ingest-summary">
              <strong>Ingest complete for {summary.season}</strong>
              <span>
                leagues {summary.leagues} · teams {summary.teams} · players {summary.players} · games {summary.games}
              </span>
            </div>
          )}
        </section>
      </section>

      <section className="content-grid" aria-label="Schema links">
        <div className="panel panel-wide">
          <div className="section-heading">
            <p className="eyebrow">Data access</p>
            <h2>Open each schema section from one place.</h2>
          </div>

          <div className="feature-grid">
            {schemaLinks.map((feature) => (
              <FeatureCard key={feature.title} {...feature} />
            ))}
          </div>
        </div>

        <aside className="panel panel-side">
          <div className="section-heading">
            <p className="eyebrow">Workflow</p>
            <h2>Local development loop</h2>
          </div>

          <ol className="steps-list">
            <li>Run npm run db:start to launch local Supabase services.</li>
            <li>Open this page and ingest a season from the selector above.</li>
            <li>Open Dashboard to confirm tables and row-level access.</li>
          </ol>
        </aside>
      </section>

      {error && (
        <section className="panel panel-wide status-banner error-banner">
          <h2>Ingest error</h2>
          <p>{error}</p>
        </section>
      )}
    </main>
  )
}
