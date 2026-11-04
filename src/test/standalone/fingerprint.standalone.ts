import * as assert from "node:assert/strict"
import { test } from "node:test"

import {
  fingerprintContent,
  setContentHashAlgorithmProvider,
  verifyContentFingerprint
} from "../../extension/tools/fingerprint"

test("content fingerprints match deterministic vectors and self-describe their algorithm", async () => {
  assert.equal(await fingerprintContent("", "xxh64"), "xxh64:ef46db3751d8e999")
  assert.equal(await fingerprintContent("hello", "xxh64"), "xxh64:26c7827d889f6da3")
  assert.equal(await fingerprintContent("", "xxh3_128"), "xxh3_128:99aa06d3014798d86001c324468d497f")
  assert.equal(await fingerprintContent("", "sha256"), "sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855")
})

test("fingerprint verification follows its own algorithm across default changes and accepts legacy SHA-256", async () => {
  setContentHashAlgorithmProvider(() => "xxh64")
  const xxh = await fingerprintContent("same text")
  const sha = await fingerprintContent("same text", "sha256")
  setContentHashAlgorithmProvider(() => "xxh3_128")
  assert.equal(await verifyContentFingerprint("same text", xxh), true)
  assert.equal(await verifyContentFingerprint("same text", sha), true)
  assert.equal(await verifyContentFingerprint("same text", sha.slice("sha256:".length)), true)
  assert.equal(await verifyContentFingerprint("changed", xxh), false)
  await assert.rejects(verifyContentFingerprint("same text", "xxh64:abcd"), /Invalid xxh64/)
  await assert.rejects(verifyContentFingerprint("same text", "md5:abcd"), /Unsupported/)
})

test("exact line endings are part of the content fingerprint", async () => {
  assert.notEqual(await fingerprintContent("one\ntwo\n"), await fingerprintContent("one\r\ntwo\r\n"))
})
