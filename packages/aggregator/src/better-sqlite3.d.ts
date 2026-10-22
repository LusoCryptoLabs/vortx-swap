// Minimal ambient declaration for better-sqlite3 (optional runtime dependency).
// For full types: npm i -D @types/better-sqlite3
declare module 'better-sqlite3' {
  interface Statement { run(...p: unknown[]): { changes: number; lastInsertRowid: number | bigint }; get(...p: unknown[]): unknown; all(...p: unknown[]): unknown[] }
  interface DatabaseInstance { prepare(sql: string): Statement; exec(sql: string): void; close(): void; transaction<T extends (...a: unknown[]) => unknown>(fn: T): T }
  interface DatabaseConstructor {
    new (path: string): DatabaseInstance
    (path: string): DatabaseInstance
  }
  namespace Database {
    type Database = DatabaseInstance
    type Statement = import('better-sqlite3').Statement
  }
  const Database: DatabaseConstructor
  export = Database
}
