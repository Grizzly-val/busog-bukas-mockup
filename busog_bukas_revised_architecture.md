# Busog Bukas: Revised Architectural & Functional Specification

## 1. Executive Summary
Busog Bukas is a localized food security and health data network designed as an offline-first Progressive Web App (PWA) for feeding programs. 

Following rigorous LLM Council peer reviews, the system architecture has shifted away from a generic SaaS wrapper and toward a **biologically accurate, operationally resilient, offline-first data capture tool**. The core philosophy is to use cheap, deterministic math for tracking, and reserve AI for high-value diagnostic insights on outliers.

## 2. Core Pivots from Original Proposal
The following architectural decisions override the original proposal to solve critical operational blindspots:

1. **Full Offline-First PWA (Replaces pure Web App):** Feeding sites often lack internet. The application must function offline, caching data locally and syncing to the backend when a connection is restored.
2. **Selective Visibility (Replaces Strict Multi-tenancy Auth):** Rather than complex siloed multi-tenancy, the database will remain unified but strictly filter views based on the organization the user belongs to.
3. **Multi-Model AI Stack (Replaces Pure Gemini):** To prevent quota bottlenecks, the system implements a multi-model fallback strategy (e.g., attempting a primary model, falling back to a lighter/different model if rate limits are hit).
4. **Nullable Names & Mnemonic IDs (Replaces Pure Anonymous Codes):**
   * Storing PII (Names) is now **consent-based** (nullable).
   * For children without consent, relying on a 5-digit `beneficiary_code` causes transcription errors. The system will auto-generate a **Mnemonic Visual ID** (e.g., "Blue-Mango-7" or an animal avatar) for reliable human identification in the field.
5. **Neutral Intervention UI (Replaces "Failing/Red" Stigma):** Displaying "Failing" in red causes stigma and participant dropout. The UI will use neutral, medical terminology like "Action Required" or "Monitor Closely" with softer colors (yellow/orange).

## 3. The "Expected Growth Curve" Data Flow
The original idea of unconditional calendar-based AI triggers or arbitrary >0.3kg gates has been replaced by the **Expected Growth Curve Math Gate**.

### Phase 1: Client-Side Deterministic Math (The PWA)
* The math runs **locally** on the organizer's device so they get instant feedback at the moment of weighing.
* It calculates expected weight gain based on age, baseline, and timeline.
* If a child significantly deviates from the curve (either sudden drops or **biological stagnation** / zero growth over 3 weeks), the PWA instantly flags them as "Action Required."

### Phase 2: The AI Exception Filter (The Backend)
* To prevent AI alert fatigue and save tokens, the AI does *not* receive individual records for kids growing normally.
* **Positive Deviance & Stagnation:** The AI payload includes:
  1. The overall cohort aggregate statistics.
  2. The individual records of the **bottom outliers** (stagnating/failing).
  3. A sample of the **top 10 succeeding outliers**.
* This allows the AI to compare the fastest-growing kids against the stagnating kids to suggest local, contextualized interventions without reverse survivorship bias.

## 4. Data Model (Prisma Schema Overview)
The database structure relies on the **Timelines and Sessions** concept to decouple calendar time from actual feeding cohorts.

* **Organization & Program:** Top-level wrappers.
* **Beneficiary:** 
  * `beneficiary_code` (String, Unique, Required)
  * `name` (String, Nullable, Consent-based)
  * `mnemonic_id` (String, Required fallback)
* **Timeline:** The logical grouping (e.g., "Batch 1 - Oct/Nov").
* **Session:** A specific physical feeding event (e.g., "Week 1 Weigh-in").
* **MeasurementRecord:** The exact attendance, weight, and height data mapped to a Beneficiary and a Session.

## 5. Implementation Roadmap Strategy
The build will follow this sequence:
1. **Database & Schema:** Prisma schema setup with strict typing for the new identity models.
2. **PWA Infrastructure:** Next.js configuration with `next-pwa` and IndexedDB for local offline caching.
3. **Core Workflow:** Offline roster management, session creation, and offline weight input.
4. **Math Engine:** Client-side deterministic growth curve calculator.
5. **AI Sync Engine:** Backend background jobs that compile the "Exception Filter" payloads and query the multi-model LLM stack.
