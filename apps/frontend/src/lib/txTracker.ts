// Global transaction tracker. Wrap any submit that returns a tx hash with trackTx() to:
//   1. drive the app-wide <PendingTxBanner/> (signing → confirming), and
//   2. wait for on-chain confirmation before resolving, so the caller's button stays disabled and
//      its success toast only fires once the tx is actually mined, not merely submitted.
//
// Persistence: the `confirming` phase (we already have a tx hash) is mirrored to localStorage, so a
// page refresh while a tx is still being mined re-shows the banner and resumes the on-chain wait.
// The indicator stays until the tx confirms instead of vanishing on reload.
// The `signing` phase is not persisted: there's no hash to resume and the wallet prompt
// is gone after a reload, so a refresh mid-signing simply clears (the tx was never broadcast).
//
// A tiny external store (useSyncExternalStore) so any component can read the pending state.
import { useSyncExternalStore } from 'react'
import { client, NETWORK } from './cellswap'

export type TxPhase = 'signing' | 'confirming'
interface TxState { active: number; label: string | null; txHash: string | null; phase: TxPhase | null }

// One confirming tx, as persisted. startedAt lets us drop entries that never mined (stale) on reload.
interface PendingEntry { txHash: string; label: string; startedAt: number }

const LS_KEY = `cellswap-pending-tx-${NETWORK}`
const CONFIRM_TIMEOUT = 180_000        // how long a live trackTx waits for a fresh tx
const STALE_MS = 15 * 60_000           // a tx unconfirmed for >15 min is treated as dead; stop showing it
const RESUME_TIMEOUT = 10 * 60_000     // cap on how long a resumed wait keeps the banner up

// ── internal mutable model ──────────────────────────────────────────────────
// signing = the ephemeral "confirm in your wallet" overlay (at most one at a time, not persisted).
// pending = the confirming txs (persisted; survive a refresh).
let signing: { label: string } | null = null
let pending: PendingEntry[] = []

// Derived snapshot handed to consumers. Recomputed only on mutation so getSnapshot() returns a
// stable reference between renders (required by useSyncExternalStore; a fresh object on every call loops).
let snapshot: TxState = { active: 0, label: null, txHash: null, phase: null }
const listeners = new Set<() => void>()

function emit() {
  const active = pending.length + (signing ? 1 : 0)
  if (signing) {
    snapshot = { active, label: signing.label, txHash: null, phase: 'signing' }
  } else if (pending.length) {
    const last = pending[pending.length - 1]
    snapshot = { active, label: last.label, txHash: last.txHash, phase: 'confirming' }
  } else {
    snapshot = { active: 0, label: null, txHash: null, phase: null }
  }
  listeners.forEach(l => l())
}

function persist() {
  try { localStorage.setItem(LS_KEY, JSON.stringify(pending)) } catch { /* private mode / quota, non-fatal */ }
}

function addPending(txHash: string, label: string) {
  if (!pending.some(p => p.txHash === txHash)) pending = [...pending, { txHash, label, startedAt: Date.now() }]
  persist()
}
function removePending(txHash: string) {
  pending = pending.filter(p => p.txHash !== txHash)
  persist()
}

function subscribe(l: () => void) { listeners.add(l); return () => { listeners.delete(l) } }
function getSnapshot() { return snapshot }

/** Run a tx submit, show it in the global banner, and wait until it's confirmed on-chain. */
export async function trackTx(label: string, submit: () => Promise<string>): Promise<string> {
  signing = { label }; emit()
  let txHash: string
  try {
    txHash = await submit()
  } catch (e) {
    signing = null; emit()            // never broadcast, so clear the banner
    throw e
  }
  // Submitted: atomically swap the ephemeral signing overlay for a persisted confirming entry
  // (single emit → no flicker to zero, and it's now durable against a refresh).
  signing = null
  addPending(txHash, label); emit()
  try {
    await client.waitTransaction(txHash, 0, CONFIRM_TIMEOUT)
    return txHash
  } finally {
    removePending(txHash); emit()
  }
}

/** Read the current pending-tx state (re-renders on change). */
export function useTxStatus(): TxState {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}

// ── Rehydrate on load: re-show any tx that was still confirming when the page reloaded, and resume
//    waiting for it so the banner clears itself once it mines (or after a stale/timeout cutoff). ──
;(function resumePersisted() {
  let saved: PendingEntry[] = []
  try { saved = JSON.parse(localStorage.getItem(LS_KEY) || '[]') } catch { saved = [] }
  if (!Array.isArray(saved)) saved = []
  const now = Date.now()
  // Drop anything malformed or older than the stale cutoff (a tx not mined in 15 min is effectively dead).
  pending = saved.filter(e => e && typeof e.txHash === 'string' && now - (e.startedAt ?? 0) < STALE_MS)
  if (pending.length !== saved.length) persist()
  if (!pending.length) return
  emit()
  for (const e of pending) {
    const remaining = Math.max(30_000, RESUME_TIMEOUT - (now - e.startedAt))
    client.waitTransaction(e.txHash, 0, remaining)
      .catch(() => { /* timed out or dropped: clear it below either way */ })
      .finally(() => { removePending(e.txHash); emit() })
  }
})()
