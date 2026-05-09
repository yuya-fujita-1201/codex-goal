import { Routes, Route, Navigate } from 'react-router-dom'

import NewGoal from './pages/NewGoal'
import GoalDetail from './pages/GoalDetail'
import PlanReview from './pages/PlanReview'
import Settings from './pages/Settings'
import Sidebar from './components/Sidebar'

export default function App(): JSX.Element {
  return (
    <div className="flex h-full flex-col bg-bg-primary text-zinc-100">
      <div className="titlebar-drag h-7 shrink-0 bg-bg-secondary"></div>
      <div className="flex flex-1 overflow-hidden">
        <Sidebar />
        <main className="flex-1 overflow-auto">
          <Routes>
            <Route path="/" element={<NewGoal />} />
            <Route path="/goals/new" element={<NewGoal />} />
            <Route path="/goals/:goalId" element={<GoalDetail />} />
            <Route path="/plan/:goalId" element={<PlanReview />} />
            <Route path="/settings" element={<Settings />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </main>
      </div>
    </div>
  )
}
