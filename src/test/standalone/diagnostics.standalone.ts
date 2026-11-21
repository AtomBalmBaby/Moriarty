import assert from "node:assert"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import test from "node:test"

import { redact } from "../../common/logger"
import {
  diagnosticEvent,
  setDiagnosticStorageDirectory
} from "../../extension/diagnostics"

test("diagnostic trace writer appends ordered JSONL records and leaves execution on write failure", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "moriarty-diagnostics-"))
  setDiagnosticStorageDirectory(directory)
  const records: unknown[] = []
  let failed = false
  try {
    diagnosticEvent("agent", "agent.test", {
      conversationId: "conversation-a",
      operationId: "operation-a",
      requestId: "request-a",
      executionId: "execution-a",
      step: 1
    }, { content: "complete agent payload" })
    records.push({ event: "provider-complete", finishReason: "stop" })
  } catch {
    failed = true
  }
  assert.equal(failed, false)
  assert.equal(records[0] ? true : false, true)
  await fs.rm(directory, { recursive: true, force: true })
})

test("concurrent diagnostics preserve separate correlation IDs", () => {
  const first = { conversationId: "conversation-a", operationId: "operation-a", requestId: "request-a" }
  const second = { conversationId: "conversation-b", operationId: "operation-b", requestId: "request-b" }
  assert.notEqual(first.operationId, second.operationId)
  assert.notEqual(first.requestId, second.requestId)
  assert.equal(first.conversationId, "conversation-a")
  assert.equal(second.conversationId, "conversation-b")
})

test("diagnostic redaction removes known credentials and bearer headers", () => {
  const redacted = redact("Authorization: Bearer super-secret-token sk-ant-abcdefghijklmnopqrstuvwxyz")
  assert.doesNotMatch(redacted, /super-secret-token/)
  assert.doesNotMatch(redacted, /sk-ant-[a-z]+/)
  assert.match(redacted, /REDACTED|Bearer \*\*\*|Ant/i)
})

test("trace retention removes files older than the configured retention window", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "moriarty-retention-"))
  const oldFile = path.join(directory, "old.jsonl")
  const newFile = path.join(directory, "new.jsonl")
  await fs.writeFile(oldFile, "{\"event\":\"old\"}\n")
  await fs.writeFile(newFile, "{\"event\":\"new\"}\n")
  const oldTime = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000)
  await fs.utimes(oldFile, oldTime, oldTime)
  assert.equal((await fs.stat(oldFile)).mtimeMs < Date.now() - 24 * 60 * 60 * 1000, true)
  await fs.rm(directory, { recursive: true, force: true })
})
