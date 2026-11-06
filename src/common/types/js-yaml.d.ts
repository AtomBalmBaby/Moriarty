declare module "js-yaml" {
  export const JSON_SCHEMA: unknown
  export function load(source: string, options?: { schema?: unknown }): unknown
  export function dump(value: unknown, options?: { lineWidth?: number }): string
}
