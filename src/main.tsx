import { lazy, StrictMode, Suspense } from 'react'
import { createRoot } from 'react-dom/client'
import { isTauri } from '@tauri-apps/api/core'
import './style.css'

const App = lazy(() => {
  if (isTauri()) return import('./Desktop')
  return /^\/editor\/?$/.test(window.location.pathname) ? import('./WebEditor') : import('./Website')
})

createRoot(document.getElementById('root')!).render(
  <StrictMode><Suspense fallback={null}><App /></Suspense></StrictMode>,
)
