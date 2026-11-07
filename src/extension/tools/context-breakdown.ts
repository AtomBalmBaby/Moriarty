/**
 * What a tool-loop request is made of, for the trace log. Each row is
 * measured in characters from what is sent; tokens are that count divided
 * by the loop's chars-per-token estimate, so only the server's own count
 * (see `formatCountedTokens`) is the real figure.
 */

export const BREAKDOWN_ROWS = {
  system: "system / agent instructions",
  toolInstructions: "tool instructions",
  projectInstructions: "project instructions",
  schemas: "tool schemas",
  context: "TODO / evidence context",
  history: "conversation history",
  calls: "model's tool calls",
  results: "tool results",
  closing: "closing prompt"
} as const

export type BreakdownRow = keyof typeof BREAKDOWN_ROWS

export type RowChars = Record<BreakdownRow, number>

export interface RequestBreakdown {
  rows: { row: BreakdownRow; label: string; chars: number; tokens: number }[]
  chars: number
  tokens: number
  charsPerToken: number
}

const sum = (values: number[]) => values.reduce((total, value) => total + value, 0)

export const buildBreakdown = (chars: RowChars, charsPerToken: number): RequestBreakdown => {
  const rows = (Object.keys(BREAKDOWN_ROWS) as BreakdownRow[]).map((row) => ({
    row,
    label: BREAKDOWN_ROWS[row],
    chars: chars[row],
    tokens: Math.ceil(chars[row] / charsPerToken)
  }))
  return {
    rows,
    chars: sum(rows.map((line) => line.chars)),
    tokens: sum(rows.map((line) => line.tokens)),
    charsPerToken
  }
}

/** `10,100`: digits in groups of three. */
export const groupDigits = (n: number) => Math.round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",")

export const formatRequestBreakdown = (request: number, mode: string, breakdown: RequestBreakdown): string => {
  const labelWidth = Math.max("total".length, ...breakdown.rows.map((line) => line.label.length)) + 2
  const tokenWidth = Math.max(...[...breakdown.rows.map((line) => line.tokens), breakdown.tokens].map((n) => groupDigits(n).length))
  const charWidth = Math.max(...[...breakdown.rows.map((line) => line.chars), breakdown.chars].map((n) => groupDigits(n).length))
  const row = (label: string, tokens: number, chars: number) =>
    `  ${label.padEnd(labelWidth)}${groupDigits(tokens).padStart(tokenWidth)} tokens  (${groupDigits(chars).padStart(charWidth)} chars)`
  const total = row("total", breakdown.tokens, breakdown.chars)
  return [
    `[Context] tool-loop request ${request} (${mode}, ~${breakdown.charsPerToken.toFixed(1)} chars per token)`,
    ...breakdown.rows.map((line) => row(line.label, line.tokens, line.chars)),
    `  ${"-".repeat(total.length - 2)}`,
    total
  ].join("\n")
}

/** The server's count of the same request, against the breakdown's estimate. */
export const formatCountedTokens = (request: number, breakdown: RequestBreakdown, counted: number): string => {
  const off = counted ? ((breakdown.tokens - counted) / counted) * 100 : 0
  return `[Context] tool-loop request ${request} · server counted ${groupDigits(counted)} prompt tokens; breakdown estimated ${groupDigits(breakdown.tokens)} (${off >= 0 ? "+" : ""}${off.toFixed(1)}%)`
}
