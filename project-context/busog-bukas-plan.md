# Busog Bukas: implementation plan (weeks + per-metric status)

Matches the revised `01_init_schema.sql`. Items marked **(assumed)** are defaults I chose where nothing was specified; change them freely.

## 1. Core model

The Timeline concept is removed. Two independent layers replace it:

1. **Weeks of the Program** (operational analytics): fixed Sunday-Saturday weeks stored in `program_week`.
2. **Per-metric nutritional status** (outcomes): four insert-only history tables, one per metric (BMI, WHtR, MUAC, edema), covering the whole program.

Status keys are `baseline`, `monitor`, `monitor_closely`. There is no "Unavailable" status. "No status" and "Outdated" are computed in code and never stored.

## 2. Data rules

### 2.1 Weeks
- Week 1 runs from `program.start_date` to that week's Saturday. Week 2+ runs Sunday to Saturday. The last week is capped at `program.end_date`.
- Generate weeks with `generate_program_weeks(program_id)` before any session exists. Every session stores a `week_id`; a trigger rejects a session date outside its week.
- If program dates are edited later, delete weeks with no sessions and generate or append the missing ones.

### 2.2 Registration
- Weight and height are required at registration.
- In one transaction: insert the beneficiary (`initial_weight_kg`, `initial_height_cm`), insert the registration `session_record` (`is_present = TRUE`, same weight and height), and insert the BMI status row for that session.
- **Write-through:** if a session input is for the beneficiary's `registered_session_id` and changes weight or height, also update `beneficiary.initial_*` (only while that session is a draft).
- Everyone therefore has a BMI status from registration onward.

### 2.3 Entering and re-entering session input
- One `session_record` per (session, beneficiary). Entering the same beneficiary again in the same session updates the existing row; it never creates a second one.
- Registration can happen in any session. Sessions before a person's registered session never get rows for them.
- At submission, absent rows (`is_present = FALSE`) are reconciled for everyone registered on or before that session. Sessions are submitted in chronological order.
- **CSV import is postponed.** For now, simulate the import by running each CSV row through the same per-beneficiary entry path as manual input.

### 2.4 Height
- Height is nullable on every session, so it can be updated in any session.
- Height used for BMI and WHtR: the session's height if present, else the latest non-NULL height on or before the session date, else `initial_height_cm`.
- **Height notice:** a small function shows "this child may be growing quickly, take a fresh height" only when the beneficiary is young **and** the height in use is old. **(assumed)** Age under 5 and height older than 28 days; both are constants.

### 2.5 Per-metric status tables

| Metric | Table | A row exists when | Change column |
|---|---|---|---|
| BMI | `beneficiary_bmi_status` | weight entered (always at registration) | `bmi_change` |
| WHtR | `beneficiary_whtr_status` | waist entered (uses height from 2.4) | `whtr_change` |
| MUAC | `beneficiary_muac_status` | `nutritionist_record.muac_cm` entered | `muac_change` |
| Edema | `beneficiary_edema_status` | `nutritionist_record.edema` entered | none (yes/no) |

- **History:** rows are insert-only per session. "Latest" is the row with the newest `session_date`. Never use `session_id`, which is a UUID.
- **Writing:** on every save of a beneficiary's session input (draft included), upsert each metric's row if its source exists, and delete it if the source was cleared. Then recompute the change on the next row of that metric, if any.
- **Change values:** signed against the previous row of the same table. Positive means moved toward healthy, negative means moved away, NULL on the first row.
- **Reading:** all program-wide numbers use the `v_latest_*` views, which only include submitted sessions, so the cards don't shift while someone is typing a draft.
- A beneficiary never measured for a metric simply has no row for it. In a program without a nutritionist, MUAC and edema don't exist at all.

### 2.6 Computed in code
- **Outdated (per metric):** days between the latest row's `session_date` and today are greater than 14. It is measured against the actual current day, not a session. The 14 is one constant.
- **No status (per metric):** the beneficiary has no row in that metric's latest view.
- **Last measured X sessions ago:** count of submitted sessions after the newest status row (any metric) through the latest submitted session. Sessions only, never calendar days.
- **Needs measurement filter:** **(assumed)** last measured one or more submitted sessions ago.

```sql
-- Outdated count per metric
SELECT metric, COUNT(*) AS outdated
  FROM v_latest_metric_status
 WHERE program_id = ? AND DATEDIFF(CURRENT_DATE, session_date) > 14
 GROUP BY metric;
```

## 3. UI

### 3.1 Weeks of the Program card (replaces Timelines & Coverage)
A week selector (Week 1, Week 2, ... with Sun-Sat dates and its sessions) over three metric groups. A beneficiary counts only for sessions on or after their registration.
- **Attendance:** reach (distinct attendees / eligible enrolled), consistency (all days / 2-3 days / 1 day / 0 days), and fill rate (check-ins / eligible slots, best and lowest day).
- **Measurements:** unique measurement coverage among attendees, missing weight / waist / MUAC / edema among attendees (MUAC and edema only with a nutritionist), submitted sessions with zero measurements, and measurements per session day.
- **Surveys:** pooled category averages with `(n=X)`, response rate (unique respondents / unique attendees), and the lowest category with its change vs last week.

### 3.2 Program Nutritional Status card (program-wide)
**Checkboxes:** MUAC, Edema, WHtR. BMI has no checkbox because it is always on. MUAC and Edema are hidden or disabled when the program has no nutritionist.

**Base card (before any modal):** per-metric cohort numbers for BMI plus every ticked metric. Example:

| Metric | Baseline | Monitor | Monitor closely | Outdated | No status |
|---|---|---|---|---|---|
| BMI | 32 | 8 | 5 | 3 | 0 |
| MUAC | 10 | 6 | 4 | 5 | 25 |

Each row's counts are over everyone enrolled. Outdated is a subset overlay of the three status counts, so label it like "of which outdated" so it doesn't read as a fourth bucket.

**Buttons and modals:**
- **Monitor** and **Monitor closely**: each opens a modal with a subtab per metric (BMI, MUAC, WHtR, Edema). Each tab lists the beneficiaries whose latest status for that metric is that status: code, name or alias, latest value, status date, outdated badge.
- **Outdated:** one table with one row per outdated (beneficiary, metric): code, name or alias, **metric key** (bmi / muac / whtr / edema), **status**, status date, days old.
- **View beneficiaries** (for the ticked metrics): a table of beneficiaries who have a status for **all** ticked metrics, with a count of how many are outdated.

**Per-beneficiary view** (a table in this card, like Program Beneficiaries): one row per beneficiary with a status chip per metric (status, date, outdated badge) and "last measured X sessions ago". Expanding a row shows that person's full history from the insert-only rows: each metric's statuses over time with the signed changes.

**Status Transitions report** with a **"Past # days"** filter (default 14):
- Window = today minus # days through today. For each beneficiary and metric: "from" is the last status on or before the window start, "to" is the latest status. If the first status falls inside the window, tag it **New**.
- Output: a table by metric, showing from → to with counts, tagged improved, declined, unchanged, or new. **(assumed)** only beneficiaries with a new row inside the window appear; the rest are summarized as "no new measurement."
- Status order for improved or declined: baseline < monitor < monitor_closely (a small dictionary in code).

**Nutritional Concern Triggers:** now covered by the Monitor and Monitor closely modals, since each metric's subtab is its trigger key. **(assumed)** no separate report.

The AI Longitudinal Trend panel stays hidden (ghost feature).

### 3.3 Program Beneficiaries table
- The single "latest status" column becomes one chip per metric the beneficiary has (BMI always, others if measured). **(assumed)** No combined overall status.
- Keep the Filtered Cohort Summary and Summarize button unchanged.
- Add the "Last measured X sessions ago" badge next to the Needs measurement filter.

## 4. Seed data
- Update `02_seed_data.sql`: remove `unavailable` from `status_definition`, drop the status-reason rows, create sessions with the correct `week_id`, and fill the four status tables (BMI row at each beneficiary's registration, others when measured).
- Seed dates in the past will show as Outdated against today's date. For a demo, either generate dates relative to today or accept that old data reads as outdated.

## 5. Assumptions to confirm
1. Program Beneficiaries shows per-metric chips, not one combined status.
2. Needs measurement means last measured one or more sessions ago.
3. Height notice constants: under 5 years old and height older than 28 days.
4. Transitions list only people with a new row inside the window.
5. No separate Concern Triggers report.
