import { formatValue } from '../../lib/game-format'
import type { GroupedStats } from '../../lib/player-stats'

export function RosterBucket({ title, groups }: { title: string; groups: GroupedStats[] }) {
  if (!groups.length) return null

  return (
    <section className="roster-bucket" aria-label={`${title} stats`}>
      <h4>{title}</h4>
      <div className="roster-group-list">
        {groups.map((group) => (
          <div key={group.group} className="roster-group">
            <p>{group.group}</p>
            <ul>
              {group.entries.map((entry) => (
                <li key={`${group.group}-${entry.statName}`}>
                  <span>{entry.statName}</span>
                  <strong>{formatValue(entry.statValue)}</strong>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </section>
  )
}
