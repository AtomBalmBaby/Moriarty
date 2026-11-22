import * as assert from "node:assert/strict"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { test } from "node:test"

import { fingerprintContent, setContentHashAlgorithmProvider } from "../../extension/tools/fingerprint"
import { type FingerprintCandidates,normalizeFingerprint, resolveSourceTarget } from "../../extension/tools/source-resolver"
import { WorkspaceView } from "../../extension/tools/view"

const roots: string[] = []
process.once("exit", () => {
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true })
})

const fixture = (files: Record<string, string>) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "twinny-source-resolver-"))
  for (const [name, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true })
    fs.writeFileSync(path.join(root, name), text)
  }
  roots.push(root)
  return { root, view: new WorkspaceView(root) }
}

test("normal path resolution stays available and stale hashes remain hash_mismatch", async () => {
  const { root, view } = fixture({ "a.ts": "same\n" })
  const hash = await fingerprintContent("same\n")
  const exact = await resolveSourceTarget({ view }, {
    tool: "edit_lines",
    args: { path: "a.ts", expected_hash: hash },
    kind: "write",
    operation: "edit"
  })
  assert.equal(exact.ok, true)
  if (exact.ok) assert.equal(exact.via, "path")

  const stale = await resolveSourceTarget({ view }, {
    tool: "edit_lines",
    args: { path: "a.ts", expected_hash: await fingerprintContent("old\n") },
    kind: "write",
    operation: "edit"
  })
  assert.equal(stale.ok, false)
  if (!stale.ok) assert.equal(stale.detail.code, "hash_mismatch")
  fs.rmSync(root, { recursive: true, force: true })
})

test("hash-only resolution requires exactly one current authorized match", async () => {
  const { view } = fixture({ "a.ts": "same\n", "b.ts": "other\n" })
  const hash = await fingerprintContent("same\n")
  const index: FingerprintCandidates = {
    candidatesFor: async () => ["/definitely/a.ts"],
    coverage: async () => ({ complete: true, fresh: true })
  }
  index.candidatesFor = async () => [path.join(view.root, "a.ts")]

  const unique = await resolveSourceTarget({ view, index }, {
    tool: "edit_lines",
    args: { expected_hash: hash },
    kind: "write",
    operation: "edit"
  })
  assert.equal(unique.ok, true)
  if (unique.ok) assert.equal(unique.path, "a.ts")

  const ambiguousIndex: FingerprintCandidates = {
    candidatesFor: async (fingerprint) => fingerprint === hash
      ? [path.join(view.root, "a.ts"), path.join(view.root, "a.ts")]
      : [],
    coverage: async () => ({ complete: true, fresh: true })
  }
  fs.writeFileSync(path.join(view.root, "b.ts"), "same\n")
  ambiguousIndex.candidatesFor = async () => [path.join(view.root, "a.ts"), path.join(view.root, "b.ts")]
  const ambiguous = await resolveSourceTarget({ view, index: ambiguousIndex }, {
    tool: "edit_lines",
    args: { expected_hash: hash },
    kind: "write",
    operation: "edit"
  })
  assert.equal(ambiguous.ok, false)
  if (!ambiguous.ok) {
    assert.equal(ambiguous.detail.code, "ambiguous_hash")
    assert.deepEqual(ambiguous.detail.candidates, ["a.ts", "b.ts"])
  }
})

test("bounded scans never prove uniqueness", async () => {
  const { view } = fixture({ "a.ts": "same\n", "b.ts": "same\n" })
  const hash = await fingerprintContent("same\n")
  const index: FingerprintCandidates = {
    candidatesFor: async () => [path.join(view.root, "a.ts")],
    coverage: async () => ({ complete: false, fresh: false })
  }
  const result = await resolveSourceTarget({ view, index, maxScanFiles: 1 }, {
    tool: "edit_lines",
    args: { expected_hash: hash },
    kind: "write",
    operation: "edit"
  })
  assert.equal(result.ok, false)
  if (!result.ok) assert.equal(result.detail.code, "hash_unproven")
})

test("legacy bare SHA-256 fingerprints normalize correctly regardless of the configured algorithm", () => {
  setContentHashAlgorithmProvider(() => "xxh64")
  assert.equal(normalizeFingerprint("a".repeat(64)), `sha256:${"a".repeat(64)}`)
  assert.equal(normalizeFingerprint("b".repeat(16)), "xxh64:" + "b".repeat(16))
  assert.equal(normalizeFingerprint("c".repeat(32)), "xxh3_128:" + "c".repeat(32))
  assert.equal(normalizeFingerprint("d".repeat(63)), undefined)
})
