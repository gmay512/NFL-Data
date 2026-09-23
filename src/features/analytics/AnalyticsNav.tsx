import { NavLink } from 'react-router-dom'

export function AnalyticsNav() {
  return (
    <nav className="analytics-subnav" aria-label="Analytics sections">
      <NavLink to="/analytics" end>Historical</NavLink>
      <NavLink to="/analytics/weekly">Weekly Analysis</NavLink>
    </nav>
  )
}
