/**
 * The synchronous SQL facade the workspace index runs on. Callers keep their
 * `run/get/rows/exec` call shapes, but every call is a plain value rather than
 * a promise, and each statement is prepared once per connection and cached.
 * Transactions are short and always synchronous: nothing here can span an
 * `await`, so in-process write locks cannot collide.
 */
import type { Database, Statement } from "better-sqlite3"

export type SqlValue = string | number | null | Buffer

export interface RunResult {
  changes: number
  lastInsertRowid: number | bigint
}

const MAX_CACHED_STATEMENTS = 200
const DEFAULT_PAGE_SIZE = 50

const preparedStatements = new WeakMap<Database, Map<string, Statement>>()

const prepare = (database: Database, sql: string): Statement => {
  let cache = preparedStatements.get(database)
  if (!cache) {
    cache = new Map<string, Statement>()
    preparedStatements.set(database, cache)
  }
  const cached = cache.get(sql)
  if (cached) return cached
  const statement = database.prepare(sql)
  cache.set(sql, statement)
  // Dynamic text such as `IN (?,?,…)` would otherwise grow the cache forever.
  if (cache.size > MAX_CACHED_STATEMENTS) cache.clear()
  return statement
}

export const run = (database: Database, sql: string, values: SqlValue[] = []): RunResult =>
  prepare(database, sql).run(values)

export const get = <T>(database: Database, sql: string, values: SqlValue[] = []): T | undefined =>
  prepare(database, sql).get(values) as T | undefined

export const rows = <T>(database: Database, sql: string, values: SqlValue[] = []): T[] =>
  prepare(database, sql).all(values) as T[]

export const exec = (database: Database, sql: string): void => {
  database.exec(sql)
}

/**
 * BEGIN IMMEDIATE … COMMIT around a synchronous closure. The closure is rolled
 * back when it throws, and a closure that returns a promise is rolled back and
 * rejected, exactly as `SqliteFile.write` refuses asynchronous work.
 */
export const transaction = <T>(database: Database, work: () => T): T => {
  const execute = database.transaction(() => {
    const result = work()
    if (result && typeof (result as { then?: unknown }).then === "function") {
      throw new Error("index transactions must complete synchronously")
    }
    return result
  })
  return execute.immediate()
}

/**
 * Visits every row of `sql` in `uri` order, `pageSize` rows at a time, yielding
 * to the event loop between pages. `sql` must select a `uri` column. The caller's
 * values are bound first; no better-sqlite3 iterator is ever held across an await.
 */
export const eachRow = async <T extends { uri: string }>(
  database: Database,
  sql: string,
  values: SqlValue[],
  visit: (row: T) => void,
  pageSize = DEFAULT_PAGE_SIZE
): Promise<number> => {
  if (!Number.isInteger(pageSize) || pageSize < 1) throw new RangeError("pageSize must be a positive integer")
  const statement = prepare(database, `SELECT * FROM (${sql}) WHERE uri > ? ORDER BY uri LIMIT ?`)
  let visited = 0
  let cursor = ""
  let page = statement.all([...values, cursor, pageSize]) as T[]
  for (;;) {
    if (page.length === 0) break
    for (const row of page) {
      visited += 1
      cursor = row.uri
      visit(row)
    }
    if (page.length < pageSize) break
    page = statement.all([...values, cursor, pageSize]) as T[]
    if (page.length === 0) break
    await new Promise((resolve) => setImmediate(resolve))
  }
  return visited
}
