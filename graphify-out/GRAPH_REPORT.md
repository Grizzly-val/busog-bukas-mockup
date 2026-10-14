# Graph Report - busog_bukas  (2026-10-14)

## Corpus Check
- cluster-only mode — file stats not available

## Summary
- 141 nodes · 190 edges · 9 communities (8 shown, 1 thin omitted)
- Extraction: 100% EXTRACTED · 0% INFERRED · 0% AMBIGUOUS
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `f99d099c`
- Run `git rev-parse HEAD` and compare to check if the graph is stale.
- Run `graphify update .` after code changes (no API cost).

## Community Hubs (Navigation)
- payload.ts
- exceptionFilter.ts
- package.json
- compilerOptions
- dependencies
- devDependencies
- layout.tsx
- scripts
- exceptionFilter.test.ts

## God Nodes (most connected - your core abstractions)
1. `compilerOptions` - 17 edges
2. `parseSyncPayload()` - 11 edges
3. `SyncRequestError` - 10 edges
4. `scripts` - 10 edges
5. `fetchTimelinePayload()` - 6 edges
6. `syncOfflinePayload()` - 5 edges
7. `@prisma/client` - 5 edges
8. `POST()` - 4 edges
9. `createMnemonicId()` - 4 edges
10. `requiredString()` - 4 edges

## Surprising Connections (you probably didn't know these)
- `POST()` --calls--> `SyncRequestError`  [EXTRACTED]
  src/app/api/sync/route.ts → src/lib/sync/payload.ts
- `applySync()` --calls--> `SyncRequestError`  [EXTRACTED]
  src/lib/sync/service.ts → src/lib/sync/payload.ts
- `POST()` --calls--> `parseSyncPayload()`  [EXTRACTED]
  src/app/api/sync/route.ts → src/lib/sync/payload.ts
- `POST()` --calls--> `syncOfflinePayload()`  [EXTRACTED]
  src/app/api/sync/route.ts → src/lib/sync/service.ts
- `applySync()` --calls--> `createMnemonicId()`  [EXTRACTED]
  src/lib/sync/service.ts → src/lib/sync/payload.ts

## Import Cycles
- None detected.

## Communities (9 total, 1 thin omitted)

### Community 0 - "payload.ts"
Cohesion: 0.15
Nodes (20): POST(), createMnemonicId(), createSessionReference(), isRecord(), measurementNumber(), optionalString(), parseSyncPayload(), requiredString() (+12 more)

### Community 1 - "exceptionFilter.ts"
Cohesion: 0.12
Nodes (19): ai, @ai-sdk/anthropic, @ai-sdk/google, @ai-sdk/openai, @prisma/client, bmi(), configuredModels(), ExceptionFilterParticipant (+11 more)

### Community 2 - "package.json"
Cohesion: 0.10
Nodes (19): eslintConfig, name, private, version, dotenv, @ducanh2912/next-pwa, eslint, eslint-config-next (+11 more)

### Community 3 - "compilerOptions"
Cohesion: 0.10
Nodes (19): compilerOptions, allowJs, esModuleInterop, incremental, isolatedModules, jsx, lib, module (+11 more)

### Community 4 - "dependencies"
Cohesion: 0.17
Nodes (12): dependencies, ai, @ai-sdk/anthropic, @ai-sdk/google, @ai-sdk/openai, dotenv, @ducanh2912/next-pwa, idb (+4 more)

### Community 5 - "devDependencies"
Cohesion: 0.17
Nodes (12): devDependencies, eslint, eslint-config-next, prisma, tailwindcss, @tailwindcss/turbopack, @types/node, @types/react (+4 more)

### Community 6 - "layout.tsx"
Cohesion: 0.18
Nodes (5): nextConfig, next, geistMono, geistSans, metadata

### Community 7 - "scripts"
Cohesion: 0.20
Nodes (10): scripts, build, db:generate, db:push, db:validate, dev, lint, postinstall (+2 more)

## Knowledge Gaps
- **13 isolated node(s):** `dotenv`, `@ducanh2912/next-pwa`, `idb`, `prisma`, `react` (+8 more)
  These have ≤1 connection - possible missing edges. (Counts symbols only; 91 node(s) total have ≤1 connection when file, concept and rationale nodes are included.)
- **1 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `@prisma/client` connect `exceptionFilter.ts` to `payload.ts`, `package.json`?**
  _High betweenness centrality (0.144) - this node is a cross-community bridge._
- **What connects `dotenv`, `@ducanh2912/next-pwa`, `idb` to the rest of the system?**
  _13 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `exceptionFilter.ts` be split into smaller, more focused modules?**
  _Cohesion score 0.11594202898550725 - nodes in this community are weakly interconnected._
- **Why does `dependencies` connect `dependencies` to `package.json`?**
  _High betweenness centrality (0.129) - this node is a cross-community bridge._
- **Should `package.json` be split into smaller, more focused modules?**
  _Cohesion score 0.1 - nodes in this community are weakly interconnected._
- **Why does `devDependencies` connect `devDependencies` to `package.json`?**
  _High betweenness centrality (0.129) - this node is a cross-community bridge._
- **Should `compilerOptions` be split into smaller, more focused modules?**
  _Cohesion score 0.1 - nodes in this community are weakly interconnected._