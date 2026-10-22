// db.ts: SQLite state tracking for intent lifecycle
// Prevents re-processing settled/cancelled intents

import Database from 'better-sqlite3'
import type { OutPoint, TxHash } from '@cellswap/types'

type IntentState = 'pending' | 'settled' | 'cancelled' | 'expired'

export class StateDB {
  private db: Database.Database

  constructor(path = './data/cellswap.db') {
    this.db = new Database(path)
    this.init()
  }

  private init(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS intents (
        tx_hash   TEXT NOT NULL,
        index_    INTEGER NOT NULL,
        state     TEXT NOT NULL DEFAULT 'pending',
        settled_tx TEXT,
        created_at INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000),
        updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000),
        PRIMARY KEY (tx_hash, index_)
      );

      CREATE INDEX IF NOT EXISTS idx_state ON intents (state);
      CREATE INDEX IF NOT EXISTS idx_created ON intents (created_at);

      CREATE TABLE IF NOT EXISTS settlements (
        tx_hash    TEXT PRIMARY KEY,
        intent_count INTEGER,
        settled_at  INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000)
      );
    `)
  }

  markSettled(outpoints: OutPoint[], settlementTx: TxHash): void {
    const stmt = this.db.prepare(`
      UPDATE intents SET state = 'settled', settled_tx = ?, updated_at = ?
      WHERE tx_hash = ? AND index_ = ?
    `)
    const now = Date.now()
    const run = this.db.transaction(() => {
      for (const op of outpoints) {
        stmt.run(settlementTx, now, op.txHash, op.index)
      }
      this.db.prepare(`
        INSERT OR IGNORE INTO settlements (tx_hash, intent_count) VALUES (?, ?)
      `).run(settlementTx, outpoints.length)
    })
    run()
  }

  markCancelled(outpoint: OutPoint, cancelTx: TxHash): void {
    this.db.prepare(`
      UPDATE intents SET state = 'cancelled', settled_tx = ?, updated_at = ?
      WHERE tx_hash = ? AND index_ = ?
    `).run(cancelTx, Date.now(), outpoint.txHash, outpoint.index)
  }

  markExpired(outpoint: OutPoint): void {
    this.db.prepare(`
      UPDATE intents SET state = 'expired', updated_at = ?
      WHERE tx_hash = ? AND index_ = ?
    `).run(Date.now(), outpoint.txHash, outpoint.index)
  }

  isKnown(outpoint: OutPoint): boolean {
    const row = this.db.prepare(`
      SELECT state FROM intents WHERE tx_hash = ? AND index_ = ?
    `).get(outpoint.txHash, outpoint.index) as { state: string } | undefined
    return row !== undefined && row.state !== 'pending'
  }

  upsertPending(outpoint: OutPoint): void {
    this.db.prepare(`
      INSERT OR IGNORE INTO intents (tx_hash, index_, state) VALUES (?, ?, 'pending')
    `).run(outpoint.txHash, outpoint.index)
  }

  getStats(): { pending: number; settled: number; cancelled: number; expired: number } {
    const rows = this.db.prepare(`
      SELECT state, COUNT(*) as count FROM intents GROUP BY state
    `).all() as Array<{ state: string; count: number }>
    const result = { pending: 0, settled: 0, cancelled: 0, expired: 0 }
    for (const row of rows) {
      if (row.state in result) result[row.state as keyof typeof result] = row.count
    }
    return result
  }

  // Prune settled/cancelled records older than 7 days
  prune(): number {
    const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000
    const result = this.db.prepare(`
      DELETE FROM intents WHERE state != 'pending' AND updated_at < ?
    `).run(cutoff)
    return result.changes
  }

  close(): void {
    this.db.close()
  }
}
