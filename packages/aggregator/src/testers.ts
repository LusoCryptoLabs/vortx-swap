// packages/aggregator/src/testers.ts
//
// Gated tester whitelist and the global open/closed switch for a test round. Unlike db.ts's
// StateDB (optional, advisory intent-lifecycle tracking; main.ts keeps running without it if it
// can't open), this data is the access-control boundary: a gate that silently ran open because its
// DB failed to open would defeat its purpose. If this can't open, the aggregator refuses to start
// (see main.ts) rather than falling back to a null/permissive mode.

import Database from 'better-sqlite3'

export type TesterStatus = 'pending' | 'approved' | 'rejected'

export interface TesterRow {
  addressHash: string
  pubkey:      string
  email:       string
  status:      TesterStatus
  appliedAt:   number
  decidedAt:   number | null
}

export class TestersDB {
  private db: Database.Database

  constructor(path = './data/cellswap.db') {
    this.db = new Database(path)
    this.init()
  }

  private init(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS testers (
        address_hash TEXT PRIMARY KEY,
        pubkey       TEXT NOT NULL,
        email        TEXT NOT NULL,
        status       TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
        applied_at   INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000),
        decided_at   INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_testers_status ON testers (status);

      CREATE TABLE IF NOT EXISTS app_state (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `)
    // Closed by default on a brand-new DB. INSERT OR IGNORE so an existing deploy's flag is never
    // clobbered by a restart (e.g. the operator already opened it, a redeploy shouldn't re-close it).
    this.db.prepare(`INSERT OR IGNORE INTO app_state (key, value) VALUES ('open', '0')`).run()
  }

  // ─── Global open/closed switch ─────────────────────────────────────────────

  /** Fails closed: a missing or corrupt row reads as closed, never open-by-default. */
  isOpen(): boolean {
    const row = this.db.prepare(`SELECT value FROM app_state WHERE key = 'open'`).get() as { value: string } | undefined
    return row?.value === '1'
  }

  setOpen(open: boolean): void {
    this.db.prepare(`
      INSERT INTO app_state (key, value) VALUES ('open', ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(open ? '1' : '0')
  }

  // ─── Applicants ─────────────────────────────────────────────────────────────

  /** Cap enforcement = count of all rows ever inserted (pending, approved and rejected all count;
   *  a rejection never frees a slot, so the cap is a hard lifetime limit on applications). */
  count(): number {
    return (this.db.prepare(`SELECT COUNT(*) as n FROM testers`).get() as { n: number }).n
  }

  getByAddress(addressHash: string): TesterRow | null {
    const row = this.db.prepare(`
      SELECT address_hash as addressHash, pubkey, email, status,
             applied_at as appliedAt, decided_at as decidedAt
      FROM testers WHERE address_hash = ?
    `).get(addressHash.toLowerCase()) as TesterRow | undefined
    return row ?? null
  }

  list(status?: TesterStatus): TesterRow[] {
    const sql = `
      SELECT address_hash as addressHash, pubkey, email, status,
             applied_at as appliedAt, decided_at as decidedAt
      FROM testers ${status ? 'WHERE status = ?' : ''} ORDER BY applied_at ASC
    `
    const rows = status ? this.db.prepare(sql).all(status) : this.db.prepare(sql).all()
    return rows as TesterRow[]
  }

  /** Idempotent: a repeat apply from an address that already has a row just refreshes its email
   *  and returns the existing status. A resubmit is harmless, not an error, and does not
   *  double-count against the cap (the caller must still check count() before a first apply). */
  apply(addressHash: string, pubkey: string, email: string): TesterRow {
    const key = addressHash.toLowerCase()
    const existing = this.getByAddress(key)
    if (existing) {
      this.db.prepare(`UPDATE testers SET email = ? WHERE address_hash = ?`).run(email, key)
      return { ...existing, email }
    }
    this.db.prepare(`
      INSERT INTO testers (address_hash, pubkey, email, status) VALUES (?, ?, ?, 'pending')
    `).run(key, pubkey, email)
    return this.getByAddress(key)!
  }

  approve(addressHash: string): boolean {
    const r = this.db.prepare(`
      UPDATE testers SET status = 'approved', decided_at = ? WHERE address_hash = ?
    `).run(Date.now(), addressHash.toLowerCase())
    return r.changes > 0
  }

  reject(addressHash: string): boolean {
    const r = this.db.prepare(`
      UPDATE testers SET status = 'rejected', decided_at = ? WHERE address_hash = ?
    `).run(Date.now(), addressHash.toLowerCase())
    return r.changes > 0
  }

  close(): void { this.db.close() }
}
