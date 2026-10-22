// src/App.tsx
import { lazy, Suspense } from 'react'
import { Routes, Route, Navigate, useLocation } from 'react-router-dom'
import { Header } from './components/Header'
import { CommandPalette } from './components/CommandPalette'
import { RouteErrorBoundary } from './components/ErrorBoundary'
import { SynapseField } from './components/Synapse'
import { DataLoadingNotice } from './components/DataLoadingNotice'
import { PendingTxBanner } from './components/PendingTxBanner'
import { Skeleton } from './components/ui/skeleton'
import { MobileTabBar } from './components/MobileTabBar'
import { AccessGate } from './components/AccessGate'
import { useAccessStatus } from './hooks/useAccessStatus'

const LandingPage = lazy(() => import('./pages/LandingPage'))
const SwapPage = lazy(() => import('./pages/SwapPage'))
const ExplorePage = lazy(() => import('./pages/ExplorePage'))
const PoolsPage = lazy(() => import('./pages/PoolsPage'))
const PoolDetailPage = lazy(() => import('./pages/PoolDetailPage'))
const TokenDetailPage = lazy(() => import('./pages/TokenDetailPage'))
const PositionsPage = lazy(() => import('./pages/PositionsPage'))
const StakingPage = lazy(() => import('./pages/StakingPage'))
const MiningPage = lazy(() => import('./pages/MiningPage'))
const WalletPage = lazy(() => import('./pages/WalletPage'))

function PageFallback() {
  return (
    <div role="status" aria-live="polite" className="mx-auto max-w-6xl px-4 py-24">
      <span className="sr-only">Loading page…</span>
      <Skeleton className="h-64 rounded-2xl" />
    </div>
  )
}

export default function App() {
  // The landing (`/`) is a full-bleed marketing page with its own nav and footer; the app pages
  // share the Header chrome.
  const isLanding = useLocation().pathname === '/'
  // Access gate. The landing page is always reachable; the app chrome and routes below are hidden
  // while the test round is closed (see useAccessStatus).
  const { allowed } = useAccessStatus()
  const showChrome = !isLanding && allowed
  return (
    <div className="min-h-screen">
      <div className="glowfield" />
      <SynapseField />
      <div className="grain" />
      {showChrome && <Header />}
      {showChrome && <CommandPalette />}
      {showChrome && <PendingTxBanner />}
      {showChrome && <DataLoadingNotice />}
      <main className={`overflow-x-clip${showChrome ? ' pb-20 md:pb-0' : ''}`}>
        <RouteErrorBoundary>
          <Suspense fallback={<PageFallback />}>
            <Routes>
              <Route path="/" element={<LandingPage />} />
              <Route element={<AccessGate />}>
                <Route path="/swap" element={<SwapPage />} />
                <Route path="/explore" element={<ExplorePage />} />
                <Route path="/explore/tokens/:args" element={<TokenDetailPage />} />
                <Route path="/pools" element={<PoolsPage />} />
                <Route path="/pools/:id" element={<PoolDetailPage />} />
                <Route path="/positions" element={<PositionsPage />} />
                <Route path="/staking" element={<StakingPage />} />
                <Route path="/mining" element={<MiningPage />} />
                <Route path="/wallet" element={<WalletPage />} />
                <Route path="*" element={<Navigate to="/swap" replace />} />
              </Route>
            </Routes>
          </Suspense>
        </RouteErrorBoundary>
      </main>
      {showChrome && (
        <footer className="mx-auto max-w-6xl text-balance px-4 pb-[max(5.5rem,calc(env(safe-area-inset-bottom)+4rem))] pt-8 text-center text-xs text-faint md:pb-[max(2rem,env(safe-area-inset-bottom))]">
          Custody-free exchange on Nervos CKB<span className="hidden md:inline"> · ⌘K to search</span> · the pool's own code sets the price, no company in the middle
        </footer>
      )}
      {showChrome && <MobileTabBar />}
    </div>
  )
}
