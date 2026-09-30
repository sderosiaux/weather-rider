# Weather Rider — rules for every agent

Game spec + architecture decisions: `SPEC.md`. Read §10 before coding.

## Ownership (one owner per directory, no exceptions)
- `src/core/**`, `src/main.ts`, `src/game/**`, `index.html`, `package.json`, `CLAUDE.md`, `SPEC.md` → architect only. Never edit them. If a contract is wrong or missing, stop working around it: finish what you can and report the exact change you need in your final message.
- Every other `src/<module>/` and `sandbox/<module>.*` belongs to the module agent named in its brief.
- Never add dependencies. Available: three, vite, vitest, typescript. Need another → report it.

## Code
- TypeScript strict. Functional + immutable for domain logic; mutable/allocation-free on hot paths (weather sample, particles, render loop).
- Sim code (`src/weather`, `src/flight`, `src/scoring`, `src/meta`) must not import `three` or touch the DOM, and must not use `Math.random()` / `Date.now()` — only `src/core/rng.ts`. Determinism is what makes daily weather and ghosts work.
- Production code never imports `src/core/fixtures` (tests and sandboxes do).
- Each module exposes its public API from `src/<module>/index.ts`, matching the contract types in `src/core/types.ts` / `src/core/presentation.ts`.
- Colors/fonts/sizes for DOM UI come from CSS custom properties in `src/ui/theme.css`, never hardcoded in components.
- For three.js / vite API questions use Context7 (`/mrdoob/three.js`, `/vitejs/vite/v8.0.10`) — three is 0.186, APIs changed a lot.

## Verify before claiming done
- `pnpm typecheck` and `pnpm test` green.
- Visual modules: `pnpm dev`, open your `sandbox/<module>.html`, take a screenshot (agent-browser / chrome-agent skill) and look at it. "It compiles" is not done.
- Tests: Vitest, colocated `*.test.ts`. Real scenarios and invariants over coverage.

## Clean up before reporting
- Stop your dev server and close every browser you opened (`agent-browser close`, or the chrome-agent equivalent) before your final message. Idle headless Chromes pile up on the user's machine.

## Final report format
done / verified (commands + outcome) / not done / contract changes requested / fragile spots.
