# Backend Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the backend foundation: the Prisma database schema for cohorts/sessions, API sync endpoints for offline data ingestion, and the AI Exception Filter service.

**Architecture:** We will use Prisma with SQLite (or Postgres if configured) for the unified database using Selective Visibility. Next.js App Router API endpoints will handle the offline sync payload. A specialized AI service will query the Vercel AI SDK, feeding it only aggregates, the top outliers, and the failing outliers to avoid reverse survivorship bias.

**Tech Stack:** Next.js (App Router), Prisma, Vercel AI SDK.

**Spec:** `C:\Users\Lenovo\Documents\busog_bukas\busog_bukas_revised_architecture.md`

## Global Constraints

- No "failing" or "red" UI string payloads; backend must use neutral statuses like "ACTION_REQUIRED" or "MONITOR_CLOSELY".
- AI must be fed top 10 succeeding and all failing records, never just failing records.
- Beneficiary names must be nullable. `mnemonic_id` must be auto-generated if name is null.

## Review Focus

- **The AI payload builder drops succeeding records if it's not explicitly grabbing the top 10:** The top 10 ON_TRACK kids must be included so the AI can run Positive Deviance analysis. Ensure the sorting and slicing logic is verified.
- **API sync endpoint receives data for a child that doesn't exist:** The system needs to upsert. If an offline device creates a new beneficiary, the sync API must create them in the DB before attaching measurement records.
- **Calculation of growth flags on backend differs from frontend:** The client calculates the expected growth curve, but the backend API should accept the flag to avoid sync discrepancies, or recalculate deterministically based on shared logic.

---

### Task 1: Prisma Schema Design

**Files:**
- Modify: `prisma/schema.prisma`

**Interfaces:**
- Produces: Prisma Client with Organization, Program, Beneficiary, Timeline, Session, MeasurementRecord models.

- [ ] **Step 1: Define Organization, Program, and Beneficiary models in `prisma/schema.prisma`**
  ```prisma
  model Beneficiary {
    id               String  @id @default(cuid())
    beneficiary_code String  @unique
    name             String?
    mnemonic_id      String
    programId        String
    // relations...
  }
  ```
- [ ] **Step 2: Define Timeline, Session, and MeasurementRecord models**
  Ensure MeasurementRecord includes `weight`, `height`, and `statusFlag` (String, defaulting to "ON_TRACK").
- [ ] **Step 3: Run Prisma generate and push**
  Run: `npx prisma generate` and `npx prisma db push`
  Expected: PASS with database synchronized.
- [ ] **Step 4: Commit**
  ```bash
  git add prisma/schema.prisma
  git commit -m "feat: setup initial prisma schema for cohorts and beneficiaries"
  ```

### Task 2: AI Exception Filter Service

**Files:**
- Create: `src/lib/ai/exceptionFilter.ts`
- Create: `src/lib/ai/prompts.ts`

**Interfaces:**
- Consumes: Prisma models for Beneficiary and MeasurementRecord.
- Produces: `generateInterventionReport(timelineId: string)` -> AI narrative string.

- [ ] **Step 1: Implement data aggregation logic in `exceptionFilter.ts`**
  Write a function `fetchTimelinePayload(timelineId: string)` that fetches all records, groups by `statusFlag`, and returns an object containing aggregates, the top 10 `ON_TRACK` records (sorted by weight gain), and all `ACTION_REQUIRED` records.
- [ ] **Step 2: Construct the strict LLM prompt in `prompts.ts`**
  Write the system prompt enforcing the rule to compare top performers with stagnating children to suggest local interventions.
- [ ] **Step 3: Wire Vercel AI SDK**
  In `exceptionFilter.ts`, use `generateText` from the `@ai-sdk` (using `google` provider) with the payload and prompt.
- [ ] **Step 4: Commit**
  ```bash
  git add src/lib/ai/
  git commit -m "feat: implement AI exception filter and generation service"
  ```

### Task 3: Offline Data Sync API Endpoint

**Files:**
- Create: `src/app/api/sync/route.ts`

**Interfaces:**
- Consumes: JSON payload from PWA containing new Beneficiaries and MeasurementRecords.
- Produces: POST endpoint returning success/failure and resolving conflicts.

- [ ] **Step 1: Write the sync handler skeleton**
  Implement the `POST` route in `src/app/api/sync/route.ts` that parses the JSON request body.
- [ ] **Step 2: Implement batch upsert logic**
  Use Prisma transactions (`prisma.$transaction`) to safely upsert Beneficiaries (using `beneficiary_code` as unique constraint) and create the `MeasurementRecord`s.
- [ ] **Step 3: Commit**
  ```bash
  git add src/app/api/sync/route.ts
  git commit -m "feat: implement offline sync api endpoint"
  ```
