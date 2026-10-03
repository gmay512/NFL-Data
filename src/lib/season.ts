export const FIRST_RETAINED_SEASON = 2026

export function getCurrentNflSeason(now = new Date()) {
  return Math.max(FIRST_RETAINED_SEASON, now.getUTCFullYear() - (now.getUTCMonth() < 2 ? 1 : 0))
}

export function selectCurrentSeason(seasons: { season: number; current: boolean }[], now = new Date()) {
  const fallback = getCurrentNflSeason(now)
  return seasons.find((season) => season.current && season.season >= fallback)?.season ?? fallback
}

export function shouldImportSeasonMetadata(season: number, requestedSeasons: number[]) {
  return season >= FIRST_RETAINED_SEASON || requestedSeasons.includes(season)
}
