import React from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ccc } from '@ckb-ccc/connector-react'
import { Toaster } from 'sonner'
import App from './App'
import { AppErrorBoundary } from './components/ErrorBoundary'
import { client, NETWORK } from './lib/cellswap'
import { installQueryPersistence } from './lib/queryPersist'
import { ThemeProvider, useTheme } from './lib/theme'
import { AppearanceProvider } from './lib/appearance'
import './index.css'

const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 10_000, refetchOnWindowFocus: false, retry: 1 } },
})
// Seed the cache from the last session's snapshot (instant first paint) + keep it persisted.
installQueryPersistence(queryClient, NETWORK)

// Toaster whose theme follows the app's live light/dark toggle (sonner's theme prop drives the
// default icon + action-button colors, which a hardcoded "dark" leaves mismatched in light mode).
function ThemedToaster() {
  const { theme } = useTheme()
  return (
    <Toaster
      position="bottom-right"
      theme={theme}
      toastOptions={{ style: { background: 'var(--surface-2)', border: '1px solid var(--border)', color: 'var(--foreground)' } }}
    />
  )
}

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ThemeProvider>
      <AppearanceProvider>
      <QueryClientProvider client={queryClient}>
        <ccc.Provider defaultClient={client as any} name="CellSwap">
          <BrowserRouter>
            <AppErrorBoundary>
              <App />
            </AppErrorBoundary>
          </BrowserRouter>
          <ThemedToaster />
        </ccc.Provider>
      </QueryClientProvider>
      </AppearanceProvider>
    </ThemeProvider>
  </React.StrictMode>
)
