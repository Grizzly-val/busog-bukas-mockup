# Busog Bukas: the full flow

## What it's for

Feeding programs usually run on paper logs and guesswork. Organizers know how many meals they served, but not whether the people they feed are getting healthier, who is slipping, or whether the food and service are any good. Busog Bukas records every session and turns those records into two pictures: how the program is running week by week (attendance, measurements, feedback), and how each person's nutrition is doing across the whole program. The AI is planned as a nutritional analyst that spots trends. It does not replace a licensed nutritionist, and it is switched off for now.

## 1. Setup

1. **Organization:** The organizer works under an organization (for example, Kuya Dodong Feeding Mission), which has a name, an optional photo, and a description.
2. **Program:** They create a program with a title, location, who it serves, start and end dates, and a maximum number of beneficiaries.
3. **Weeks:** The system divides the program into fixed **Sunday to Saturday weeks**. Week 1 starts on the program's start date and ends that week's Saturday. Every later week runs Sunday to Saturday, and the last week stops at the end date, so it may be shorter. Every session belongs to the week its date falls in.
4. **Tier:** A program is on the **standard tier** by default. Assigning a nutritionist to it activates the **clinical tier**, which adds MUAC and edema checks. Without one, the Nutritionist Check button stays locked ("No nutritionist assigned to this program") and MUAC and edema don't appear anywhere.
5. **Calendar:** The program page shows a calendar of sessions, plus summary cards for duration, beneficiaries (45/80), and sessions submitted (6/12).

## 2. Registering beneficiaries (any session)

People can join at any point in the program, not just at the start. Registration happens from inside a session via **+ Add Beneficiary**, and that session becomes the person's *registered session*. For each person the organizer records:

- **Identity:** birth month and year, sex, and allergies (shown later as badges).
- **Weight and height (required):** These are the person's starting measurements. They are saved on the beneficiary and also as that session's measurements, so the person has a first BMI status right away.
- **A 5-digit code**, assigned by the system and unique within the program.
- **Name (optional):** A name is stored only with consent. For a minor, that means a guardian (name, contact number, relationship). For an adult, it means their own willingness. With no consent, the person gets a mnemonic **alias** like *Orange-Lemon-2*.

If the registration session's weight or height is corrected while that session is still a draft, the starting measurements are updated too, so the two never disagree. Nothing is created for a person in sessions before they registered, and their attendance is counted from enrollment onward.

## 3. One session, from start to submission

**Sessions move through three states:**

- **Upcoming:** locked until its date.
- **Draft:** open for data entry. Records can still be edited.
- **Submitted:** locked and read-only.

**What can be entered for one session.** Everything below applies to a single session only. Each session has its own set of inputs.

| Input | Per | Notes |
|---|---|---|
| Attendance | Beneficiary | Marks them present. |
| Weight, height, waist | Beneficiary | Each is optional, so a present person can have all, some, or none. Height can be updated in any session. |
| Survey answers | Beneficiary | Portion, satisfaction, service, and taste, each rated 1 to 5. Questions are worded differently for minors and adults. Optional. |
| Nutritionist check | Beneficiary | MUAC, edema, clinical notes, and which nutritionist. Clinical tier only, at most one per person per session. |
| Session notes | Session | Free text with a category such as incident, leftovers, event, or attendance. This is not tied to any person. |

**Entering the same person twice in one session** never creates a second record. The new input updates the person's existing record for that session. Data entry is done directly in the app for now, one beneficiary at a time. Bulk CSV import is planned for later and will run each row through this same path.

**Maria's case.** Maria is a registered beneficiary, and in any given session she may have:

- **no input at all:** she's absent, so she has no measurements and no survey answers.
- **attendance only:** present but not measured.
- **a partial input:** for example weight but no waist, or just a survey answer.
- **a full input:** all measurements, survey, and a nutritionist check.

Each measurement she gets creates or updates only the matching status. Weight gives a BMI status. Waist gives a WHtR status. A MUAC reading gives a MUAC status. An edema check gives an edema status. A height on its own creates no status, but it is remembered for later BMI and WHtR calculations. Anything she isn't measured for keeps its earlier status, so Maria can go sessions without input and nothing is lost or reset.

**Height carry-forward.** Only weight needs to be entered after registration. If a session has no height, the system uses the person's most recent earlier height, falling back to the registration height. For young children, whose height changes quickly, the app shows a notice when the height in use is old.

**Saving and submitting.** Statuses are updated each time a person's input is saved, including while the session is still a draft. Program-wide numbers only read **submitted** sessions, so they don't shift while someone is typing. **Submitting a session** locks it, and the system fills in an absent record for every registered beneficiary who wasn't marked present. That is why a submitted session lists everyone enrolled, while a draft shows only the people entered so far. Sessions are submitted in order. While you're working, the session screen shows live stats: attendance, how many were measured, mean BMI, mean WHtR, nutritionist checks, and meal-feedback averages with the number of responses.

## 4. Weeks of the Program

The program page has a **Weeks of the Program** card with a week selector (Week 1, Week 2, and so on, showing its Sunday to Saturday dates and sessions). It reports how the program is running, using submitted sessions only, and a person counts only for sessions on or after they registered.

- **Attendance:** how many distinct people came at least once (for example 38 of 45, 84%), how consistently they came (all days, 2-3 days, 1 day, none), and how full the sessions were (check-ins against possible check-ins, with the best and lowest day).
- **Measurements:** how many attendees were measured at all, how many are missing weight, waist, MUAC, or edema, how many submitted sessions had no measurements, and how many measurements were taken on each session day.
- **Surveys:** average score for portion, satisfaction, service, and taste across the whole week (with the number of answers behind each), how many attendees answered, and the lowest-scoring category compared with the previous week.

## 5. Nutritional status, one metric at a time

Status is tracked **separately for each metric** and across the whole program, not in cycles. There are four metrics, each with its own history:

| Metric | Gets a status when | Notes |
|---|---|---|
| BMI | weight is entered (always at registration) | WHO z-score for children, plain BMI for adults. Always on, so everyone has one. |
| WHtR | waist is entered | Waist-to-height ratio, using the height in use. |
| MUAC | a nutritionist records MUAC | Clinical tier only. |
| Edema | a nutritionist records an edema check | Clinical tier only. Yes or no. |

- **Status values:** each status is **baseline**, **monitor**, or **monitor closely**.
- **History is kept:** every measured session adds a row, and a person's current status for a metric is their newest one. Each row stores the signed change from the previous row of that metric (positive means moved toward healthy, negative means moved away). Edema has no number, so it has no change value.
- **No status:** if someone has never been measured for a metric, they simply have no status for it. There is no "unavailable" status.
- **Outdated:** a metric's status is flagged *outdated* when it is more than 14 days older than today. This is worked out by the app and never stored. It is an overlay on the three statuses, not a fourth status.
- **Last measured:** each person shows "last measured X sessions ago," counted in submitted sessions, never calendar days.

## 6. Reviewing the whole program

### Program Nutritional Status card

- **Checkboxes:** MUAC, Edema, and WHtR. BMI has no checkbox because it is always included. MUAC and Edema are hidden in programs without a nutritionist.
- **Base card:** a small table with one row per metric (BMI plus anything ticked) showing baseline, monitor, monitor closely, how many of those are outdated, and how many people have no status for that metric. For example, BMI might read 32 / 8 / 5 with 3 outdated and 0 with no status, and MUAC 10 / 6 / 4 with 5 outdated and 25 with no status.
- **Monitor and Monitor closely buttons:** each opens a window with a tab per metric, listing the people whose current status for that metric is that status, with their latest value, date, and an outdated badge.
- **Outdated button:** opens one table of every outdated status, showing the person, the metric, the status, the date, and how many days old it is.
- **View beneficiaries:** lists the people who have a status for all the ticked metrics, with how many of them are outdated.
- **Per-beneficiary view:** a table like Program Beneficiaries with one row per person and a status chip for each metric (status, date, outdated badge). Expanding a row shows that person's full history for each metric, with the changes over time.
- **Status Transitions:** a report with a **Past # days** filter. For each metric it shows how people moved between statuses over that window (improved, declined, unchanged, or newly measured), so you can see what happened recently. People with no new measurement in the window are summarized separately.

### Program Beneficiaries table

The table lists everyone enrolled. Each row shows:

- display name (real name or alias)
- age, sex, and allergy badges
- a status chip for each metric the person has been measured for
- weight and waist change, from first to latest measurement
- attendance since enrollment (for example 7/8)
- a "last measured X sessions ago" badge

You can filter by status, age, sex, minimum sessions attended, or **Needs measurement**. The **Summarize** button computes group results for the filtered people, such as how many gained or lost weight and the average change, with a small-sample warning below 5. People measured in fewer than 2 sessions show as "no paired data." Gaps and late joiners are expected here.

## Open items (defaults I assumed)

- **Status chips:** the beneficiaries table shows one chip per metric, with no combined overall status.
- **Needs measurement:** means last measured one or more submitted sessions ago.
- **Height notice:** shown for children under 5 whose height in use is older than 28 days.
- **Transitions:** lists only people with a new measurement inside the window.
- **Concern triggers:** there is no separate report, since each metric's tab in the Monitor and Monitor closely windows covers it.
- **Outdated against today:** a finished program, or old seed data, will read as outdated because the 14 days are counted from today.
