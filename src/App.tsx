import './App.css'
import { useEffect, useState } from 'react'
import { NavLink, Navigate, Route, Routes } from 'react-router-dom'
import { DashboardPage } from './pages/DashboardPage'
import { GameDetailPage } from './pages/GameDetailPage'
import { GameTeamDetailPage } from './pages/GameTeamDetailPage'

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

      <Routes>
        <Route path="/" element={<DashboardPage />} />
        <Route path="/games" element={<DashboardPage />} />
        <Route path="/games/:id" element={<GameDetailPage />} />
        <Route path="/games/:gameId/teams/:teamId" element={<GameTeamDetailPage />} />
        <Route path="/dashboard" element={<DashboardPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </div>
  )
}

export default App
