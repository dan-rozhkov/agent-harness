# CLAUDE.md

`@sideform/agent-harness`: client-side harness for a chat agent whose tools run
in the browser (Surface contract, tool executor, retrying fetch, AI SDK chat
transport). TypeScript, ESM/NodeNext, Vitest 4, ESLint 9. Extracted from Pen Editor.

## Commands

```bash
npm run lint       # tsc --noEmit && eslint .
npm run typecheck  # tsc --noEmit
npm test           # vitest run (node environment)
npm run build      # tsc -p tsconfig.build.json -> dist/ (tests excluded)
```

Run lint, typecheck, test and build before you call work done. Do not pipe
them through `tail` and trust the exit code; check the output.

## Layout

```
src/surface.ts       Surface, ToolHandler, composeToolHandlers      (./surface)
src/toolExecutor.ts  createToolExecutor, createSerialQueue          (./executor)
src/retryFetch.ts    createRetryingFetch                            (./retry-fetch)
src/transport.ts     createHarnessTransport (needs peer `ai`)       (./transport)
src/index.ts         barrel
src/__tests__/       tests
```

`package.json` `exports` and `typesVersions` map each subpath to `dist/`; keep
them in step when you add an entry point.

## Conventions

- Relative imports need the `.js` extension (NodeNext), also in tests.
- No app dependencies: no imports from Pen Editor, Zustand, Electron. `react`
  is a type-only import (optional peer). Tests must stay self-contained.
- `execute` must never throw or reject; `onExecuted` errors are swallowed.
- Release with release-please: use conventional commits on `main`
  (`feat:`, `fix:`). Do not edit the version or CHANGELOG by hand. Publishing
  runs only from `.github/workflows/release.yml`.
