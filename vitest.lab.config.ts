// Long-running headless simulations (balance, route feasibility). Not part of `pnpm test`.
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: { include: ['lab/**/*.lab.ts'], testTimeout: 600_000 },
})
