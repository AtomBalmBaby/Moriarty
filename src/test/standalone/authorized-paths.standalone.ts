/**
 * What `twinny.chatToolsAllowedPaths` can grant, read as plain path work:
 * the same rules the view and the edit service use. Nothing here touches the
 * filesystem, so a path is judged by what was written, not by what is there.
 */
import * as assert from "node:assert"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"

import { authorizedRootOf, normalizeAuthorizedRoots } from "../../extension/tools/authorized-paths"

const HOME = path.resolve("/home/me")

test("an entry is taken as it was written: ~ is home, and a relative, blank or whole-disk entry grants nothing", () => {
  assert.deepStrictEqual(normalizeAuthorizedRoots(["~/notes", "~"], HOME), [path.join(HOME, "notes"), HOME])
  assert.deepStrictEqual(normalizeAuthorizedRoots(["notes", "", "   "], HOME), [], "a relative entry is not a folder")
  assert.deepStrictEqual(normalizeAuthorizedRoots(["/", " / "], HOME), [], "authorizing the whole disk is not a folder grant")
  assert.deepStrictEqual(normalizeAuthorizedRoots(["/srv/data/"], HOME), ["/srv/data"], "a trailing separator is dropped")
  assert.deepStrictEqual(normalizeAuthorizedRoots(["/srv/data", "/srv/data/", "/srv/data"], HOME), ["/srv/data"], "the same folder is granted once")
  assert.deepStrictEqual(normalizeAuthorizedRoots(["~"], HOME), [HOME], "home is read when no home is given")
  assert.deepStrictEqual(normalizeAuthorizedRoots(["~/notes"], os.homedir()), [path.resolve(os.homedir(), "notes")])
})

test("the longest granted folder holding a path wins, and a folder that only shares its name does not hold it", () => {
  assert.strictEqual(authorizedRootOf("/srv/data/a.ts", ["/srv", "/srv/data"]), "/srv/data", "the longest grant")
  assert.strictEqual(authorizedRootOf("/srv/data", ["/srv/data"]), "/srv/data", "the granted folder itself is inside it")
  assert.strictEqual(authorizedRootOf("/srv/data2/a.ts", ["/srv/data"]), undefined, "a common prefix is not a folder")
  assert.strictEqual(authorizedRootOf("srv/data/a.ts", ["/srv/data"]), undefined, "the path itself has to be a folder path")
  assert.strictEqual(authorizedRootOf("/srv/data/a.ts", ["srv/data"]), undefined, "an entry that is not a grant is skipped")
})
