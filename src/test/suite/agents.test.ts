import * as assert from "assert"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import * as vscode from "vscode"

import { AgentRegistry } from "../../extension/agents/registry"

suite("custom agent registry", () => {
  test("discovers only agent profiles and persists enable, remove and create operations", async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "twinny-agent-registry-"))
    const workspaceRoot = path.join(tempRoot, "workspace")
    const storageRoot = path.join(tempRoot, "storage")
    fs.mkdirSync(path.join(workspaceRoot, ".github", "agents"), { recursive: true })
    fs.mkdirSync(storageRoot, { recursive: true })
    fs.writeFileSync(path.join(workspaceRoot, ".github", "agents", "review.agent.md"), "---\nname: Review Agent\n---\nReview changes carefully.\n")
    fs.writeFileSync(path.join(workspaceRoot, "AGENTS.md"), "Project instructions, not a selectable profile.")
    const configuration = vscode.workspace.getConfiguration("twinny")
    const originalAgents = configuration.inspect<unknown>("agents")?.globalValue
    try {
      await configuration.update("agents", { autoDiscover: true, searchPaths: [path.join(workspaceRoot, ".github", "agents")], definitions: [], excludedPaths: [] }, vscode.ConfigurationTarget.Global)
      const registry = new AgentRegistry({ globalStorageUri: vscode.Uri.file(storageRoot) })
      const discovered = await registry.list()
      assert.strictEqual(discovered.length, 1)
      assert.strictEqual(discovered[0].name, "Review Agent")
      assert.strictEqual(discovered[0].valid, true)
      const id = discovered[0].id
      await registry.setEnabled(id, false)
      assert.strictEqual((await registry.list())[0].enabled, false)
      const persisted = await new AgentRegistry({ globalStorageUri: vscode.Uri.file(storageRoot) }).list()
      assert.strictEqual(persisted.find((profile) => profile.id === id)?.enabled, false)
      await registry.setEnabled(id, true)
      const missing = await registry.add(path.join(workspaceRoot, "missing.agent.md"), "Missing Agent")
      const missingProfile = missing.find((profile) => profile.name === "Missing Agent")
      assert.strictEqual(missingProfile?.valid, false)
      assert.ok(missingProfile?.validation)
      assert.ok(missingProfile?.enabled)
      await registry.remove(missingProfile!.id)
      const created = await registry.create("Created Agent")
      const createdProfile = created.find((profile) => profile.name === "Created Agent")
      assert.ok(createdProfile?.valid)
      assert.ok(fs.existsSync(vscode.Uri.parse(createdProfile.path).fsPath))

      const userDataRegistry = new AgentRegistry({
        globalStorageUri: vscode.Uri.from({ scheme: "vscode-userdata", path: storageRoot })
      })
      const userDataCreated = await userDataRegistry.create("User Data Scheme Agent")
      const userDataProfiles = userDataCreated.filter((profile) => profile.name === "User Data Scheme Agent")
      assert.strictEqual(userDataProfiles.length, 1)
      assert.strictEqual(userDataProfiles[0].valid, true)
      assert.strictEqual(userDataProfiles[0].source, "user")
      await registry.remove(id)
      assert.ok(!(await registry.list()).some((profile) => profile.id === id))
    } finally {
      await configuration.update("agents", originalAgents, vscode.ConfigurationTarget.Global)
      fs.rmSync(tempRoot, { recursive: true, force: true })
    }
  })
})
