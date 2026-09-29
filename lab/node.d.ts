// Minimal Node typings for lab scripts (the repo has no @types/node and adds no dependencies).
declare const process: { readonly env: Record<string, string | undefined>; cwd(): string }

declare module 'node:fs' {
  export function writeFileSync(path: string, data: string): void
  export function readFileSync(path: string, encoding: 'utf8'): string
  export function mkdirSync(path: string, opts?: { recursive?: boolean }): void
  export function existsSync(path: string): boolean
}

declare module 'node:os' {
  export function cpus(): readonly unknown[]
}
