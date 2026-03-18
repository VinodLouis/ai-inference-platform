import { useEffect, useState } from 'react'
import { Layout } from 'antd'
import { BrowserRouter, Navigate, Route, Routes, useLocation } from 'react-router-dom'
import { setAuthToken } from './api'
import AppHeader from './components/AppHeader'
import { isAdmin, isInferenceUser } from './lib/auth'
import { clearSession, loadSession } from './lib/session'
import AdminPage from './pages/AdminPage'
import LoginPage from './pages/LoginPage'
import UserPage from './pages/UserPage'
import type { ReactNode } from 'react'
import type { User } from './types'

const { Header } = Layout

interface HomeRedirectProps {
  user: User | null
}

function HomeRedirect ({ user }: HomeRedirectProps) {
  if (!user) return <Navigate to='/login' replace />
  if (isAdmin(user)) return <Navigate to='/admin' replace />
  if (isInferenceUser(user)) return <Navigate to='/inference' replace />
  return <Navigate to='/login' replace />
}

interface RouteGuardProps {
  token: string
  user?: User | null
  children: ReactNode
}

function ProtectedRoute ({ token, children }: RouteGuardProps) {
  if (!token) return <Navigate to='/login' replace />
  return children
}

function AdminRoute ({ token, user, children }: RouteGuardProps) {
  if (!token) return <Navigate to='/login' replace />
  if (!isAdmin(user ?? null)) return <Navigate to='/inference' replace />
  return children
}

function InferenceRoute ({ token, user, children }: RouteGuardProps) {
  if (!token) return <Navigate to='/login' replace />
  if (!isInferenceUser(user ?? null)) return <Navigate to='/admin' replace />
  return children
}

interface AppRoutesProps {
  token: string
  user: User | null
  onLogin: (token: string, user: User) => void
  onLogout: () => void
}

export default function App () {
  const [token, setToken] = useState('')
  const [user, setUser] = useState<User | null>(null)

  useEffect(() => {
    const session = loadSession()
    if (session.token) {
      setToken(session.token)
      setAuthToken(session.token)
    }
    if (session.user) setUser(session.user)
  }, [])

  function onLogin (nextToken: string, nextUser: User) {
    setToken(nextToken)
    setUser(nextUser)
    setAuthToken(nextToken)
  }

  function onLogout () {
    setToken('')
    setUser(null)
    setAuthToken('')
    clearSession()
  }

  return (
    <BrowserRouter>
      <AppRoutes
        token={token}
        user={user}
        onLogin={onLogin}
        onLogout={onLogout}
      />
    </BrowserRouter>
  )
}

function AppRoutes ({ token, user, onLogin, onLogout }: AppRoutesProps) {
  const location = useLocation()
  const headerVisible = Boolean(token && user) && location.pathname !== '/login'

  return (
    <Layout className='app-shell'>
      {headerVisible && (
        <Header className='app-header'>
          <AppHeader user={user} onLogout={onLogout} />
        </Header>
      )}

      <Routes>
        <Route path='/' element={<HomeRedirect user={user} />} />

        <Route
          path='/login'
          element={
            token && user
              ? <HomeRedirect user={user} />
              : <LoginPage onLogin={onLogin} />
          }
        />

        <Route
          path='/admin'
          element={
            <AdminRoute token={token} user={user}>
              <AdminPage />
            </AdminRoute>
          }
        />

        <Route
          path='/inference'
          element={
            <InferenceRoute token={token} user={user}>
              <UserPage user={user} />
            </InferenceRoute>
          }
        />

        <Route
          path='*'
          element={
            <ProtectedRoute token={token}>
              <HomeRedirect user={user} />
            </ProtectedRoute>
          }
        />
      </Routes>
    </Layout>
  )
}
