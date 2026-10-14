# Backend foundation

The backend uses Next.js Route Handlers, Prisma 5, and SQLite for local development. Database access is centralized in `src/lib/db.ts`; application code should reuse that client instead of constructing additional `PrismaClient` instances.

## Local checks

```bash
npm run db:validate
npm run db:generate
npm run db:push
npm test
npm run lint
npm run build
```

`db:push` updates the local SQLite database in `prisma/dev.db`. Use a reviewed Prisma migration rather than `db:push` for a shared or production database.

## Offline sync

`POST /api/sync` accepts one feeding session and its measurements:

```json
{
  "programId": "program-id",
  "timelineId": "timeline-id",
  "session": {
    "clientReference": "device-a:session-42",
    "name": "Week 1 weigh-in",
    "date": "2026-10-14T08:00:00.000Z"
  },
  "beneficiaries": [
    {
      "beneficiary_code": "BB-001",
      "name": null,
      "mnemonic_id": "Blue-Mango-27"
    }
  ],
  "measurements": [
    {
      "beneficiary_code": "BB-001",
      "weight": 18.4,
      "height": 112,
      "statusFlag": "MONITOR_CLOSELY"
    }
  ]
}
```

`clientReference` should be generated once on the offline device and reused for every retry. Older clients may omit it; the server derives a deterministic reference from the timeline, session name, and date. A retry updates the same session and the same beneficiary measurement instead of inserting duplicates.

Allowed statuses are `ON_TRACK`, `MONITOR_CLOSELY`, and `ACTION_REQUIRED`. The server validates all untrusted input, confirms the timeline belongs to the program, rejects cross-program beneficiary collisions, and generates a mnemonic ID when one is not provided. Unexpected server errors return a generic response rather than database details.

Successful response:

```json
{
  "success": true,
  "sessionId": "database-session-id",
  "sessionReference": "device-a:session-42",
  "beneficiariesSynced": 1,
  "measurementsSynced": 1
}
```

## AI exception filter

`fetchTimelinePayload()` performs all calculations in application code. The model receives aggregate counts and changes, the top ten `ON_TRACK` participants, and every `ACTION_REQUIRED` participant. Names, mnemonic IDs, beneficiary codes, and database IDs are excluded; participants are represented by timeline-scoped hashed references.

`generateInterventionReport()` tries configured providers in this order:

1. Google (`GOOGLE_GENERATIVE_AI_API_KEY`)
2. OpenAI (`OPENAI_API_KEY`)
3. Anthropic (`ANTHROPIC_API_KEY`)

At least one key is required to generate a report. Failed providers fall through to the next configured provider without logging payloads or credentials.

## Schema transition and rollback

The current transition is additive: `Session.clientReference` is nullable for old rows, and new sync writes always populate it. `MeasurementRecord` enforces one measurement per beneficiary per session. Before applying this constraint to a non-empty shared database, query for duplicate `(sessionId, beneficiaryId)` pairs and resolve them explicitly.

Rollback is code-first: deploy the previous writer, then remove the new unique index and optional `clientReference` column in a reviewed migration. Removing the column is a destructive contraction and must not happen while new clients depend on retry references.
