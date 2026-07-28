import './App.css'
import { NavLink, Navigate, Route, Routes } from 'react-router-dom'
import { DashboardPage } from './pages/DashboardPage'
import { GameDetailPage } from './pages/GameDetailPage'
import { GameTeamDetailPage } from './pages/GameTeamDetailPage'
import { GamesPage } from './pages/GamesPage'
import { HomePage } from './pages/HomePage'

function App() {
  return (
    <div className="app-shell">
      <header className="top-nav" aria-label="Primary navigation">
        <NavLink className="brand" to="/">
          NFL Data Hub
        </NavLink>
        <nav className="top-nav-links">
          <NavLink to="/" end>
            Home
          </NavLink>
          <NavLink to="/games">Games</NavLink>
          <NavLink to="/dashboard">Dashboard</NavLink>
        </nav>
      </header>

      <Routes>
        <Route path="/" element={<HomePage />} />
        <Route path="/games" element={<GamesPage />} />
        <Route path="/games/:id" element={<GameDetailPage />} />
        <Route path="/games/:gameId/teams/:teamId" element={<GameTeamDetailPage />} />
        <Route path="/dashboard" element={<DashboardPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </div>
  )
}

export default App
