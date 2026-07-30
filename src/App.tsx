import './App.css'
import { NavLink, Navigate, Route, Routes } from 'react-router-dom'
import { DashboardPage } from './pages/DashboardPage'
import { GameDetailPage } from './pages/GameDetailPage'
import { GameTeamDetailPage } from './pages/GameTeamDetailPage'

function App() {
  return (
    <div className="app-shell">
      <header className="top-nav" aria-label="Primary navigation">
        <NavLink className="brand" to="/">
          NFL Game Center
        </NavLink>
        <nav className="top-nav-links">
          <NavLink to="/" end>Dashboard</NavLink>
          <NavLink to="/games">Schedule</NavLink>
        </nav>
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
