// src/lib/activity.ts: a small, device-local "recent activity" log so a finished action leaves a trace.
// The pending-tx banner (txTracker) covers in-flight txs; this records the outcome durably so a returning
// user can confirm "yes, my swap happened" instead of landing on an empty screen and assuming funds vanished.
// Scoped per network. This is device-local (localStorage) and labelled as such in the UI: a reliable
// fallback, not a chain-indexed history.
import { useSyncExternalStore } from 'react'
import { NETWORK } from './cellswap'

export type ActivityKind = 'swap' | 'order' | 'batch' | 'send' | 'liquidity' | 'stake'
export interface ActivityItem {
  id: string                                   // tx hash, or a unique id for non-tx actions
  kind: ActivityKind
  status: 'completed' | 'pending' | 'failed'
  summary: string                              // plain-English one-liner, e.g. "Swapped 20 CKB for 1,234 VTX"
  txHash?: string
  ts: number                                   // Date.now() when recorded
}

const LS_KEY = `cellswap-activity-${NETWORK}`
const MAX = 40

let items: ActivityItem[] = load()
const listeners = new Set<() => void>()

function load(): ActivityItem[] {
  try {
    const raw = JSON.parse(localStorage.getItem(LS_KEY) || '[]')
    return Array.isArray(raw) ? raw.filter((x: any) => x && typeof x.id === 'string') : []
  } catch { return [] }
}
function persist() {
  try { localStorage.setItem(LS_KEY, JSON.stringify(items)) } catch { /* quota / private mode, non-fatal */ }
}
function emit() { listeners.forEach(l => l()) }

/** Record a finished (or failed) user action. Re-recording the same id replaces the old entry
 *  (so a 'pending' can be promoted to 'completed' later). Newest first; capped at MAX. */
export function recordActivity(item: Omit<ActivityItem, 'ts'> & { ts?: number }) {
  const entry: ActivityItem = { ts: Date.now(), ...item }
  items = [entry, ...items.filter(i => i.id !== entry.id)].slice(0, MAX)
  persist(); emit()
}

export function clearActivity() { items = []; persist(); emit() }

function subscribe(l: () => void) { listeners.add(l); return () => { listeners.delete(l) } }
function getSnapshot() { return items }   // stable ref between renders (only reassigned on mutation)

/** Newest-first list of recent activity recorded on this device. Re-renders on change. */
export function useActivity(): ActivityItem[] {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}
