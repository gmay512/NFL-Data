export const appStats = [
  {
    label: 'Database',
    value: 'Supabase Local',
    detail: 'Docker-backed Postgres with API and Studio running locally.',
  },
  {
    label: 'Schema',
    value: '11 Core Tables',
    detail: 'Base entities, standings, injuries, and team/player stat tables.',
  },
  {
    label: 'Security',
    value: 'RLS Enabled',
    detail: 'Anon read policies and service role ingest support.',
  },
  {
    label: 'Ingest',
    value: 'Season Picker',
    detail: 'Load a season from the home page and ingest the full dataset.',
  },
]

export const schemaLinks = [
  {
    title: 'Leagues',
    description: 'Browse league IDs, names, and country metadata references.',
    href: '/dashboard#leagues',
  },
  {
    title: 'League Seasons',
    description: 'Inspect season-year rows and endpoint coverage flags per league.',
    href: '/dashboard#league-seasons',
  },
  {
    title: 'Teams',
    description: 'Browse NFL franchise identifiers, names, and logo references.',
    href: '/dashboard#teams',
  },
  {
    title: 'Players',
    description: 'Inspect player identifiers, names, and profile image URLs.',
    href: '/dashboard#players',
  },
  {
    title: 'Games',
    description: 'Track game metadata including season, week, and participating teams.',
    href: '/dashboard#games',
  },
  {
    title: 'Game Events',
    description: 'Review scoring events with quarter, clock, and cumulative score.',
    href: '/dashboard#game-events',
  },
  {
    title: 'Injuries',
    description: 'Track current player injury status and report details.',
    href: '/dashboard#injuries',
  },
  {
    title: 'Player Season Stats',
    description: 'EAV season statistics grouped by passing, rushing, receiving, and more.',
    href: '/dashboard#player-season-stats',
  },
  {
    title: 'Standings',
    description: 'Conference/division positions, records, points, and streaks.',
    href: '/dashboard#standings',
  },
  {
    title: 'Game Team Stats',
    description: 'Flattened team box score metrics for each game/team pair.',
    href: '/dashboard#game-team-stats',
  },
  {
    title: 'Game Player Stats',
    description: 'EAV per-player game stats across passing, rushing, receiving and more.',
    href: '/dashboard#game-player-stats',
  },
]