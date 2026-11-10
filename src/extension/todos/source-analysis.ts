import { extname } from "node:path"

import ts from "typescript"

/** A named declaration the verifier can locate. Lines are 1-based and inclusive in the analysed document. */
export interface SourceDeclaration {
  name: string
  kind: DeclarationKind
  startLine: number
  endLine: number
  exported: boolean
}

export type DeclarationKind = "function" | "variable" | "class" | "method" | "interface" | "type" | "enum" | "object_method" | "object_property"

/** The name and span of a declaration, used to find the declaration that a registration's producer names. */
interface DeclarationSpan {
  name: string
  startLine: number
  endLine: number
}

/**
 * What a tool registration invokes. An inline `run` method or function expression has no declared name, so it is `anonymous`
 * and never given one, unless a named function directly returns the registration object: that function produces the tool and is
 * `declared` as its implementation. An identifier resolves only to a unique declaration in the same file; anything else stays `unresolved`.
 */
export type RegistrationImplementation =
  | { status: "anonymous"; startLine: number; endLine: number }
  | { status: "declared"; declaration: SourceDeclaration }
  | { status: "unresolved"; reason: string }

/** An object literal with a string `name` and a `run` member: the registration of one tool. */
export interface ToolRegistration {
  toolName: string
  nameLine: number
  startLine: number
  endLine: number
  implementation: RegistrationImplementation
}

/** A tool-shaped object whose name is computed. It may register any tool, so it blocks disproof of registered names. */
export interface DynamicRegistration {
  line: number
  reason: string
}

export interface SourceAnalysis {
  status: "analyzed"
  path: string
  declarations: SourceDeclaration[]
  registrations: ToolRegistration[]
  dynamicRegistrations: DynamicRegistration[]
  /**
   * Names bound by re-exports, CommonJS export assignments, or shorthand properties. The verifier does not resolve these
   * to a declaration, so their absence from the declarations proves nothing.
   */
  opaqueNames: string[]
}

export interface UnanalysedSource {
  status: "unanalysed"
  path: string
  reason: string
}

const SCRIPT_KINDS: Record<string, ts.ScriptKind> = {
  ".ts": ts.ScriptKind.TS,
  ".mts": ts.ScriptKind.TS,
  ".cts": ts.ScriptKind.TS,
  ".tsx": ts.ScriptKind.TSX,
  ".js": ts.ScriptKind.JS,
  ".mjs": ts.ScriptKind.JS,
  ".cjs": ts.ScriptKind.JS,
  ".jsx": ts.ScriptKind.JSX
}

/** Whether the structural analyzer understands this path's language at all. */
export const isAnalysableSource = (path: string): boolean => SCRIPT_KINDS[extname(path).toLowerCase()] !== undefined

const propertyName = (name: ts.PropertyName | undefined): string | undefined =>
  name && (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNoSubstitutionTemplateLiteral(name)) ? name.text : undefined

const isExported = (node: ts.Node): boolean => (ts.getCombinedModifierFlags(node as ts.Declaration) & ts.ModifierFlags.Export) !== 0

const isCallable = (node: ts.Expression | undefined): boolean => node !== undefined && (ts.isArrowFunction(node) || ts.isFunctionExpression(node))

/** `exports` or `module.exports`, the object a CommonJS module assigns its public names to. */
const isExportsObject = (node: ts.Expression): boolean =>
  (ts.isIdentifier(node) && node.text === "exports")
  || (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "module" && node.name.text === "exports")

/**
 * Parses one authoritative document and returns its declarations and tool registrations from the syntax tree. Syntax errors
 * and unsupported languages are reported as unanalysed rather than as a partial answer, so absence is never inferred from them.
 */
export const analyzeSource = (path: string, text: string): SourceAnalysis | UnanalysedSource => {
  const kind = SCRIPT_KINDS[extname(path).toLowerCase()]
  if (kind === undefined) return { status: "unanalysed", path, reason: `${path} is not a TypeScript or JavaScript source file, so its declarations cannot be verified` }
  const file = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, kind)
  // parseDiagnostics is the parser's own list of syntax errors. It is not part of the public SourceFile type.
  const syntaxErrors = (file as unknown as { parseDiagnostics?: readonly unknown[] }).parseDiagnostics ?? []
  if (syntaxErrors.length > 0) return { status: "unanalysed", path, reason: `${path} has syntax errors, so its declarations cannot be established` }

  const lineOf = (position: number): number => file.getLineAndCharacterOfPosition(position).line + 1
  const spanOf = (node: ts.Node): { startLine: number; endLine: number } => ({ startLine: lineOf(node.getStart(file)), endLine: lineOf(node.getEnd()) })
  const declarations: SourceDeclaration[] = []
  const opaque = new Set<string>()
  const pending: Array<{ toolName: string; nameLine: number; startLine: number; endLine: number; run: ts.ObjectLiteralElementLike; producer?: DeclarationSpan }> = []
  const dynamicRegistrations: DynamicRegistration[] = []

  const declare = (name: string, kindOf: DeclarationKind, node: ts.Node, exported: boolean): void => {
    declarations.push({ name, kind: kindOf, ...spanOf(node), exported })
  }

  const collectDeclaration = (node: ts.Node): void => {
    if (ts.isFunctionDeclaration(node) && node.name) return declare(node.name.text, "function", node, isExported(node))
    if (ts.isClassDeclaration(node) && node.name) return declare(node.name.text, "class", node, isExported(node))
    if (ts.isInterfaceDeclaration(node)) return declare(node.name.text, "interface", node, isExported(node))
    if (ts.isTypeAliasDeclaration(node)) return declare(node.name.text, "type", node, isExported(node))
    if (ts.isEnumDeclaration(node)) return declare(node.name.text, "enum", node, isExported(node))
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
      // Only statement-level bindings have a declaration span of their own; loop variables do not.
      const statement = node.parent.parent
      if (!ts.isVariableStatement(statement)) return
      return declare(node.name.text, isCallable(node.initializer) ? "function" : "variable", statement, isExported(statement))
    }
    if (ts.isMethodDeclaration(node)) {
      const name = propertyName(node.name)
      if (name === undefined) return
      if (ts.isObjectLiteralExpression(node.parent)) return declare(name, "object_method", node, false)
      if (ts.isClassLike(node.parent)) return declare(name, "method", node, false)
      return
    }
    if (ts.isPropertyDeclaration(node) && ts.isClassLike(node.parent)) {
      const name = propertyName(node.name)
      if (name !== undefined && isCallable(node.initializer)) return declare(name, "method", node, false)
      return
    }
    if (ts.isPropertyAssignment(node) && ts.isObjectLiteralExpression(node.parent)) {
      const name = propertyName(node.name)
      if (name !== undefined && isCallable(node.initializer)) return declare(name, "object_property", node, false)
    }
  }

  const collectOpaque = (node: ts.Node): void => {
    if (ts.isExportSpecifier(node)) {
      opaque.add(node.name.text)
      if (node.propertyName) opaque.add(node.propertyName.text)
    } else if (ts.isExportAssignment(node) && ts.isIdentifier(node.expression)) {
      opaque.add(node.expression.text)
    } else if (ts.isShorthandPropertyAssignment(node)) {
      opaque.add(node.name.text)
    } else if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      const left = node.left
      if (ts.isPropertyAccessExpression(left) && isExportsObject(left.expression)) opaque.add(left.name.text)
      if (isExportsObject(left) && ts.isIdentifier(node.right)) opaque.add(node.right.text)
    }
  }

  /**
   * The named function whose direct return value is this object, such as a factory that returns exactly one tool. An object
   * inside an array or any other expression is not produced by a single function, so it has no producer.
   */
  const producerOf = (object: ts.ObjectLiteralExpression): DeclarationSpan | undefined => {
    let expression: ts.Node = object
    while (ts.isParenthesizedExpression(expression.parent)) expression = expression.parent
    const parent = expression.parent
    const fn = ts.isReturnStatement(parent) ? ts.findAncestor(parent, ts.isFunctionLike)
      : ts.isArrowFunction(parent) && parent.body === expression ? parent
      : undefined
    if (fn === undefined) return undefined
    if (ts.isFunctionDeclaration(fn) && fn.name) return { name: fn.name.text, ...spanOf(fn) }
    if ((ts.isArrowFunction(fn) || ts.isFunctionExpression(fn)) && ts.isVariableDeclaration(fn.parent) && ts.isIdentifier(fn.parent.name)) {
      return { name: fn.parent.name.text, ...spanOf(fn.parent.parent.parent) }
    }
    return undefined
  }

  const collectRegistration = (object: ts.ObjectLiteralExpression): void => {
    const member = (key: string) => object.properties.find((candidate): candidate is ts.ObjectLiteralElementLike =>
      (ts.isPropertyAssignment(candidate) || ts.isMethodDeclaration(candidate) || ts.isShorthandPropertyAssignment(candidate))
      && propertyName(candidate.name) === key)
    const run = member("run")
    const nameMember = object.properties.find((candidate): candidate is ts.PropertyAssignment => ts.isPropertyAssignment(candidate) && propertyName(candidate.name) === "name")
    if (!run || !nameMember) return
    const value = nameMember.initializer
    const nameLine = lineOf(nameMember.getStart(file))
    if (!ts.isStringLiteral(value) && !ts.isNoSubstitutionTemplateLiteral(value)) {
      dynamicRegistrations.push({ line: nameLine, reason: "the tool name is computed, so the verifier cannot establish which tool this registers" })
      return
    }
    pending.push({ toolName: value.text, nameLine, ...spanOf(object), run, producer: producerOf(object) })
  }

  const visit = (node: ts.Node): void => {
    collectDeclaration(node)
    collectOpaque(node)
    if (ts.isObjectLiteralExpression(node)) collectRegistration(node)
    ts.forEachChild(node, visit)
  }
  visit(file)

  const resolveName = (name: string): RegistrationImplementation => {
    const matches = declarations.filter((declaration) => declaration.name === name)
    if (matches.length === 1) return { status: "declared", declaration: matches[0] }
    if (matches.length === 0) return { status: "unresolved", reason: `${name} is not declared in ${path}; it is imported or undefined there` }
    return { status: "unresolved", reason: `${name} is declared ${matches.length} times in ${path}, so the implementation is ambiguous` }
  }

  const runImplementation = (run: ts.ObjectLiteralElementLike): RegistrationImplementation => {
    if (ts.isMethodDeclaration(run)) return { status: "anonymous", ...spanOf(run) }
    if (ts.isShorthandPropertyAssignment(run)) return resolveName(run.name.text)
    if (ts.isPropertyAssignment(run)) {
      if (isCallable(run.initializer)) return { status: "anonymous", ...spanOf(run) }
      if (ts.isIdentifier(run.initializer)) return resolveName(run.initializer.text)
    }
    return { status: "unresolved", reason: "the implementation is an expression the verifier cannot resolve, such as a call or a factory result" }
  }

  // An inline run is the tool's implementation only when no single function produces the tool; the producer then declares it.
  const implementationOf = (run: ts.ObjectLiteralElementLike, producer: DeclarationSpan | undefined): RegistrationImplementation => {
    const inline = runImplementation(run)
    if (inline.status !== "anonymous" || producer === undefined) return inline
    const matches = declarations.filter((declaration) =>
      declaration.name === producer.name && declaration.startLine === producer.startLine && declaration.endLine === producer.endLine)
    return matches.length === 1 ? { status: "declared", declaration: matches[0] } : inline
  }

  return {
    status: "analyzed",
    path,
    declarations,
    registrations: pending.map(({ run, producer, ...registration }) => ({ ...registration, implementation: implementationOf(run, producer) })),
    dynamicRegistrations,
    opaqueNames: [...opaque]
  }
}
