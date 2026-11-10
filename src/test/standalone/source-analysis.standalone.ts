import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { test } from "node:test"

import { analyzeSource, type SourceAnalysis, type ToolRegistration } from "../../extension/todos/source-analysis"

const lines = (...text: string[]) => text.join("\n")

const analysed = (file: string, text: string): SourceAnalysis => {
  const result = analyzeSource(file, text)
  if (result.status !== "analyzed") assert.fail(JSON.stringify(result))
  return result
}

const registrationOf = (analysis: SourceAnalysis, toolName: string): ToolRegistration => {
  const found = analysis.registrations.filter((registration) => registration.toolName === toolName)
  assert.equal(found.length, 1, `expected one registration of ${toolName}, found ${found.length}`)
  return found[0]
}

const declarationsNamed = (analysis: SourceAnalysis, name: string) => analysis.declarations.filter((declaration) => declaration.name === name)

test("the native todo update tool is located by its exact registered name, and no camelCase implementation is declared", () => {
  const file = "src/extension/tools/todos.ts"
  const analysis = analysed(file, fs.readFileSync(path.join(process.cwd(), file), "utf8"))
  const tool = registrationOf(analysis, "twinny_todo_update")
  assert.equal(tool.nameLine, 267)
  assert.ok(tool.startLine <= 267 && tool.endLine > 267, JSON.stringify(tool))
  assert.equal(declarationsNamed(analysis, "twinnyTodoUpdate").length, 0)
  assert.ok(analysis.registrations.every((registration) => registration.toolName !== "twinnyTodoUpdate"))
})

test("the registry producing todo tools is never the implementation of its entries", () => {
  const file = "src/extension/tools/todos.ts"
  const analysis = analysed(file, fs.readFileSync(path.join(process.cwd(), file), "utf8"))
  assert.equal(declarationsNamed(analysis, "todoTools").length, 1)
  const tool = registrationOf(analysis, "twinny_todo_update")
  assert.notEqual(tool.implementation.status, "declared", JSON.stringify(tool.implementation))
})

test("a function that returns a single tool object is that tool's declared implementation, but an array registry is not", () => {
  const single = analysed("tool.ts", lines(
    "export function makeEcho(): Tool {",
    "  return {",
    "    name: \"echo_tool\",",
    "    async run(args: unknown) {",
    "      return args",
    "    }",
    "  }",
    "}"
  ))
  const echo = registrationOf(single, "echo_tool")
  assert.equal(echo.implementation.status, "declared", JSON.stringify(echo))
  assert.equal(echo.implementation.status === "declared" && echo.implementation.declaration.name, "makeEcho")

  const registry = analysed("registry.ts", lines(
    "export const tools = (): Tool[] => [",
    "  {",
    "    name: \"alpha_tool\",",
    "    async run(args: unknown) {",
    "      return args",
    "    }",
    "  }",
    "]"
  ))
  assert.equal(registrationOf(registry, "alpha_tool").implementation.status, "anonymous")
})

test("an inline run method is the anonymous implementation of its own tool entry, with the run method's span", () => {
  const analysis = analysed("inline.ts", lines(
    "export const tools = (): Tool[] => [",
    "  {",
    "    name: \"alpha_tool\",",
    "    async run(args: unknown) {",
    "      return args",
    "    }",
    "  }",
    "]"
  ))
  const tool = registrationOf(analysis, "alpha_tool")
  assert.deepEqual(tool.implementation, { status: "anonymous", startLine: 4, endLine: 6 })
  assert.equal(analysis.registrations.length, 1)
})

test("a tool whose run is a referenced function resolves to that declaration, not to the registry", () => {
  const analysis = analysed("referenced.ts", lines(
    "async function existingFunction(args: unknown) {",
    "  return args",
    "}",
    "",
    "export const tools = (): Tool[] => [",
    "  { name: \"beta_tool\", run: existingFunction }",
    "]"
  ))
  const tool = registrationOf(analysis, "beta_tool")
  assert.equal(tool.implementation.status, "declared", JSON.stringify(tool.implementation))
  assert.equal(tool.implementation.status === "declared" && tool.implementation.declaration.name, "existingFunction")
  assert.equal(tool.implementation.status === "declared" && tool.implementation.declaration.startLine, 1)
  assert.equal(tool.implementation.status === "declared" && tool.implementation.declaration.endLine, 3)
})

test("ordinary declarations are recognised with their kind, exported state, and source span", () => {
  const analysis = analysed("declarations.ts", lines(
    "export function plainFunction() {}",
    "export const arrowConst = (value: number) => value + 1",
    "const limit = 10",
    "export class Worker {",
    "  start() {}",
    "}",
    "export interface Options { verbose: boolean }",
    "export type Mode = \"fast\" | \"slow\"",
    "const handlers = {",
    "  onOpen() {},",
    "  onClose: () => {}",
    "}"
  ))
  const expected: Array<[string, string, number, number, boolean]> = [
    ["plainFunction", "function", 1, 1, true],
    ["arrowConst", "function", 2, 2, true],
    ["limit", "variable", 3, 3, false],
    ["Worker", "class", 4, 6, true],
    ["start", "method", 5, 5, false],
    ["Options", "interface", 7, 7, true],
    ["Mode", "type", 8, 8, true],
    ["onOpen", "object_method", 10, 10, false],
    ["onClose", "object_property", 11, 11, false]
  ]
  for (const [name, kind, startLine, endLine, exported] of expected) {
    const found = declarationsNamed(analysis, name)
    assert.equal(found.length, 1, `${name} should be declared once`)
    assert.deepEqual([found[0].kind, found[0].startLine, found[0].endLine, found[0].exported], [kind, startLine, endLine, exported], name)
  }
})

test("anonymous implementations are not given tool-derived names, and an inline run property is only the object property it is", () => {
  const analysis = analysed("anonymous.ts", lines(
    "export const tools = (): Tool[] => [",
    "  { name: \"gamma_tool\", run: (args: unknown) => args },",
    "  { name: \"delta_tool\", run: function (args: unknown) { return args } }",
    "]"
  ))
  assert.equal(registrationOf(analysis, "gamma_tool").implementation.status, "anonymous")
  assert.equal(registrationOf(analysis, "delta_tool").implementation.status, "anonymous")
  assert.deepEqual(analysis.declarations.map((declaration) => [declaration.name, declaration.kind]), [["tools", "function"], ["run", "object_property"], ["run", "object_property"]])
  assert.equal(declarationsNamed(analysis, "gammaTool").length + declarationsNamed(analysis, "deltaTool").length, 0)
})

test("identifiers in comments, strings, imports, and unrelated object keys are never declarations", () => {
  const analysis = analysed("negative.ts", lines(
    "import { ghost } from \"./elsewhere\"",
    "// function ghost() {}",
    "const label = \"class ghost\"",
    "const unrelated = { ghost: 1 }",
    "const template = `interface ghost {}`",
    "export const real = 1"
  ))
  assert.equal(declarationsNamed(analysis, "ghost").length, 0)
  assert.deepEqual(analysis.declarations.map((declaration) => declaration.name), ["label", "unrelated", "template", "real"])
})

test("a computed tool name is reported as dynamic and never as a registered name", () => {
  const analysis = analysed("dynamic.ts", lines(
    "const makeName = () => \"dynamic_tool\"",
    "export const tools = () => [",
    "  { name: makeName(), run() { return 1 } }",
    "]"
  ))
  assert.ok(analysis.dynamicRegistrations.some((entry) => entry.line === 3), JSON.stringify(analysis.dynamicRegistrations))
  assert.equal(analysis.registrations.filter((registration) => registration.toolName === "dynamic_tool").length, 0)
})

test("an imported or ambiguously declared run function is unresolved, never declared", () => {
  const analysis = analysed("ambiguous.ts", lines(
    "import { external } from \"./elsewhere\"",
    "function helper() { return 1 }",
    "function helper() { return 2 }",
    "export const tools = (): Tool[] => [",
    "  { name: \"eps_tool\", run: external },",
    "  { name: \"zeta_tool\", run: helper }",
    "]"
  ))
  assert.notEqual(registrationOf(analysis, "eps_tool").implementation.status, "declared")
  assert.notEqual(registrationOf(analysis, "zeta_tool").implementation.status, "declared")
})

test("re-exports and CommonJS exports are reported as opaque names", () => {
  const analysis = analysed("reexport.ts", lines(
    "export { thing as alias } from \"./other\"",
    "module.exports.legacy = 1"
  ))
  assert.ok(analysis.opaqueNames.includes("alias"), JSON.stringify(analysis.opaqueNames))
  assert.ok(analysis.opaqueNames.includes("legacy"), JSON.stringify(analysis.opaqueNames))
})

test("syntax errors and unsupported languages are unanalysed rather than partially answered", () => {
  assert.equal(analyzeSource("broken.ts", "export const = ;").status, "unanalysed")
  assert.equal(analyzeSource("notes.md", "# heading").status, "unanalysed")
})
