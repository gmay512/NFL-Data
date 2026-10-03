import './App.css'
import { lazy, Suspense, useEffect, useState } from 'react'
import { NavLink, Navigate, Route, Routes } from 'react-router-dom'
import { DashboardPage } from './pages/DashboardPage'
const GameDetailPage = lazy(() => import('./pages/GameDetailPage').then((module) => ({ default: module.GameDetailPage })))
const GameTeamDetailPage = lazy(() => import('./pages/GameTeamDetailPage').then((module) => ({ default: module.GameTeamDetailPage })))
const AnalyticsPage = lazy(() => import('./pages/AnalyticsPage').then((module) => ({ default: module.AnalyticsPage })))
const WeeklyAnalysisPage = lazy(() => import('./pages/WeeklyAnalysisPage').then((module) => ({ default: module.WeeklyAnalysisPage })))

function App() {
  const [theme, setTheme] = useState<'light' | 'dark'>(() => {
    const storedTheme = window.localStorage.getItem('theme')
    return storedTheme === 'dark' ? 'dark' : 'light'
  })

  useEffect(() => {
    document.documentElement.dataset.theme = theme
    window.localStorage.setItem('theme', theme)
  }, [theme])

  return (
    <div className="app-shell">
      <header className="top-nav" aria-label="Primary navigation">
        <NavLink className="brand" to="/">
          NFL Game Center
        </NavLink>
        <div className="top-nav-actions">
          <nav className="top-nav-links">
            <NavLink to="/" end>Dashboard</NavLink>
            <NavLink to="/games">Schedule</NavLink>
            <NavLink to="/analytics">Analytics</NavLink>
          </nav>
          <button
            type="button"
            className="theme-toggle"
            aria-pressed={theme === 'dark'}
            onClick={() => setTheme((currentTheme) => (currentTheme === 'light' ? 'dark' : 'light'))}
          >
            {theme === 'light' ? 'Dark mode' : 'Light mode'}
          </button>
        </div>
      </header>

      <Suspense fallback={<p className="empty-state" role="status">Loading page...</p>}>
      <Routes>
        <Route path="/" element={<DashboardPage />} />
        <Route path="/games" element={<DashboardPage />} />
        <Route path="/games/:id" element={<GameDetailPage />} />
        <Route path="/games/:gameId/teams/:teamId" element={<GameTeamDetailPage />} />
        <Route path="/analytics" element={<AnalyticsPage />} />
        <Route path="/analytics/weekly" element={<WeeklyAnalysisPage />} />
        <Route path="/dashboard" element={<DashboardPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
      </Suspense>
    </div>
  )
}

export default App
