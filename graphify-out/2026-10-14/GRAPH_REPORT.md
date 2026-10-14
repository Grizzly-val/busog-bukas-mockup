# Graph Report - busog_bukas  (2026-10-14)

## Corpus Check
- cluster-only mode — file stats not available

## Summary
- 100 nodes · 106 edges · 8 communities
- Extraction: 100% EXTRACTED · 0% INFERRED · 0% AMBIGUOUS
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `f99d099c`
- Run `git rev-parse HEAD` and compare to check if the graph is stale.
- Run `graphify update .` after code changes (no API cost).

## Community Hubs (Navigation)
- package.json
- compilerOptions
- dependencies
- devDependencies
- exceptionFilter.ts
- next
- scripts
- layout.tsx

## God Nodes (most connected - your core abstractions)
1. `compilerOptions` - 17 edges
2. `scripts` - 7 edges
3. `next` - 5 edges
4. `fetchTimelinePayload()` - 3 edges
5. `@prisma/client` - 3 edges
6. `generateInterventionReport()` - 2 edges
7. `eslint` - 2 edges
8. `eslint-config-next` - 2 edges
9. `exceptionFilterPrompt` - 2 edges
10. `ai` - 2 edges

## Surprising Connections (you probably didn't know these)
- None detected - all connections are within the same source files.

## Import Cycles
- None detected.

## Communities (8 total, 0 thin omitted)

### Community 0 - "package.json"
Cohesion: 0.09
Nodes (21): eslintConfig, name, private, version, @ai-sdk/anthropic, @ai-sdk/openai, dotenv, @ducanh2912/next-pwa (+13 more)

### Community 1 - "compilerOptions"
Cohesion: 0.10
Nodes (19): compilerOptions, allowJs, esModuleInterop, incremental, isolatedModules, jsx, lib, module (+11 more)

### Community 2 - "dependencies"
Cohesion: 0.17
Nodes (12): dependencies, ai, @ai-sdk/anthropic, @ai-sdk/google, @ai-sdk/openai, dotenv, @ducanh2912/next-pwa, idb (+4 more)

### Community 3 - "devDependencies"
Cohesion: 0.17
Nodes (12): devDependencies, eslint, eslint-config-next, prisma, tailwindcss, @tailwindcss/turbopack, @types/node, @types/react (+4 more)

### Community 4 - "exceptionFilter.ts"
Cohesion: 0.24
Nodes (8): ai, @ai-sdk/google, vitest, fetchTimelinePayload(), generateInterventionReport(), prisma, mockPrisma, exceptionFilterPrompt

### Community 5 - "next"
Cohesion: 0.22
Nodes (4): nextConfig, next, @prisma/client, prisma

### Community 6 - "scripts"
Cohesion: 0.29
Nodes (7): scripts, build, contract:emit, dev, lint, postinstall, start

### Community 7 - "layout.tsx"
Cohesion: 0.33
Nodes (3): geistMono, geistSans, metadata

## Knowledge Gaps
- **15 isolated node(s):** `@ai-sdk/anthropic`, `@ai-sdk/openai`, `dotenv`, `@ducanh2912/next-pwa`, `idb` (+10 more)
  These have ≤1 connection - possible missing edges. (Counts symbols only; 76 node(s) total have ≤1 connection when file, concept and rationale nodes are included.)

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `dependencies` connect `dependencies` to `package.json`?**
  _High betweenness centrality (0.166) - this node is a cross-community bridge._
- **What connects `@ai-sdk/anthropic`, `@ai-sdk/openai`, `dotenv` to the rest of the system?**
  _15 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `package.json` be split into smaller, more focused modules?**
  _Cohesion score 0.09090909090909091 - nodes in this community are weakly interconnected._
- **Why does `devDependencies` connect `devDependencies` to `package.json`?**
  _High betweenness centrality (0.166) - this node is a cross-community bridge._
- **Should `compilerOptions` be split into smaller, more focused modules?**
  _Cohesion score 0.1 - nodes in this community are weakly interconnected._
- **Why does `next` connect `next` to `package.json`, `layout.tsx`?**
  _High betweenness centrality (0.165) - this node is a cross-community bridge._