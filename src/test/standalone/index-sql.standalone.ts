import BetterSqlite from "better-sqlite3"
import assert from "node:assert/strict"
import { test } from "node:test"

import { eachRow, exec, get, rows, run, transaction } from "../../extension/workspace-index/sql"

type Traced = { database: BetterSqlite.Database; prepared: string[]; close: () => void }

/** A real in-memory database whose `prepare` calls are counted, so statement reuse is observable. */
const openDatabase = (): Traced => {
  const database = new BetterSqlite(":memory:")
  const prepared: string[] = []
  const realPrepare = database.prepare.bind(database)
  database.prepare = ((sql: string) => {
    prepared.push(sql)
    return realPrepare(sql)
  }) as typeof database.prepare
  database.exec("CREATE TABLE documents (uri TEXT PRIMARY KEY, text TEXT NOT NULL)")
  return { database, prepared, close: () => database.close() }
}

const countRows = (database: BetterSqlite.Database): number =>
  (get<{ n: number }>(database, "SELECT count(*) AS n FROM documents") ?? { n: -1 }).n

const insertRow = (database: BetterSqlite.Database, uri: string, text: string): void => {
  run(database, "INSERT INTO documents (uri, text) VALUES (?, ?)", [uri, text])
}

test("run, get, rows and exec return plain values and reuse prepared statements", () => {
  const opened = openDatabase()
  try {
    const create = "CREATE TABLE IF NOT EXISTS counted (uri TEXT PRIMARY KEY, text TEXT NOT NULL)"
    const insert = "INSERT INTO counted (uri, text) VALUES (?, ?)"
    const selectOne = "SELECT uri, text FROM counted WHERE uri = ?"
    const selectAll = "SELECT uri FROM counted ORDER BY uri"
    const clear = "DELETE FROM counted"

    exec(opened.database, create)
    exec(opened.database, "INSERT INTO counted (uri, text) VALUES ('compound-a', 'one'); INSERT INTO counted (uri, text) VALUES ('compound-b', 'two')")
    assert.equal(rows<{ uri: string }>(opened.database, selectAll).length, 2)
    exec(opened.database, clear)
    const first = run(opened.database, insert, ["a.ts", "one"])
    assert.ok(!(first instanceof Promise))
    assert.deepEqual(first, { changes: 1, lastInsertRowid: 1 })
    assert.ok(!(get(opened.database, selectOne, ["a.ts"]) instanceof Promise))
    assert.ok(!(rows(opened.database, selectAll) instanceof Promise))
    assert.equal(exec(opened.database, clear), undefined)
    assert.deepEqual(opened.prepared, [selectAll, insert, selectOne])

    // every statement text is prepared once, however often it is used
    run(opened.database, insert, ["b.ts", "two"])
    assert.deepEqual(get<{ uri: string; text: string }>(opened.database, selectOne, ["b.ts"]), { uri: "b.ts", text: "two" })
    assert.equal(rows<{ uri: string }>(opened.database, selectAll).length, 1)
    exec(opened.database, clear)
    assert.equal(opened.prepared.length, 3)

    for (let index = 0; index < 201; index += 1) run(opened.database, `SELECT ${index}`)
    assert.ok(opened.prepared.length > 200)
    run(opened.database, insert, ["c.ts", "three"])
    assert.ok(opened.prepared.length > 200)
  } finally {
    opened.close()
  }
})

test("transaction commits its writes and rolls back everything when the closure throws", () => {
  const opened = openDatabase()
  try {
    transaction(opened.database, () => insertRow(opened.database, "a.ts", "kept"))
    assert.equal(countRows(opened.database), 1)

    assert.throws(() => transaction(opened.database, () => {
      insertRow(opened.database, "b.ts", "rolled back")
      throw new Error("the closure failed")
    }), /the closure failed/)
    assert.equal(countRows(opened.database), 1)
    assert.equal(get(opened.database, "SELECT text FROM documents WHERE uri = ?", ["b.ts"]), undefined)

    transaction(opened.database, () => insertRow(opened.database, "c.ts", "after the rollback"))
    assert.equal(countRows(opened.database), 2)
  } finally {
    opened.close()
  }
})

test("transaction rejects a closure that returns a promise and leaves nothing written", async () => {
  const opened = openDatabase()
  try {
    await assert.rejects(async () => {
      transaction(opened.database, () => {
        insertRow(opened.database, "a.ts", "not written")
        return Promise.resolve("the closure is asynchronous")
      })
    }, /must complete synchronously/)
    assert.equal(countRows(opened.database), 0)
    transaction(opened.database, () => insertRow(opened.database, "b.ts", "written"))
    assert.equal(countRows(opened.database), 1)
  } finally {
    opened.close()
  }
})

test("eachRow visits every row once, in uri order, across page boundaries (page size 2 over 5 rows), with the caller's bound parameters", async () => {
  const opened = openDatabase()
  try {
    for (const uri of ["c.ts", "a.ts", "e.ts", "b.ts", "d.ts"]) insertRow(opened.database, uri, "token")
    const visited: string[] = []
    const visitedCount = await eachRow<{ uri: string; text: string }>(
      opened.database,
      "SELECT uri, text FROM documents WHERE text = ?",
      ["token"],
      (row) => {
        assert.equal(row.text, "token")
        visited.push(row.uri)
      },
      2
    )
    assert.equal(visitedCount, 5)
    assert.deepEqual(visited, ["a.ts", "b.ts", "c.ts", "d.ts", "e.ts"])
  } finally {
    opened.close()
  }
})

test("eachRow yields to the event loop between pages", async () => {
  const opened = openDatabase()
  try {
    for (const uri of ["a.ts", "b.ts", "c.ts", "d.ts", "e.ts"]) insertRow(opened.database, uri, "token")
    const order: string[] = []
    setImmediate(() => order.push("yielded"))
    await eachRow(opened.database, "SELECT uri FROM documents", [], (row) => {
      order.push(row.uri)
    }, 2)
    assert.deepEqual(order, ["a.ts", "b.ts", "yielded", "c.ts", "d.ts", "e.ts"])
  } finally {
    opened.close()
  }
})

test("eachRow propagates an error thrown by the visitor and by an invalid query", async () => {
  const opened = openDatabase()
  try {
    insertRow(opened.database, "a.ts", "token")
    await assert.rejects(eachRow(opened.database, "SELECT uri FROM documents", [], () => {
      throw new Error("the visitor failed")
    }), /the visitor failed/)
    await assert.rejects(eachRow(opened.database, "SELECT uri FROM nowhere", [], () => undefined), /nowhere/)
  } finally {
    opened.close()
  }
})
