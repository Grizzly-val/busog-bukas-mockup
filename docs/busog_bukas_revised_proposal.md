# Busog Bukas — Revised Concept Proposal & MVP

## 1. Project Description
Busog Bukas is an offline-capable data capture and compliance platform for LGUs and schools running feeding programs. It replaces chaotic spreadsheet management with a robust, forgiving data staging layer and explicit tracking structures. By decoupling high-frequency attendance from low-frequency physical measurements, the platform ensures pristine data capture. It utilizes Generative AI to instantly transform deterministic nutritional data (BMI/WHtR) into narrative compliance reports, grant justifications, and de-identified systemic risk assessments, eliminating administrative friction for under-resourced organizers.

## 2. Core Problem Addressed
Organizers face two massive bottlenecks:
1. **Data Entry Friction & Fragility:** Collecting clean health metrics from overworked volunteers on the ground is difficult. Relying on strict CSV templates or inferring attendance from missing data leads to silent failures and corrupt datasets.
2. **Compliance & Bureaucracy:** Securing continuous funding requires translating raw data into formal, narrative reports. Organizers often lack the time and expertise to write these documents.

## 3. The "B + C" AI Integration Strategy
The MVP heavily utilizes Generative AI, but strictly avoids "hallucination risks" and the "telephone game" (compounding errors from summarizing past summaries) by:
1. Never asking the AI to perform math.
2. Generating narratives *only* from raw historical aggregates, triggered manually.

### Feature B: The Funding & Compliance Assistant
* **How it works:** The system uses standard, deterministic SQL to compute nutritional improvements and explicit attendance rates. It then passes this structured JSON aggregate to the LLM. 
* **The AI's Role:** Drafts formal, structured narrative reports tailored to specific LGU compliance templates or NGO grant updates.
* **Value:** Immediately saves organizers days of bureaucratic writing, directly helping them secure future funding.

### Feature C: Predictive Systemic Risk (De-identified)
* **How it works:** All PII is stripped to ensure compliance. The system calculates program-wide correlations.
* **The AI's Role:** Receives these pre-calculated anomalies and drafts a "Systemic Risk Advisory" explaining potential causes and suggesting operational pivots.

## 4. Execution Workflow & Architectural Fixes (The MVP)

1. **Unique ID Registration:** Web-based beneficiary registration that generates a short, unique ID for every child, eliminating duplicate records from name misspellings ("Juan Dela Cruz" vs "Juan de la Cruz").
2. **Decoupled Data Capture:** 
   * **Attendance (High-Frequency):** Logged explicitly (True/False markers) via simple mobile web forms or independent tallies. No negative inferences (i.e. missing data does not equal "absent").
   * **Measurements (Low-Frequency):** Logged distinctly at major milestone intervals (monthly/term).
3. **Forgiving CSV Staging Layer:** For offline data syncs, instead of strict database upserts that crash on malformed `.xlsx` files or renamed headers, the system provides a visual mapping interface to catch and fix errors *before* touching the database.
4. **Manual AI Generation:** The organizer clicks a deliberate "Run Analysis/Generate Report" button at the end of a timeline to prevent automatic race conditions and compounding errors from dirty data re-uploads.
5. **AI Output:** The LLM outputs a ready-to-print narrative document and a systemic risk advisory.

## 5. 8-Week Timeline for Creation/Production

| Week | Phase | Key Deliverables |
| :--- | :--- | :--- |
| **Week 1** | **Database & Architecture** | Finalize DB schema for Beneficiaries, Sessions, and Timelines. Implement short Unique ID generation. |
| **Week 2** | **Decoupled Data Logging** | Build the explicit attendance tracking flow (True/False) and separate the milestone physical measurements logging. |
| **Week 3** | **Forgiving Import Layer** | Develop the visual CSV staging interface for offline-to-online syncs to gracefully handle messy spreadsheets and mapping errors. |
| **Week 4** | **Deterministic Math Engine** | Write the SQL queries and backend logic to calculate BMI, WHtR, and Timeline cohort aggregations without AI. |
| **Week 5** | **AI Integration (Feature B)** | Connect to the LLM API. Design prompt templates to accept the JSON aggregates and output formal grant/compliance reports via a manual trigger. |
| **Week 6** | **AI Integration (Feature C)** | Build the PII-stripping pipeline. Feed statistical anomalies into the LLM to generate the Systemic Risk Advisories. |
| **Week 7** | **Data Privacy & Security** | Implement local offline data encryption protocols for PII at rest and finalize strict data governance rules for volunteer devices. |
| **Week 8** | **Pilot & Presentation Prep** | Deploy MVP. Validate the UI by having a mock-user attempt to ingest messy data, map it, and manually generate a report. Finalize thesis/project presentation. |

## 6. Regulatory & Privacy Compliance
Handling children's health data via offline CSVs across unmanaged volunteer devices presents severe legal liabilities. To ensure compliance with the Philippine Data Privacy Act:
- **Unique IDs over Names:** PII is minimized instantly via system-generated IDs.
- **Offline Encryption:** Data stored locally on devices before online sync is strictly governed and encrypted at rest to prevent exposure in case of device theft.
- **Explicit Consent:** Registration includes a mandatory checkbox for parental/guardian consent.
- **Strict Anonymization for AI:** The AI integration *never* receives beneficiary names, exact birthdates, or direct identifiers. The LLM only receives aggregated numerical trends and anonymized cohort IDs.
