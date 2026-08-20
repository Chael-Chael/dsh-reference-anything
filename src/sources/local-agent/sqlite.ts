/**
 * The one place `node:sqlite` is touched.
 *
 * Three of the supported agents keep their history in SQLite rather than in a
 * file per conversation, so reading them needs a database driver. Node has one
 * built in — but only since 22.5, and it still prints an experimental warning
 * on load. Both facts argue for the same shape: import it lazily, from here,
 * and treat its absence as "that format is unreadable on this runtime" rather
 * than as a failure of the plugin. A user with no opencode install never pays
 * for it, because nothing below runs until a database file has actually been
 * found on disk.
 *
 * @module dsh-reference-anything/local-agent/sqlite
 */

import type { SqliteReader } from './types.ts'

/** The slice of `node:sqlite`'s `DatabaseSync` used here. */
interface Database {
  prepare(sql: string): { all(...params: readonly (string | number)[]): unknown[] }
  close(): void
}

type DatabaseConstructor = new (path: string, options?: { readOnly?: boolean }) => Database

/**
 * Resolved driver, or `null` once the runtime has been found not to have one.
 *
 * Cached either way: a Node without `node:sqlite` will not grow one mid-process,
 * and repeating the failed import per keystroke would be pure cost.
 */
let driver: DatabaseConstructor | null | undefined

/**
 * Load Node's SQLite driver, once.
 * @returns the constructor, or undefined on a runtime that has no `node:sqlite`.
 */
export async function sqliteDriver(): Promise<DatabaseConstructor | undefined> {
  if (driver !== undefined) return driver ?? undefined
  try {
    const module = await import('node:sqlite') as { DatabaseSync?: DatabaseConstructor }
    driver = module.DatabaseSync ?? null
  } catch {
    // Node older than 22.5, or a build compiled without SQLite. Neither is an
    // error here — the three database-backed formats simply do not list.
    driver = null
  }
  return driver ?? undefined
}

/**
 * Open a database read-only and hand its reader to `use`.
 *
 * The handle never escapes: every query a caller wants happens inside the
 * callback, and the database is closed on the way out however that goes. A
 * database that cannot be opened at all — missing, locked by a live agent
 * holding an exclusive lock, or not SQLite — yields `undefined` rather than
 * throwing, because an agent's own database being busy is an ordinary state and
 * must not take the `@` menu down with it.
 * @param path - absolute path to the database file.
 * @param use - what to read from it.
 * @returns whatever `use` returned, or undefined when the database was unusable.
 */
export async function withDatabase<T>(
  path: string,
  use: (db: SqliteReader) => T,
): Promise<T | undefined> {
  const DatabaseSync = await sqliteDriver()
  if (DatabaseSync === undefined) return undefined
  let handle: Database
  try {
    handle = new DatabaseSync(path, { readOnly: true })
  } catch {
    return undefined
  }
  try {
    return use(readerFor(handle))
  } catch {
    // A schema this build does not recognise reads as "no conversations here",
    // which is what a user of a *different* agent's database would expect.
    return undefined
  } finally {
    try {
      handle.close()
    } catch {
      // Closing a database that failed to open properly is not worth a report.
    }
  }
}

/** Wrap a live handle in the read-only surface adapters are given. */
function readerFor(handle: Database): SqliteReader {
  const columnCache = new Map<string, ReadonlySet<string>>()
  return {
    all(sql, ...params) {
      return handle.prepare(sql).all(...params).filter(isRow)
    },
    columns(table) {
      const cached = columnCache.get(table)
      if (cached !== undefined) return cached
      let names: ReadonlySet<string>
      try {
        // The table name cannot be bound as a parameter in a PRAGMA, so it is
        // constrained instead: only a plain identifier is ever passed, and
        // anything else yields an empty set rather than reaching SQLite.
        names = /^[A-Za-z_][A-Za-z0-9_]*$/u.test(table)
          ? new Set(handle.prepare(`PRAGMA table_info(${table})`).all()
            .filter(isRow)
            .map(row => String(row['name'])))
          : new Set()
      } catch {
        names = new Set()
      }
      columnCache.set(table, names)
      return names
    },
  }
}

function isRow(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
