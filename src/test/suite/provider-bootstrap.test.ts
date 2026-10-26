import * as assert from "assert"

import {
  isDevelopmentHost,
  isDevProviderOverrideEnabled,
  parseDevelopmentProviders,
  shouldApplyDevelopmentProviders
} from "../../extension/providers/dev-bootstrap"

suite("Development provider bootstrap", () => {
  test("accepts the exported Twinny provider object format", () => {
    const providers = parseDevelopmentProviders(JSON.stringify({
      a: {
        id: "a",
        label: "llama.cpp",
        modelName: "gpt-oss-20b",
        provider: "llamacpp",
        type: "chat",
        apiHostname: "mycroft",
        apiPort: 8081,
        apiProtocol: "http",
        apiPath: "",
        apiKey: ""
      },
      b: {
        id: "b",
        label: "llama.cpp FIM",
        modelName: "gpt-oss-20b",
        provider: "llamacpp",
        type: "fim",
        apiHostname: "mycroft",
        apiPort: 8081,
        apiProtocol: "http",
        apiPath: "/completion",
        apiKey: "",
        fimTemplate: "automatic"
      }
    }))

    assert.strictEqual(providers.length, 2)
    assert.strictEqual(providers[0].type, "chat")
    assert.strictEqual(providers[1].type, "fim")
  })

  test("rejects empty or invalid provider files with a helpful message", () => {
    assert.throws(
      () => parseDevelopmentProviders(JSON.stringify({})),
      /The development provider config is empty|Invalid development provider config/
    )
    assert.throws(
      () =>
        parseDevelopmentProviders(
          JSON.stringify({ a: { label: "Broken", provider: "unknown", type: "chat" } })
        ),
      /Invalid development provider config/
    )
  })

  test("only applies in development or test mode and when the env file is configured", () => {
    assert.strictEqual(
      shouldApplyDevelopmentProviders({ extensionMode: 2 }, { TWINNY_DEV_PROVIDERS_FILE: "/tmp/providers.json" }),
      true
    )
    assert.strictEqual(
      shouldApplyDevelopmentProviders({ extensionMode: 0 }, { TWINNY_DEV_PROVIDERS_FILE: "/tmp/providers.json" }),
      false
    )
    assert.strictEqual(
      shouldApplyDevelopmentProviders({ extensionMode: 1 }, { TWINNY_DEV_PROVIDERS_FILE: "" }),
      false
    )
    assert.strictEqual(isDevelopmentHost({ extensionMode: 1 }), true)
    assert.strictEqual(isDevelopmentHost({ extensionMode: 0 }), false)
  })

  test("allows explicit test override or live-model opt-in", () => {
    assert.strictEqual(
      isDevProviderOverrideEnabled({ TWINNY_DEV_PROVIDERS_OVERRIDE: "1" }),
      true
    )
    assert.strictEqual(
      isDevProviderOverrideEnabled({ TWINNY_LIVE: "1" }),
      true
    )
    assert.strictEqual(
      isDevProviderOverrideEnabled({ TWINNY_DEV_PROVIDERS_OVERRIDE: "0" }),
      false
    )
  })
})
