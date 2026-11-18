import BetterSqlite from "better-sqlite3"
import assert from "node:assert/strict"
import { test } from "node:test"

import { homePathOfDatabase, SOURCE_ROOT_SCHEMA, SourceRoots, toPosixPath } from "../../extension/todos/source-roots"

type Roots = { roots: SourceRoots; database: BetterSqlite.Database; close: () => void }

const openRoots = (home: string): Roots => {
  const database = new BetterSqlite(":memory:")
  database.exec(SOURCE_ROOT_SCHEMA)
  return { roots: new SourceRoots(database, home), database, close: () => database.close() }
}

const rootCount = (database: BetterSqlite.Database): number =>
  (database.prepare("SELECT count(*) AS n FROM source_root").get() as { n: number }).n

const row = (database: BetterSqlite.Database, rootId: string): { kind: string; locator: string } =>
  database.prepare("SELECT kind, locator FROM source_root WHERE root_id = ?").get(rootId) as { kind: string; locator: string }

test("the home root is created once and keeps its root id when the project folder moves", () => {
  const opened = openRoots("/project")
  try {
    const first = opened.roots.home()
    assert.equal(first.kind, "home")
    assert.equal(first.locator, "/project")
    assert.equal(first.label, "project")
    assert.equal(opened.roots.home().rootId, first.rootId)
    assert.equal(rootCount(opened.database), 1)

    const moved = new SourceRoots(opened.database, "/moved/project")
    const rebound = moved.home()
    assert.equal(rebound.rootId, first.rootId)
    assert.equal(rebound.locator, "/moved/project")
    assert.equal(row(opened.database, first.rootId).locator, "/moved/project")
    assert.equal(rootCount(opened.database), 1)
  } finally {
    opened.close()
  }
})

test("locate picks the longest matching root and never confuses /p with /p2", () => {
  const opened = openRoots("/p")
  try {
    const home = opened.roots.home()
    const nested = opened.roots.register("/p/src", "the source folder")
    assert.deepEqual(opened.roots.locate("/p/src/a.ts"), { rootId: nested.rootId, path: "a.ts" })
    assert.deepEqual(opened.roots.locate("/p/b.ts"), { rootId: home.rootId, path: "b.ts" })
    assert.equal(opened.roots.locate("/p").path, ".")
    // /p2 is a sibling of /p, so only the filesystem root covers it.
    const sibling = opened.roots.locate("/p2/x.ts")
    assert.equal(opened.roots.byId(sibling.rootId)?.kind, "external")
    assert.equal(sibling.path, "p2/x.ts")
    assert.equal(opened.roots.absolutePath(sibling), "/p2/x.ts")
  } finally {
    opened.close()
  }
})

test("a path outside every root gets the single external filesystem root, so external files keep an absolute identity", () => {
  const opened = openRoots("/project")
  try {
    const home = opened.roots.home()
    opened.roots.register("/project/packages", "a workspace folder")
    const location = opened.roots.locate("/etc/nginx/nginx.conf")
    const external = opened.roots.byId(location.rootId)
    assert.equal(external?.kind, "external")
    assert.equal(external?.locator, "/")
    assert.equal(external?.label, "filesystem")
    assert.equal(external?.rootId, opened.roots.locate("/tmp/test.log").rootId)
    assert.equal(rootCount(opened.database), 3)
    assert.deepEqual(location, { rootId: external?.rootId, path: "etc/nginx/nginx.conf" })
    assert.equal(opened.roots.absolutePath(location), "/etc/nginx/nginx.conf")
    assert.equal(opened.roots.canonicalPath(location), "/etc/nginx/nginx.conf")
    assert.notEqual(external?.rootId, home.rootId)
  } finally {
    opened.close()
  }
})

test("canonical paths are home-relative under home and absolute elsewhere, and round-trip through fromCanonical", () => {
  const opened = openRoots("/project")
  try {
    const home = opened.roots.home()
    const other = opened.roots.register("/other", "a second root")
    const inside = opened.roots.locate("/project/src/a.ts")
    assert.deepEqual(inside, { rootId: home.rootId, path: "src/a.ts" })
    assert.equal(opened.roots.canonicalPath(inside), "src/a.ts")
    assert.deepEqual(opened.roots.fromCanonical("src/a.ts"), inside)

    const outside = opened.roots.locate("/other/x.ts")
    assert.deepEqual(outside, { rootId: other.rootId, path: "x.ts" })
    assert.equal(opened.roots.canonicalPath(outside), "/other/x.ts")
    assert.deepEqual(opened.roots.fromCanonical("/other/x.ts"), outside)

    // A root inside the home answers with the home-relative string, and the
    // canonical string round-trips even when that nested root owns the path.
    const nested = opened.roots.register("/project/packages", "a nested root")
    const hit = opened.roots.locate("/project/packages/lib.ts")
    assert.deepEqual(hit, { rootId: nested.rootId, path: "lib.ts" })
    assert.equal(opened.roots.canonicalPath(hit), "packages/lib.ts")
    assert.deepEqual(opened.roots.fromCanonical("packages/lib.ts"), hit)
    // A relative path that escapes the home is resolved first, then located.
    const escaped = opened.roots.fromCanonical("../outside.txt")
    assert.equal(opened.roots.byId(escaped.rootId)?.kind, "external")
    assert.equal(escaped.path, "outside.txt")
    assert.equal(opened.roots.canonicalPath(escaped), "/outside.txt")
    assert.equal(opened.roots.canonicalPath(opened.roots.locate("/project")), ".")
  } finally {
    opened.close()
  }
})

test("registering a workspace root is idempotent, is used by locate, and canonicalPath of a file in it is absolute", () => {
  const opened = openRoots("/p")
  try {
    const home = opened.roots.home()
    const first = opened.roots.register("/q", "the second folder")
    const again = opened.roots.register("/q/", "another label")
    assert.equal(again.rootId, first.rootId)
    assert.equal(again.kind, "workspace")
    assert.equal(again.label, "the second folder")
    assert.equal(rootCount(opened.database), 2)
    assert.deepEqual(opened.roots.locate("/q/a.ts"), { rootId: first.rootId, path: "a.ts" })
    assert.equal(opened.roots.canonicalPath(opened.roots.locate("/q/a.ts")), "/q/a.ts")
    assert.equal(opened.roots.register("/p", "the home").rootId, home.rootId)
  } finally {
    opened.close()
  }
})

test("dot segments, duplicate separators and backslashes are normalized before matching; a relative path is rejected by locate", () => {
  const opened = openRoots("/p")
  try {
    const nested = opened.roots.register("/p/src", "the source folder")
    const home = opened.roots.home()
    assert.deepEqual(opened.roots.locate("/p/src/../x.ts"), { rootId: home.rootId, path: "x.ts" })
    assert.deepEqual(opened.roots.locate("/p//src//a.ts"), { rootId: nested.rootId, path: "a.ts" })
    assert.deepEqual(opened.roots.locate("/p/src\\a.ts"), { rootId: nested.rootId, path: "a.ts" })
    assert.equal(toPosixPath("/p/"), "/p")
    assert.equal(toPosixPath("/"), "/")
    assert.equal(toPosixPath("C:/tmp/x.ts"), "C:/tmp/x.ts")
    // A drive path keeps its drive root, so it round-trips to the same string.
    const drive = opened.roots.locate("C:\\tmp\\x.ts")
    assert.equal(opened.roots.byId(drive.rootId)?.kind, "external")
    assert.equal(opened.roots.byId(drive.rootId)?.locator, "C:/")
    assert.equal(drive.path, "tmp/x.ts")
    assert.equal(opened.roots.absolutePath(drive), "C:/tmp/x.ts")
    assert.throws(() => opened.roots.locate("src/a.ts"), /not an absolute path/)
  } finally {
    opened.close()
  }
})

test("homePathOfDatabase maps <project>/.twinny/project.sqlite to <project> and <dir>/todos.sqlite to <dir>", () => {
  assert.equal(homePathOfDatabase("/project/.twinny/project.sqlite"), "/project")
  assert.equal(homePathOfDatabase("/dir/todos.sqlite"), "/dir")
  assert.equal(homePathOfDatabase("C:\\project\\.twinny\\project.sqlite"), "C:/project")
  const opened = openRoots(homePathOfDatabase("/project/.twinny/project.sqlite"))
  try {
    assert.equal(opened.roots.home().locator, "/project")
    assert.deepEqual(opened.roots.locate("/project/src/a.ts"), { rootId: opened.roots.home().rootId, path: "src/a.ts" })
  } finally {
    opened.close()
  }
})

test("a rebind onto a locator already owned by another root is reported, not silently merged", () => {
  const opened = openRoots("/project")
  try {
    const home = opened.roots.home()
    const shared = opened.roots.register("/shared", "a shared folder")
    assert.throws(
      () => new SourceRoots(opened.database, "/shared").home(),
      /The project folder \/shared is already registered as a workspace root of this database/
    )
    assert.equal(row(opened.database, home.rootId).locator, "/project")
    assert.equal(row(opened.database, shared.rootId).kind, "workspace")
    assert.equal(rootCount(opened.database), 2)
  } finally {
    opened.close()
  }
})
