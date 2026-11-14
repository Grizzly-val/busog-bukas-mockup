import { query } from './db';
import { getMockToday } from './mockToday';
import {
  computeSessionState,
  computeWeekState,
  type SessionState,
  type WeekState,
} from './timelineRules';
import {
  ALL_METRICS,
  ageInMonths,
  approxBmiForAgeZ,
  classifyCohortTransitionTag,
  computeBmi,
  computeWhtr,
  getMetricDaysOld,
  isAdultAt,
  isMetricOutdated,
  NEEDS_MEASUREMENT_MIN_SESSIONS_AGO,
  resolveEffectiveHeight,
  round,
  shouldShowHeightNotice,
  type CohortTransitionTag,
  type MetricKey,
  type MetricStatusHistoryPoint,
  type Sex,
  type StatusKey,
} from './statusRule';
import { computeFirstToLatestDelta } from './beneficiarySummary';

function toNum(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

const SURVEY_CATEGORY_LABELS: Record<string, string> = {
  q_portion: 'Portion',
  q_service: 'Service',
  q_taste: 'Taste',
  q_satisfaction: 'Satisfaction',
};

function formatSurveyCategoryLabel(questionId: string): string {
  if (SURVEY_CATEGORY_LABELS[questionId]) return SURVEY_CATEGORY_LABELS[questionId];
  return questionId
    .replace(/^q_/, '')
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

// ---------------------------------------------------------------------------
// Public Types
// ---------------------------------------------------------------------------

export type ProgramDetail = {
  program_id: string;
  org_id: string;
  title: string;
  location: string;
  description: string;
  start_date: string;
  end_date: string;
  max_beneficiaries: number;
  enrolled: number;
  session_total: number;
  week_total: number;
  nutritionist_count: number;
};

export type SessionNoteRow = {
  note_id: string;
  session_id: string;
  category: string;
  note: string;
};

export type SessionMetricStatusSnapshot = {
  status_key: StatusKey;
  change_value: number | null;
};

export type SessionRecordSummary = {
  session_id: string;
  beneficiary_code: string;
  name: string | null;
  alias: string | null;
  displayName: string;
  sex: Sex;
  age: number;
  is_present: boolean;
  weight_kg: number | null;
  height_cm: number | null;
  effective_height_cm: number | null;
  effective_height_date: string | null;
  height_carried_forward: boolean;
  height_notice: boolean;
  waist_cm: number | null;
  bmi: number | null;
  whtr: number | null;
  survey_answers: Record<string, number>;
  nutritionist_id: string | null;
  muac_cm: number | null;
  edema: boolean | null;
  clinical_notes: string | null;
  metric_statuses: Partial<Record<MetricKey, SessionMetricStatusSnapshot>>;
};

export type SessionAggregates = {
  present_count: number;
  registered_count: number;
  measured_count: number;
  bmi_mean: number | null;
  bmi_n: number;
  whtr_mean: number | null;
  whtr_n: number;
  survey_averages: Record<string, { avg: number; n: number }>;
  nutritionist_checks_count: number;
};

export type SessionData = {
  session_id: string;
  program_id: string;
  week_id: string;
  week_number: number | null;
  session_date: string;
  submitted_at: string | null;
  record_count: number;
  present_count: number;
  state: SessionState;
  notes: Array<{ note_id: string; category: string; note: string }>;
  aggregates: SessionAggregates;
  records: SessionRecordSummary[];
};

export type WeekSessionDayAttendance = {
  session_id: string;
  session_date: string;
  present_count: number;
  eligible_count: number;
  pct: number;
};

export type WeekSessionDayMeasurements = {
  session_id: string;
  session_date: string;
  present_count: number;
  measured_count: number;
  weight_count: number;
  waist_count: number;
  muac_count: number;
  edema_count: number;
  zero_measurements: boolean;
};

export type WeekSurveyCategorySummary = {
  question_id: string;
  label: string;
  avg: number | null;
  n: number;
  prev_avg: number | null;
  delta: number | null;
};

export type ProgramWeekData = {
  week_id: string;
  program_id: string;
  week_number: number;
  week_start_date: string;
  week_end_date: string;
  state: WeekState;
  sessions: SessionData[];
  submitted_session_count: number;
  has_submitted_data: boolean;
  attendance: {
    reach_attended: number;
    reach_eligible: number;
    reach_pct: number;
    new_registrations_count: number;
    consistency: {
      all_days: number;
      two_to_three_days: number;
      one_day: number;
      zero_days: number;
    };
    fill_check_ins: number;
    fill_eligible_slots: number;
    fill_pct: number;
    best_day: WeekSessionDayAttendance | null;
    lowest_day: WeekSessionDayAttendance | null;
    per_day: WeekSessionDayAttendance[];
  };
  measurements: {
    unique_measured_count: number;
    unique_present_count: number;
    coverage_pct: number;
    missing_weight_count: number;
    missing_waist_count: number;
    missing_muac_count: number;
    missing_edema_count: number;
    zero_measurement_sessions_count: number;
    per_day: WeekSessionDayMeasurements[];
  };
  surveys: {
    respondent_count: number;
    attendee_count: number;
    response_rate_pct: number;
    categories: WeekSurveyCategorySummary[];
    lowest_category: WeekSurveyCategorySummary | null;
  };
};

export type BeneficiaryLatestMetricStatus = {
  metric: MetricKey;
  session_id: string;
  session_date: string;
  status_key: StatusKey;
  change_value: number | null;
  days_old: number;
  is_outdated: boolean;
  latest_value_display: string;
};

export type NutritionalMetricSummaryRow = {
  metric: MetricKey;
  label: string;
  baseline_count: number;
  monitor_count: number;
  monitor_closely_count: number;
  outdated_count: number;
  no_status_count: number;
  measured_count: number;
  outdated_breakdown: Record<StatusKey, number>;
};

export type NutritionalStatusModalRow = {
  beneficiary_code: string;
  display_name: string;
  metric: MetricKey;
  status_key: StatusKey;
  session_id: string;
  session_date: string;
  days_old: number;
  is_outdated: boolean;
  latest_value_display: string;
  change_value: number | null;
};

export type OutdatedModalRow = NutritionalStatusModalRow;

export type SubmittedSessionInfo = {
  session_id: string;
  session_number: number;
  session_date: string;
};

export type BeneficiaryCohortRow = {
  beneficiary_code: string;
  display_name: string;
  metric: MetricKey;
  first_session_id: string;
  first_session_number: number;
  first_session_date: string;
  first_status: StatusKey;
  first_value: number | null;
  first_value_display: string;
  latest_session_id: string;
  latest_session_number: number;
  latest_session_date: string;
  latest_status: StatusKey;
  latest_value: number | null;
  latest_value_display: string;
  measurement_count: number;
  sessions_attended: number;
  net_change: number | null;
  transition_tag: CohortTransitionTag;
};

export type MetricCohortSummary = {
  metric: MetricKey;
  label: string;
  total_measured: number;
  no_status_count: number;
  single_measurement_count: number;
  improved_count: number;
  unchanged_count: number;
  declined_count: number;
  rows: BeneficiaryCohortRow[];
};

export type NutritionalStatusProgramData = {
  has_nutritionist: boolean;
  available_metrics: MetricKey[];
  enrolled_count: number;
  submitted_sessions: SubmittedSessionInfo[];
  cohort_tracking: Partial<Record<MetricKey, MetricCohortSummary>>;
  metrics: Record<MetricKey, NutritionalMetricSummaryRow>;
  monitor_rows: Record<MetricKey, NutritionalStatusModalRow[]>;
  monitor_closely_rows: Record<MetricKey, NutritionalStatusModalRow[]>;
  outdated_rows: OutdatedModalRow[];
};

export type BeneficiaryMeasurement = {
  session_id: string;
  session_date: string;
  week_number: number | null;
  submitted_at: string | null;
  is_present: boolean;
  weight_kg: number | null;
  height_cm: number | null;
  effective_height_cm: number | null;
  effective_height_date: string | null;
  height_carried_forward: boolean;
  waist_cm: number | null;
  bmi: number | null;
  whtr: number | null;
  muac_cm: number | null;
  edema: boolean | null;
  clinical_notes: string | null;
};

export type BeneficiaryData = {
  program_id: string;
  beneficiary_code: string;
  name: string | null;
  alias: string | null;
  displayName: string;
  birth_month: number;
  birth_year: number;
  sex: Sex;
  age: number;
  isAdult: boolean;
  initial_weight_kg: number;
  initial_height_cm: number;
  effective_height_cm: number | null;
  effective_height_date: string | null;
  height_notice: boolean;
  registered_session_id: string;
  registered_session_date: string;
  latest_statuses: Partial<Record<MetricKey, BeneficiaryLatestMetricStatus>>;
  metric_history: Record<MetricKey, MetricStatusHistoryPoint[]>;
  /** For backwards compatibility with existing FilterableBeneficiaryRow helper */
  metric_statuses: Partial<Record<MetricKey, { status_key: StatusKey } | null>>;
  weight_change: number | null;
  weight_change_pct: number | null;
  waist_change: number | null;
  muac_change: number | null;
  last_measured_date: string | null;
  last_measured_sessions_ago: number | null;
  needs_measurement_warning: boolean;
  attendance_pct: number;
  attended_count: number;
  eligible_sessions_count: number;
  allergies: string[];
  guardians: Array<{ name: string; number: string; relationship: string }>;
  explicit_heights: Array<{ session_id: string; session_date: string; height_cm: number }>;
  measurements: BeneficiaryMeasurement[];
};

export type AssignedNutritionist = {
  nutritionist_id: string;
  name: string;
  credentials: string | null;
};

export type AvailableAllergy = {
  allergy_id: string;
  name: string;
};

export type SurveyQuestion = {
  question_id: string;
  prompt_minor: string;
  prompt_adult: string;
};

export type ProgramPageData = {
  program: ProgramDetail;
  sessions: SessionData[];
  weeks: ProgramWeekData[];
  nutritionalStatus: NutritionalStatusProgramData;
  beneficiaries: BeneficiaryData[];
  availableAllergies: AvailableAllergy[];
  assignedNutritionists: AssignedNutritionist[];
  surveyQuestions: SurveyQuestion[];
  today: string;
};

// ---------------------------------------------------------------------------
// Main Loader
// ---------------------------------------------------------------------------

export async function getProgramPageData(programId: string): Promise<ProgramPageData | null> {
  const today = getMockToday();

  // 1. Program details
  const [programRaw] = await query<ProgramDetail>(
    `SELECT p.program_id, p.org_id, p.title, p.location, p.description,
            DATE_FORMAT(p.start_date, '%Y-%m-%d') AS start_date,
            DATE_FORMAT(p.end_date, '%Y-%m-%d') AS end_date,
            p.max_beneficiaries,
            (SELECT COUNT(*) FROM beneficiary b WHERE b.program_id = p.program_id) AS enrolled,
            (SELECT COUNT(*) FROM program_session s WHERE s.program_id = p.program_id) AS session_total,
            (SELECT COUNT(*) FROM program_week pw WHERE pw.program_id = p.program_id) AS week_total,
            (SELECT COUNT(*) FROM program_nutritionist pn WHERE pn.program_id = p.program_id) AS nutritionist_count
       FROM program p
      WHERE p.program_id = ?
      LIMIT 1`,
    [programId]
  );

  if (!programRaw) return null;

  const program: ProgramDetail = {
    ...programRaw,
    max_beneficiaries: Number(programRaw.max_beneficiaries),
    enrolled: Number(programRaw.enrolled),
    session_total: Number(programRaw.session_total),
    week_total: Number(programRaw.week_total),
    nutritionist_count: Number(programRaw.nutritionist_count),
  };
  const hasNutritionist = program.nutritionist_count > 0;
  const availableMetrics: MetricKey[] = hasNutritionist
    ? ['bmi', 'whtr', 'muac', 'edema']
    : ['bmi', 'whtr'];

  // 2. Program weeks
  type RawWeek = {
    week_id: string;
    program_id: string;
    week_number: number;
    week_start_date: string;
    week_end_date: string;
  };
  const rawWeeks = await query<RawWeek>(
    `SELECT week_id, program_id, week_number,
            DATE_FORMAT(week_start_date, '%Y-%m-%d') AS week_start_date,
            DATE_FORMAT(week_end_date, '%Y-%m-%d') AS week_end_date
       FROM program_week
      WHERE program_id = ?
      ORDER BY week_number ASC`,
    [programId]
  );
  const weekNumberById = new Map<string, number>();
  for (const w of rawWeeks) {
    weekNumberById.set(w.week_id, Number(w.week_number));
  }

  // 3. Program sessions
  type RawSession = {
    session_id: string;
    program_id: string;
    week_id: string;
    session_date: string;
    submitted_at: string | null;
    record_count: number;
    present_count: number;
  };
  const rawSessions = await query<RawSession>(
    `SELECT s.session_id, s.program_id, s.week_id,
            DATE_FORMAT(s.session_date, '%Y-%m-%d') AS session_date,
            s.submitted_at,
            (SELECT COUNT(*) FROM session_record sr WHERE sr.session_id = s.session_id AND sr.program_id = s.program_id) AS record_count,
            (SELECT COUNT(*) FROM session_record sr WHERE sr.session_id = s.session_id AND sr.program_id = s.program_id AND sr.is_present = TRUE) AS present_count
       FROM program_session s
      WHERE s.program_id = ?
      ORDER BY s.session_date ASC`,
    [programId]
  );
  const sessionDateById = new Map<string, string>();
  const sessionSubmittedById = new Map<string, string | null>();
  const sessionWeekNumById = new Map<string, number | null>();
  for (const rs of rawSessions) {
    const sd = rs.session_date.slice(0, 10);
    sessionDateById.set(rs.session_id, sd);
    sessionSubmittedById.set(rs.session_id, rs.submitted_at);
    sessionWeekNumById.set(rs.session_id, weekNumberById.get(rs.week_id) ?? null);
  }

  // 4. Beneficiaries + aliases + initial measurements
  type RawBeneficiary = {
    program_id: string;
    beneficiary_code: string;
    name: string | null;
    alias: string | null;
    birth_month: number;
    birth_year: number;
    sex: Sex;
    initial_weight_kg: number | string;
    initial_height_cm: number | string;
    registered_session_id: string;
    registered_session_date: string;
  };
  const rawBeneficiaries = await query<RawBeneficiary>(
    `SELECT b.program_id, b.beneficiary_code, b.name, ba.alias,
            b.birth_month, b.birth_year, b.sex,
            b.initial_weight_kg, b.initial_height_cm,
            b.registered_session_id,
            DATE_FORMAT(ps.session_date, '%Y-%m-%d') AS registered_session_date
       FROM beneficiary b
       LEFT JOIN beneficiary_alias ba
         ON ba.program_id = b.program_id AND ba.beneficiary_code = b.beneficiary_code
       JOIN program_session ps
         ON ps.session_id = b.registered_session_id AND ps.program_id = b.program_id
      WHERE b.program_id = ?
      ORDER BY CAST(b.beneficiary_code AS UNSIGNED) ASC`,
    [programId]
  );

  // 5. Session notes (schema columns: note_id, session_id, category, note)
  const rawNotes = await query<SessionNoteRow>(
    `SELECT sn.note_id, sn.session_id, sn.category, sn.note
       FROM session_note sn
       JOIN program_session ps ON ps.session_id = sn.session_id
      WHERE ps.program_id = ?
      ORDER BY sn.note_id ASC`,
    [programId]
  );
  const notesBySession = new Map<string, Array<{ note_id: string; category: string; note: string }>>();
  for (const n of rawNotes) {
    const arr = notesBySession.get(n.session_id) ?? [];
    arr.push({ note_id: n.note_id, category: n.category, note: n.note });
    notesBySession.set(n.session_id, arr);
  }

  // 6. Session records + nutritionist records
  type RawRecord = {
    session_id: string;
    beneficiary_code: string;
    is_present: number | boolean;
    weight_kg: number | string | null;
    height_cm: number | string | null;
    waist_cm: number | string | null;
    nutritionist_id: string | null;
    muac_cm: number | string | null;
    edema: number | boolean | null;
    clinical_notes: string | null;
  };
  const rawRecords = await query<RawRecord>(
    `SELECT sr.session_id, sr.beneficiary_code, sr.is_present,
            sr.weight_kg, sr.height_cm, sr.waist_cm,
            nr.nutritionist_id, nr.muac_cm, nr.edema, nr.clinical_notes
       FROM session_record sr
       LEFT JOIN nutritionist_record nr
         ON nr.session_id = sr.session_id
        AND nr.program_id = sr.program_id
        AND nr.beneficiary_code = sr.beneficiary_code
      WHERE sr.program_id = ?`,
    [programId]
  );

  // 7. Survey answers & questions
  type RawSurveyAnswer = {
    session_id: string;
    beneficiary_code: string;
    question_id: string;
    value: number;
  };
  const rawSurveys = await query<RawSurveyAnswer>(
    'SELECT session_id, beneficiary_code, question_id, `value` FROM survey_answer WHERE program_id = ?',
    [programId]
  );
  const surveyBySessionAndBen = new Map<string, Record<string, number>>();
  for (const sa of rawSurveys) {
    const key = `${sa.session_id}__${sa.beneficiary_code}`;
    const map = surveyBySessionAndBen.get(key) ?? {};
    map[sa.question_id] = Number(sa.value);
    surveyBySessionAndBen.set(key, map);
  }
  const surveyQuestions = await query<SurveyQuestion>(
    'SELECT question_id, prompt_minor, prompt_adult FROM survey_question ORDER BY question_id ASC'
  );

  // 8. Allergies & Guardians
  const availableAllergies = await query<AvailableAllergy>(
    'SELECT allergy_id, name FROM allergy ORDER BY name ASC'
  );
  type RawBenAllergy = { beneficiary_code: string; name: string };
  const rawBenAllergies = await query<RawBenAllergy>(
    `SELECT ba.beneficiary_code, a.name
       FROM beneficiary_allergy ba
       JOIN allergy a ON a.allergy_id = ba.allergy_id
      WHERE ba.program_id = ?
      ORDER BY a.name ASC`,
    [programId]
  );
  const allergiesByBen = new Map<string, string[]>();
  for (const row of rawBenAllergies) {
    const arr = allergiesByBen.get(row.beneficiary_code) ?? [];
    arr.push(row.name);
    allergiesByBen.set(row.beneficiary_code, arr);
  }

  type RawBenGuardian = { beneficiary_code: string; name: string; number: string; relationship: string };
  const rawGuardians = await query<RawBenGuardian>(
    `SELECT c.beneficiary_code, g.name, g.\`number\`, c.relationship
       FROM consent c
       JOIN guardian g ON g.guardian_id = c.guardian_id
      WHERE c.program_id = ?
      ORDER BY c.consented_at ASC`,
    [programId]
  );
  const guardiansByBen = new Map<string, Array<{ name: string; number: string; relationship: string }>>();
  for (const g of rawGuardians) {
    const arr = guardiansByBen.get(g.beneficiary_code) ?? [];
    arr.push({ name: g.name, number: g.number, relationship: g.relationship });
    guardiansByBen.set(g.beneficiary_code, arr);
  }

  // 9. Assigned nutritionists
  const assignedNutritionists = await query<AssignedNutritionist>(
    `SELECT n.nutritionist_id, n.name, n.credentials
       FROM program_nutritionist pn
       JOIN nutritionist n ON n.nutritionist_id = pn.nutritionist_id
      WHERE pn.program_id = ?
      ORDER BY n.name ASC`,
    [programId]
  );

  // 10. Program-wide latest statuses via `v_latest_*` views (submitted sessions only, auto-scoped to availableMetrics)
  type RawViewMetricRow = {
    beneficiary_code: string;
    metric: MetricKey;
    session_id: string;
    session_date: string;
    status_key: StatusKey;
    change_value: number | string | null;
  };
  const metricPlaceholders = availableMetrics.map(() => '?').join(', ');
  const rawLatestViewRows = await query<RawViewMetricRow>(
    `SELECT beneficiary_code, metric, session_id,
            DATE_FORMAT(session_date, '%Y-%m-%d') AS session_date,
            status_key, change_value
       FROM v_latest_metric_status
      WHERE program_id = ?
        AND metric IN (${metricPlaceholders})`,
    [programId, ...availableMetrics]
  );

  // 11. Per-metric status history rows (all rows for session modal snapshot + submitted-only for cohort tracking & history)
  type RawStatusTableRow = {
    metric: MetricKey;
    session_id: string;
    session_date: string;
    submitted_at: string | null;
    beneficiary_code: string;
    status_key: StatusKey;
    change_value: number | string | null;
  };
  const statusQueryParts: Array<{ sql: string; params: string[] }> = [
    {
      sql: `SELECT 'bmi' AS metric, s.session_id, DATE_FORMAT(ps.session_date, '%Y-%m-%d') AS session_date,
                   ps.submitted_at, s.beneficiary_code, s.status_key, s.bmi_change AS change_value
              FROM beneficiary_bmi_status s
              JOIN program_session ps ON ps.session_id = s.session_id AND ps.program_id = s.program_id
             WHERE s.program_id = ?`,
      params: [programId],
    },
    {
      sql: `SELECT 'whtr' AS metric, s.session_id, DATE_FORMAT(ps.session_date, '%Y-%m-%d') AS session_date,
                   ps.submitted_at, s.beneficiary_code, s.status_key, s.whtr_change AS change_value
              FROM beneficiary_whtr_status s
              JOIN program_session ps ON ps.session_id = s.session_id AND ps.program_id = s.program_id
             WHERE s.program_id = ?`,
      params: [programId],
    },
  ];
  if (hasNutritionist) {
    statusQueryParts.push(
      {
        sql: `SELECT 'muac' AS metric, s.session_id, DATE_FORMAT(ps.session_date, '%Y-%m-%d') AS session_date,
                     ps.submitted_at, s.beneficiary_code, s.status_key, s.muac_change AS change_value
                FROM beneficiary_muac_status s
                JOIN program_session ps ON ps.session_id = s.session_id AND ps.program_id = s.program_id
               WHERE s.program_id = ?`,
        params: [programId],
      },
      {
        sql: `SELECT 'edema' AS metric, s.session_id, DATE_FORMAT(ps.session_date, '%Y-%m-%d') AS session_date,
                     ps.submitted_at, s.beneficiary_code, s.status_key, NULL AS change_value
                FROM beneficiary_edema_status s
                JOIN program_session ps ON ps.session_id = s.session_id AND ps.program_id = s.program_id
               WHERE s.program_id = ?`,
        params: [programId],
      }
    );
  }
  const rawAllStatusRows = await query<RawStatusTableRow>(
    `${statusQueryParts.map((q) => q.sql).join('\n     UNION ALL\n     ')}
     ORDER BY session_date ASC, session_id ASC`,
    statusQueryParts.flatMap((q) => q.params)
  );

  // Lookup map: session_id__beneficiary_code -> Partial<Record<MetricKey, SessionMetricStatusSnapshot>>
  const statusBySessionBen = new Map<string, Partial<Record<MetricKey, SessionMetricStatusSnapshot>>>();
  // Submitted-only history per beneficiary + metric
  const historyByBenMetric = new Map<string, MetricStatusHistoryPoint[]>();

  for (const row of rawAllStatusRows) {
    const sbKey = `${row.session_id}__${row.beneficiary_code}`;
    const snapMap = statusBySessionBen.get(sbKey) ?? {};
    snapMap[row.metric] = {
      status_key: row.status_key,
      change_value: toNum(row.change_value),
    };
    statusBySessionBen.set(sbKey, snapMap);

    if (row.submitted_at != null) {
      const hmKey = `${row.beneficiary_code}__${row.metric}`;
      const list = historyByBenMetric.get(hmKey) ?? [];
      list.push({
        session_id: row.session_id,
        session_date: row.session_date.slice(0, 10),
        week_number: sessionWeekNumById.get(row.session_id) ?? null,
        status_key: row.status_key,
        change_value: toNum(row.change_value),
      });
      historyByBenMetric.set(hmKey, list);
    }
  }

  // Group rawRecords by beneficiary_code AND by session_id
  const recordsByBen = new Map<string, RawRecord[]>();
  for (const r of rawRecords) {
    const arr = recordsByBen.get(r.beneficiary_code) ?? [];
    arr.push(r);
    recordsByBen.set(r.beneficiary_code, arr);
  }

  // Resolve carry-forward heights chronologically for every beneficiary's records
  // Lookup resolved values by `session_id__beneficiary_code`
  type ResolvedRecordMetrics = {
    effective_height_cm: number | null;
    effective_height_date: string | null;
    height_carried_forward: boolean;
    height_notice: boolean;
    bmi: number | null;
    whtr: number | null;
  };
  const resolvedBySessionBen = new Map<string, ResolvedRecordMetrics>();
  const rawBenByCode = new Map<string, RawBeneficiary>();
  const explicitHeightsByBen = new Map<string, Array<{ session_id: string; session_date: string; height_cm: number }>>();
  const measurementsByBen = new Map<string, BeneficiaryMeasurement[]>();
  const presentRecordsByBenSession = new Map<string, Map<string, RawRecord>>();

  for (const rb of rawBeneficiaries) {
    rawBenByCode.set(rb.beneficiary_code, rb);
    const benRecs = [...(recordsByBen.get(rb.beneficiary_code) ?? [])].sort((a, b) => {
      const da = sessionDateById.get(a.session_id) ?? '';
      const db = sessionDateById.get(b.session_id) ?? '';
      return da.localeCompare(db);
    });

    const initialHeight = toNum(rb.initial_height_cm);
    const regDate = rb.registered_session_date.slice(0, 10);
    const priorHeights: Array<{ sessionDate: string; heightCm: number }> = [];
    const explicitHeights: Array<{ session_id: string; session_date: string; height_cm: number }> = [];
    const benMeasurements: BeneficiaryMeasurement[] = [];
    const bySessionMap = new Map<string, RawRecord>();

    for (const r of benRecs) {
      bySessionMap.set(r.session_id, r);
      const sDate = sessionDateById.get(r.session_id) ?? '';
      const submittedAt = sessionSubmittedById.get(r.session_id) ?? null;
      const isPresent = Boolean(r.is_present);
      const weightKg = toNum(r.weight_kg);
      const heightCm = toNum(r.height_cm);
      const waistCm = toNum(r.waist_cm);
      const muacCm = toNum(r.muac_cm);
      const edema = r.edema === null || r.edema === undefined ? null : Boolean(r.edema);

      let effHeightCm: number | null = null;
      let effHeightDate: string | null = null;
      let carriedForward = false;
      let heightNotice = false;

      if (isPresent) {
        const eh = resolveEffectiveHeight({
          sessionDate: sDate,
          sessionHeightCm: heightCm,
          priorHeights,
          initialHeightCm: initialHeight,
          registrationDate: regDate,
        });
        effHeightCm = eh.heightCm;
        effHeightDate = eh.heightDate;
        carriedForward = eh.carriedForward;

        if (heightCm != null && heightCm > 0) {
          priorHeights.push({ sessionDate: sDate, heightCm });
          explicitHeights.push({ session_id: r.session_id, session_date: sDate, height_cm: heightCm });
        }

        heightNotice = shouldShowHeightNotice({
          birthMonth: Number(rb.birth_month),
          birthYear: Number(rb.birth_year),
          effectiveHeightDate: effHeightDate,
          asOfDate: sDate,
        });
      }

      const bmi = isPresent ? computeBmi(weightKg, effHeightCm) : null;
      const whtr = isPresent ? computeWhtr(waistCm, effHeightCm) : null;

      resolvedBySessionBen.set(`${r.session_id}__${rb.beneficiary_code}`, {
        effective_height_cm: effHeightCm,
        effective_height_date: effHeightDate,
        height_carried_forward: carriedForward,
        height_notice: heightNotice,
        bmi,
        whtr,
      });

      benMeasurements.push({
        session_id: r.session_id,
        session_date: sDate,
        week_number: sessionWeekNumById.get(r.session_id) ?? null,
        submitted_at: submittedAt,
        is_present: isPresent,
        weight_kg: weightKg,
        height_cm: heightCm,
        effective_height_cm: effHeightCm,
        effective_height_date: effHeightDate,
        height_carried_forward: carriedForward,
        waist_cm: waistCm,
        bmi,
        whtr,
        muac_cm: muacCm,
        edema,
        clinical_notes: r.clinical_notes ?? null,
      });
    }

    explicitHeightsByBen.set(rb.beneficiary_code, explicitHeights);
    measurementsByBen.set(rb.beneficiary_code, benMeasurements);
    presentRecordsByBenSession.set(rb.beneficiary_code, bySessionMap);
  }

  // Group records by session_id for building SessionData
  const recordsBySession = new Map<string, RawRecord[]>();
  for (const r of rawRecords) {
    const arr = recordsBySession.get(r.session_id) ?? [];
    arr.push(r);
    recordsBySession.set(r.session_id, arr);
  }

  // Build Sessions
  const sessions: SessionData[] = rawSessions.map((rs) => {
    const sDate = rs.session_date.slice(0, 10);
    const weekNumber = weekNumberById.get(rs.week_id) ?? null;
    const state = computeSessionState(rs, rawSessions);
    const notes = notesBySession.get(rs.session_id) ?? [];
    const recs = recordsBySession.get(rs.session_id) ?? [];

    const registeredCount = rawBeneficiaries.filter(
      (b) => b.registered_session_date.slice(0, 10) <= sDate
    ).length;

    let presentCount = 0;
    let measuredCount = 0;
    let sumBmi = 0;
    let countBmi = 0;
    let sumWhtr = 0;
    let countWhtr = 0;
    let nutChecksCount = 0;
    const surveySums = new Map<string, { sum: number; n: number }>();

    const formattedRecords: SessionRecordSummary[] = recs.map((r) => {
      const rb = rawBenByCode.get(r.beneficiary_code);
      const displayName = rb?.name ?? rb?.alias ?? r.beneficiary_code;
      const sex: Sex = rb?.sex ?? 'female';
      const months = rb ? ageInMonths(Number(rb.birth_month), Number(rb.birth_year), sDate) : 0;
      const age = Math.floor(months / 12);
      const isPresent = Boolean(r.is_present);

      const weight = toNum(r.weight_kg);
      const height = toNum(r.height_cm);
      const waist = toNum(r.waist_cm);
      const muac = toNum(r.muac_cm);
      const edema = r.edema === null || r.edema === undefined ? null : Boolean(r.edema);

      const resolved = resolvedBySessionBen.get(`${rs.session_id}__${r.beneficiary_code}`);
      const effHeightCm = resolved?.effective_height_cm ?? null;
      const effHeightDate = resolved?.effective_height_date ?? null;
      const heightCarriedForward = resolved?.height_carried_forward ?? false;
      const heightNotice = resolved?.height_notice ?? false;
      const bmi = resolved?.bmi ?? null;
      const whtr = resolved?.whtr ?? null;

      const sAnswers = surveyBySessionAndBen.get(`${rs.session_id}__${r.beneficiary_code}`) ?? {};

      if (isPresent) {
        presentCount++;
        if (weight != null || height != null || waist != null || muac != null || edema != null) {
          measuredCount++;
        }
        if (bmi != null) {
          sumBmi += bmi;
          countBmi++;
        }
        if (whtr != null) {
          sumWhtr += whtr;
          countWhtr++;
        }
        if (r.nutritionist_id != null) {
          nutChecksCount++;
        }
        for (const [qId, val] of Object.entries(sAnswers)) {
          const entry = surveySums.get(qId) ?? { sum: 0, n: 0 };
          entry.sum += val;
          entry.n++;
          surveySums.set(qId, entry);
        }
      }

      return {
        session_id: rs.session_id,
        beneficiary_code: r.beneficiary_code,
        name: rb?.name ?? null,
        alias: rb?.alias ?? null,
        displayName,
        sex,
        age,
        is_present: isPresent,
        weight_kg: weight,
        height_cm: height,
        effective_height_cm: effHeightCm,
        effective_height_date: effHeightDate,
        height_carried_forward: heightCarriedForward,
        height_notice: heightNotice,
        waist_cm: waist,
        bmi,
        whtr,
        survey_answers: sAnswers,
        nutritionist_id: r.nutritionist_id,
        muac_cm: muac,
        edema,
        clinical_notes: r.clinical_notes ?? null,
        metric_statuses: statusBySessionBen.get(`${rs.session_id}__${r.beneficiary_code}`) ?? {},
      };
    });

    formattedRecords.sort((a, b) => Number(a.beneficiary_code) - Number(b.beneficiary_code));

    const survey_averages: Record<string, { avg: number; n: number }> = {};
    for (const [qId, st] of surveySums.entries()) {
      survey_averages[qId] = {
        avg: Math.round((st.sum / st.n) * 100) / 100,
        n: st.n,
      };
    }

    return {
      session_id: rs.session_id,
      program_id: rs.program_id,
      week_id: rs.week_id,
      week_number: weekNumber,
      session_date: sDate,
      submitted_at: rs.submitted_at,
      record_count: Number(rs.record_count),
      present_count: Number(rs.present_count),
      state,
      notes,
      aggregates: {
        present_count: presentCount,
        registered_count: registeredCount,
        measured_count: measuredCount,
        bmi_mean: countBmi > 0 ? Math.round((sumBmi / countBmi) * 100) / 100 : null,
        bmi_n: countBmi,
        whtr_mean: countWhtr > 0 ? Math.round((sumWhtr / countWhtr) * 1000) / 1000 : null,
        whtr_n: countWhtr,
        survey_averages,
        nutritionist_checks_count: nutChecksCount,
      },
      records: formattedRecords,
    };
  });

  // Build Weeks of the Program
  const prevWeekCategoryAvgs = new Map<string, number>(); // question_id -> avg from prior week
  const allWeeks: ProgramWeekData[] = rawWeeks.map((rw) => {
    const weekSessions = sessions.filter((s) => s.week_id === rw.week_id);
    const submittedWeekSessions = weekSessions.filter((s) => s.submitted_at != null);
    const submittedWeekSessionIds = new Set(submittedWeekSessions.map((s) => s.session_id));
    const newRegistrationsCount = rawBeneficiaries.filter((rb) =>
      submittedWeekSessionIds.has(rb.registered_session_id)
    ).length;
    const weekState = computeWeekState(
      {
        week_start_date: rw.week_start_date,
        week_end_date: rw.week_end_date,
        submitted_session_count: submittedWeekSessions.length,
        session_count: weekSessions.length,
      },
      today
    );

    // Attendance across submitted sessions only, per beneficiary on/after their registration date
    let reachEligible = 0;
    let reachAttended = 0;
    let allDays = 0;
    let twoToThreeDays = 0;
    let oneDay = 0;
    let zeroDays = 0;

    // Measurements across attendees in submitted sessions
    const attendeeCodes = new Set<string>();
    const attendeesWithAnyMeasurement = new Set<string>();
    const attendeesWithWeight = new Set<string>();
    const attendeesWithWaist = new Set<string>();
    const attendeesWithMuac = new Set<string>();
    const attendeesWithEdema = new Set<string>();
    const respondents = new Set<string>();

    for (const rb of rawBeneficiaries) {
      const regDate = rb.registered_session_date.slice(0, 10);
      const eligibleSessions = submittedWeekSessions.filter((s) => s.session_date >= regDate);
      if (eligibleSessions.length === 0) continue;

      reachEligible++;
      const benRecMap = presentRecordsByBenSession.get(rb.beneficiary_code);
      let attendedInWeek = 0;

      for (const s of eligibleSessions) {
        const rec = benRecMap?.get(s.session_id);
        if (rec && Boolean(rec.is_present)) {
          attendedInWeek++;
          attendeeCodes.add(rb.beneficiary_code);

          const w = toNum(rec.weight_kg);
          const h = toNum(rec.height_cm);
          const wst = toNum(rec.waist_cm);
          const mc = toNum(rec.muac_cm);
          const ed = rec.edema === null || rec.edema === undefined ? null : Boolean(rec.edema);

          if (w != null || h != null || wst != null || mc != null || ed != null) {
            attendeesWithAnyMeasurement.add(rb.beneficiary_code);
          }
          if (w != null) attendeesWithWeight.add(rb.beneficiary_code);
          if (wst != null) attendeesWithWaist.add(rb.beneficiary_code);
          if (mc != null) attendeesWithMuac.add(rb.beneficiary_code);
          if (ed != null) attendeesWithEdema.add(rb.beneficiary_code);

          const sa = surveyBySessionAndBen.get(`${s.session_id}__${rb.beneficiary_code}`);
          if (sa && Object.keys(sa).length > 0) {
            respondents.add(rb.beneficiary_code);
          }
        }
      }

      if (attendedInWeek > 0) {
        reachAttended++;
      }

      const weekSubmittedCount = submittedWeekSessions.length;
      if (attendedInWeek === 0) {
        zeroDays++;
      } else if (attendedInWeek >= weekSubmittedCount) {
        allDays++;
      } else if (attendedInWeek === 1) {
        oneDay++;
      } else {
        twoToThreeDays++;
      }
    }

    // Per-day fill rate & measurements (submitted sessions only)
    let fillCheckIns = 0;
    let fillEligibleSlots = 0;
    const perDayAttendance: WeekSessionDayAttendance[] = [];
    const perDayMeasurements: WeekSessionDayMeasurements[] = [];

    for (const s of submittedWeekSessions) {
      const eligibleForSession = rawBeneficiaries.filter(
        (b) => b.registered_session_date.slice(0, 10) <= s.session_date
      ).length;
      const presentInSession = s.aggregates.present_count;
      fillCheckIns += presentInSession;
      fillEligibleSlots += eligibleForSession;

      perDayAttendance.push({
        session_id: s.session_id,
        session_date: s.session_date,
        present_count: presentInSession,
        eligible_count: eligibleForSession,
        pct: eligibleForSession > 0 ? Math.round((presentInSession / eligibleForSession) * 100) : 0,
      });

      let wCnt = 0;
      let wstCnt = 0;
      let mCnt = 0;
      let eCnt = 0;
      let anyMeasuredCnt = 0;
      for (const r of s.records) {
        if (!r.is_present) continue;
        const hasWeight = r.weight_kg != null;
        const hasHeight = r.height_cm != null;
        const hasWaist = r.waist_cm != null;
        const hasMuac = r.muac_cm != null;
        const hasEdema = r.edema != null;
        if (hasWeight) wCnt++;
        if (hasWaist) wstCnt++;
        if (hasMuac) mCnt++;
        if (hasEdema) eCnt++;
        if (hasWeight || hasHeight || hasWaist || hasMuac || hasEdema) {
          anyMeasuredCnt++;
        }
      }
      perDayMeasurements.push({
        session_id: s.session_id,
        session_date: s.session_date,
        present_count: presentInSession,
        measured_count: anyMeasuredCnt,
        weight_count: wCnt,
        waist_count: wstCnt,
        muac_count: mCnt,
        edema_count: eCnt,
        zero_measurements: anyMeasuredCnt === 0,
      });
    }

    let bestDay: WeekSessionDayAttendance | null = null;
    let lowestDay: WeekSessionDayAttendance | null = null;
    if (perDayAttendance.length > 0) {
      bestDay = [...perDayAttendance].sort((a, b) => b.pct - a.pct || b.present_count - a.present_count)[0];
      lowestDay = [...perDayAttendance].sort((a, b) => a.pct - b.pct || a.present_count - b.present_count)[0];
    }

    const uniquePresentCount = attendeeCodes.size;
    const uniqueMeasuredCount = attendeesWithAnyMeasurement.size;

    // Pooled Surveys in week across submitted sessions
    const catStats = new Map<string, { sum: number; n: number }>();
    for (const q of surveyQuestions) {
      catStats.set(q.question_id, { sum: 0, n: 0 });
    }
    for (const s of submittedWeekSessions) {
      for (const r of s.records) {
        if (!r.is_present) continue;
        for (const [qId, val] of Object.entries(r.survey_answers)) {
          const entry = catStats.get(qId) ?? { sum: 0, n: 0 };
          entry.sum += val;
          entry.n++;
          catStats.set(qId, entry);
        }
      }
    }

    const categories: WeekSurveyCategorySummary[] = Array.from(catStats.entries()).map(([qId, st]) => {
      const avg = st.n > 0 ? Math.round((st.sum / st.n) * 100) / 100 : null;
      const prevAvg = prevWeekCategoryAvgs.get(qId) ?? null;
      const delta = avg != null && prevAvg != null ? Math.round((avg - prevAvg) * 100) / 100 : null;
      if (avg != null) {
        prevWeekCategoryAvgs.set(qId, avg);
      }
      return {
        question_id: qId,
        label: formatSurveyCategoryLabel(qId),
        avg,
        n: st.n,
        prev_avg: prevAvg,
        delta,
      };
    });

    const answeredCategories = categories.filter((c) => c.avg != null);
    const lowestCategory =
      answeredCategories.length > 0
        ? [...answeredCategories].sort((a, b) => (a.avg! - b.avg!) || (b.n - a.n))[0]
        : null;

    return {
      week_id: rw.week_id,
      program_id: rw.program_id,
      week_number: Number(rw.week_number),
      week_start_date: rw.week_start_date,
      week_end_date: rw.week_end_date,
      state: weekState,
      sessions: weekSessions,
      submitted_session_count: submittedWeekSessions.length,
      has_submitted_data: submittedWeekSessions.length > 0,
      attendance: {
        reach_attended: reachAttended,
        reach_eligible: reachEligible,
        reach_pct: reachEligible > 0 ? Math.round((reachAttended / reachEligible) * 100) : 0,
        new_registrations_count: newRegistrationsCount,
        consistency: {
          all_days: allDays,
          two_to_three_days: twoToThreeDays,
          one_day: oneDay,
          zero_days: zeroDays,
        },
        fill_check_ins: fillCheckIns,
        fill_eligible_slots: fillEligibleSlots,
        fill_pct: fillEligibleSlots > 0 ? Math.round((fillCheckIns / fillEligibleSlots) * 100) : 0,
        best_day: bestDay,
        lowest_day: lowestDay,
        per_day: perDayAttendance,
      },
      measurements: {
        unique_measured_count: uniqueMeasuredCount,
        unique_present_count: uniquePresentCount,
        coverage_pct: uniquePresentCount > 0 ? Math.round((uniqueMeasuredCount / uniquePresentCount) * 100) : 0,
        missing_weight_count: Math.max(0, uniquePresentCount - attendeesWithWeight.size),
        missing_waist_count: Math.max(0, uniquePresentCount - attendeesWithWaist.size),
        missing_muac_count: hasNutritionist ? Math.max(0, uniquePresentCount - attendeesWithMuac.size) : 0,
        missing_edema_count: hasNutritionist ? Math.max(0, uniquePresentCount - attendeesWithEdema.size) : 0,
        zero_measurement_sessions_count: perDayMeasurements.filter((d) => d.zero_measurements).length,
        per_day: perDayMeasurements,
      },
      surveys: {
        respondent_count: respondents.size,
        attendee_count: uniquePresentCount,
        response_rate_pct: uniquePresentCount > 0 ? Math.round((respondents.size / uniquePresentCount) * 100) : 0,
        categories,
        lowest_category: lowestCategory,
      },
    };
  });

  // Trim trailing 0-session weeks past the final scheduled session (keeping any middle 0-session weeks)
  let lastScheduledWeekIdx = -1;
  for (let i = allWeeks.length - 1; i >= 0; i--) {
    if (allWeeks[i].sessions.length > 0) {
      lastScheduledWeekIdx = i;
      break;
    }
  }
  const weeks: ProgramWeekData[] =
    lastScheduledWeekIdx >= 0 ? allWeeks.slice(0, lastScheduledWeekIdx + 1) : allWeeks;
  program.week_total = weeks.length;

  const resolveSessionMetricMeasurement = (
    metric: MetricKey,
    beneficiaryCode: string,
    sessionId: string,
    sessionDate: string
  ): { numeric: number | null; display: string } => {
    const rb = rawBenByCode.get(beneficiaryCode);
    const benRecMap = presentRecordsByBenSession.get(beneficiaryCode);
    const rawRec = benRecMap?.get(sessionId);
    const resolved = resolvedBySessionBen.get(`${sessionId}__${beneficiaryCode}`);

    if (metric === 'bmi') {
      const bmi = resolved?.bmi ?? null;
      if (bmi != null && rb) {
        const months = ageInMonths(Number(rb.birth_month), Number(rb.birth_year), sessionDate);
        if (months < 216) {
          const z = approxBmiForAgeZ(bmi, months, rb.sex);
          return {
            numeric: bmi,
            display: z != null ? `${bmi.toFixed(1)} (z ${z >= 0 ? '+' : ''}${z.toFixed(2)})` : `${bmi.toFixed(1)}`,
          };
        }
        return { numeric: bmi, display: `${bmi.toFixed(1)} kg/m²` };
      }
      return { numeric: null, display: '—' };
    }

    if (metric === 'whtr') {
      const whtr = resolved?.whtr ?? null;
      return whtr != null ? { numeric: whtr, display: whtr.toFixed(2) } : { numeric: null, display: '—' };
    }

    if (metric === 'muac') {
      const muac = toNum(rawRec?.muac_cm);
      return muac != null ? { numeric: muac, display: `${muac.toFixed(1)} cm` } : { numeric: null, display: '—' };
    }

    if (rawRec?.edema !== null && rawRec?.edema !== undefined) {
      return { numeric: null, display: Boolean(rawRec.edema) ? 'Present' : 'Absent' };
    }
    return { numeric: null, display: '—' };
  };

  // Ordered list of submitted sessions (chronological by session_date)
  const submittedSessions = sessions.filter((s) => s.submitted_at != null);
  const submittedSessionsList: SubmittedSessionInfo[] = submittedSessions.map((s, idx) => ({
    session_id: s.session_id,
    session_number: idx + 1,
    session_date: s.session_date,
  }));
  const submittedSessionNumById = new Map<string, number>();
  for (const ss of submittedSessionsList) {
    submittedSessionNumById.set(ss.session_id, ss.session_number);
  }

  // Build latest status map per beneficiary from `v_latest_metric_status` view rows
  const benLatestMetricMap = new Map<string, Partial<Record<MetricKey, BeneficiaryLatestMetricStatus>>>();

  for (const row of rawLatestViewRows) {
    const sDate = row.session_date.slice(0, 10);
    const daysOld = getMetricDaysOld(sDate, today);
    const outdated = isMetricOutdated(sDate, today);
    const measuredVal = resolveSessionMetricMeasurement(
      row.metric,
      row.beneficiary_code,
      row.session_id,
      sDate
    );

    const entry = benLatestMetricMap.get(row.beneficiary_code) ?? {};
    entry[row.metric] = {
      metric: row.metric,
      session_id: row.session_id,
      session_date: sDate,
      status_key: row.status_key,
      change_value: toNum(row.change_value),
      days_old: daysOld,
      is_outdated: outdated,
      latest_value_display: measuredVal.display,
    };
    benLatestMetricMap.set(row.beneficiary_code, entry);
  }

  // Build Beneficiaries list
  const beneficiaries: BeneficiaryData[] = rawBeneficiaries.map((rb) => {
    const regDate = rb.registered_session_date.slice(0, 10);
    const displayName = rb.name ?? rb.alias ?? rb.beneficiary_code;
    const months = ageInMonths(Number(rb.birth_month), Number(rb.birth_year), today);
    const age = Math.floor(months / 12);
    const adult = isAdultAt(Number(rb.birth_month), Number(rb.birth_year), today);

    const measurements = measurementsByBen.get(rb.beneficiary_code) ?? [];
    const presentSubmittedMeasurements = measurements.filter(
      (m) => m.submitted_at != null && m.is_present
    );

    // Effective latest height across beneficiary's sessions (or initial height)
    const explicitHeights = explicitHeightsByBen.get(rb.beneficiary_code) ?? [];
    const latestExplicitHeight =
      explicitHeights.length > 0 ? explicitHeights[explicitHeights.length - 1] : null;
    const initialHeight = Number(rb.initial_height_cm);
    const effectiveHeightCm = latestExplicitHeight?.height_cm ?? initialHeight;
    const effectiveHeightDate = latestExplicitHeight?.session_date ?? regDate;
    const heightNotice = shouldShowHeightNotice({
      birthMonth: Number(rb.birth_month),
      birthYear: Number(rb.birth_year),
      effectiveHeightDate,
      asOfDate: today,
    });

    // Latest statuses per metric from v_latest_* views
    const latestStatuses = benLatestMetricMap.get(rb.beneficiary_code) ?? {};
    const metricStatusesCompat: Partial<Record<MetricKey, { status_key: StatusKey } | null>> = {};
    let newestStatusDate: string | null = null;
    for (const m of ALL_METRICS) {
      const st = latestStatuses[m];
      if (st) {
        metricStatusesCompat[m] = { status_key: st.status_key };
        if (!newestStatusDate || st.session_date > newestStatusDate) {
          newestStatusDate = st.session_date;
        }
      }
    }

    // Last measured X sessions ago (submitted sessions only, never calendar days or drafts)
    const eligibleSubmitted = submittedSessions.filter((s) => s.session_date >= regDate);
    let lastMeasuredSessionsAgo: number | null = null;
    if (eligibleSubmitted.length > 0) {
      if (newestStatusDate) {
        lastMeasuredSessionsAgo = eligibleSubmitted.filter(
          (s) => s.session_date > newestStatusDate!
        ).length;
      } else {
        lastMeasuredSessionsAgo = eligibleSubmitted.length;
      }
    }
    const needsMeasurementWarning =
      lastMeasuredSessionsAgo !== null &&
      lastMeasuredSessionsAgo >= NEEDS_MEASUREMENT_MIN_SESSIONS_AGO;

    // 1st-to-latest raw field deltas for Cohort Summary ("Summarize" button)
    const deltaMeasurements = presentSubmittedMeasurements.map((m) => ({
      session_date: m.session_date,
      is_present: m.is_present,
      weight_kg: m.weight_kg,
      waist_cm: m.waist_cm,
      muac_cm: m.muac_cm,
    }));
    const weightRes = computeFirstToLatestDelta(deltaMeasurements, 'weight_kg');
    const waistRes = computeFirstToLatestDelta(deltaMeasurements, 'waist_cm');
    const muacRes = computeFirstToLatestDelta(deltaMeasurements, 'muac_cm');

    const weightChange = weightRes?.delta ?? null;
    const weightChangePct = weightRes?.pctChange ?? null;
    const waistChange = waistRes?.delta ?? null;
    const muacChange = muacRes?.delta ?? null;

    // Attendance %
    const recMap = presentRecordsByBenSession.get(rb.beneficiary_code);
    const attendedCount = eligibleSubmitted.filter((s) => {
      const rec = recMap?.get(s.session_id);
      return rec && Boolean(rec.is_present);
    }).length;
    const eligibleCount = eligibleSubmitted.length;
    const attendancePct = eligibleCount > 0 ? Math.round((attendedCount / eligibleCount) * 100) : 0;

    return {
      program_id: rb.program_id,
      beneficiary_code: rb.beneficiary_code,
      name: rb.name,
      alias: rb.alias,
      displayName,
      birth_month: Number(rb.birth_month),
      birth_year: Number(rb.birth_year),
      sex: rb.sex,
      age,
      isAdult: adult,
      initial_weight_kg: Number(rb.initial_weight_kg),
      initial_height_cm: Number(rb.initial_height_cm),
      effective_height_cm: effectiveHeightCm,
      effective_height_date: effectiveHeightDate,
      height_notice: heightNotice,
      registered_session_id: rb.registered_session_id,
      registered_session_date: regDate,
      latest_statuses: latestStatuses,
      metric_history: {
        bmi: historyByBenMetric.get(`${rb.beneficiary_code}__bmi`) ?? [],
        whtr: historyByBenMetric.get(`${rb.beneficiary_code}__whtr`) ?? [],
        muac: historyByBenMetric.get(`${rb.beneficiary_code}__muac`) ?? [],
        edema: historyByBenMetric.get(`${rb.beneficiary_code}__edema`) ?? [],
      },
      metric_statuses: metricStatusesCompat,
      weight_change: weightChange,
      weight_change_pct: weightChangePct,
      waist_change: waistChange,
      muac_change: muacChange,
      last_measured_date: newestStatusDate,
      last_measured_sessions_ago: lastMeasuredSessionsAgo,
      needs_measurement_warning: needsMeasurementWarning,
      attendance_pct: attendancePct,
      attended_count: attendedCount,
      eligible_sessions_count: eligibleCount,
      allergies: allergiesByBen.get(rb.beneficiary_code) ?? [],
      guardians: guardiansByBen.get(rb.beneficiary_code) ?? [],
      explicit_heights: explicitHeights,
      measurements,
    };
  });

  // Aggregate Program Nutritional Status summaries directly from v_latest_* rows
  const enrolledCount = beneficiaries.length;
  const emptyMetricSummary = (metric: MetricKey): NutritionalMetricSummaryRow => ({
    metric,
    label: metric === 'bmi' ? 'BMI' : metric === 'whtr' ? 'WHtR' : metric === 'muac' ? 'MUAC' : 'Edema',
    baseline_count: 0,
    monitor_count: 0,
    monitor_closely_count: 0,
    outdated_count: 0,
    no_status_count: enrolledCount,
    measured_count: 0,
    outdated_breakdown: { baseline: 0, monitor: 0, monitor_closely: 0 },
  });

  const metricSummaries: Record<MetricKey, NutritionalMetricSummaryRow> = {
    bmi: emptyMetricSummary('bmi'),
    whtr: emptyMetricSummary('whtr'),
    muac: emptyMetricSummary('muac'),
    edema: emptyMetricSummary('edema'),
  };

  const monitorRows: Record<MetricKey, NutritionalStatusModalRow[]> = {
    bmi: [],
    whtr: [],
    muac: [],
    edema: [],
  };
  const monitorCloselyRows: Record<MetricKey, NutritionalStatusModalRow[]> = {
    bmi: [],
    whtr: [],
    muac: [],
    edema: [],
  };
  const outdatedRows: OutdatedModalRow[] = [];

  for (const b of beneficiaries) {
    for (const metric of availableMetrics) {
      const st = b.latest_statuses[metric];
      if (!st) continue;

      const summary = metricSummaries[metric];
      summary.measured_count++;
      summary.no_status_count = Math.max(0, enrolledCount - summary.measured_count);

      if (st.status_key === 'baseline') summary.baseline_count++;
      else if (st.status_key === 'monitor') summary.monitor_count++;
      else if (st.status_key === 'monitor_closely') summary.monitor_closely_count++;

      if (st.is_outdated) {
        summary.outdated_count++;
        summary.outdated_breakdown[st.status_key]++;
      }

      const modalRow: NutritionalStatusModalRow = {
        beneficiary_code: b.beneficiary_code,
        display_name: b.displayName,
        metric,
        status_key: st.status_key,
        session_id: st.session_id,
        session_date: st.session_date,
        days_old: st.days_old,
        is_outdated: st.is_outdated,
        latest_value_display: st.latest_value_display,
        change_value: st.change_value,
      };

      if (st.status_key === 'monitor') {
        monitorRows[metric].push(modalRow);
      } else if (st.status_key === 'monitor_closely') {
        monitorCloselyRows[metric].push(modalRow);
      }
      if (st.is_outdated) {
        outdatedRows.push(modalRow);
      }
    }
  }

  for (const metric of availableMetrics) {
    monitorRows[metric].sort((a, b) => a.session_date.localeCompare(b.session_date));
    monitorCloselyRows[metric].sort((a, b) => a.session_date.localeCompare(b.session_date));
  }
  outdatedRows.sort((a, b) => b.days_old - a.days_old || a.display_name.localeCompare(b.display_name));

  // Build First-vs-Latest Session Cohort tracking per available metric (submitted sessions only)
  const cohortTracking: Partial<Record<MetricKey, MetricCohortSummary>> = {};
  for (const metric of availableMetrics) {
    const cohortRows: BeneficiaryCohortRow[] = [];
    let singleMeasurementCount = 0;
    let improvedCount = 0;
    let unchangedCount = 0;
    let declinedCount = 0;

    for (const b of beneficiaries) {
      const history = b.metric_history[metric] ?? [];
      if (history.length === 0) continue;

      // history is ordered chronologically by session_date ASC (submitted sessions only)
      const firstPoint = history[0];
      const latestViewRow = b.latest_statuses[metric];
      const latestPoint = history[history.length - 1];

      const firstSessionId = firstPoint.session_id;
      const firstSessionDate = firstPoint.session_date;
      const firstStatus = firstPoint.status_key;

      const latestSessionId = latestViewRow?.session_id ?? latestPoint.session_id;
      const latestSessionDate = latestViewRow?.session_date ?? latestPoint.session_date;
      const latestStatus = latestViewRow?.status_key ?? latestPoint.status_key;

      const measurementCount = history.length;

      // Count session_record rows where is_present = TRUE in submitted sessions on or after first_session_id date
      const benRecMap = presentRecordsByBenSession.get(b.beneficiary_code);
      let sessionsAttended = 0;
      for (const ss of submittedSessionsList) {
        if (ss.session_date >= firstSessionDate) {
          const rec = benRecMap?.get(ss.session_id);
          if (rec && Boolean(rec.is_present)) {
            sessionsAttended++;
          }
        }
      }

      const firstMeasured = resolveSessionMetricMeasurement(
        metric,
        b.beneficiary_code,
        firstSessionId,
        firstSessionDate
      );
      const latestMeasured = resolveSessionMetricMeasurement(
        metric,
        b.beneficiary_code,
        latestSessionId,
        latestSessionDate
      );

      let netChange: number | null = null;
      if (
        metric !== 'edema' &&
        measurementCount >= 2 &&
        firstMeasured.numeric !== null &&
        latestMeasured.numeric !== null
      ) {
        const dp = metric === 'bmi' ? 2 : metric === 'whtr' ? 3 : 1;
        netChange = round(latestMeasured.numeric - firstMeasured.numeric, dp);
      }

      const transitionTag = classifyCohortTransitionTag(
        firstStatus,
        latestStatus,
        measurementCount
      );
      if (transitionTag === 'single_measurement') singleMeasurementCount++;
      else if (transitionTag === 'improved') improvedCount++;
      else if (transitionTag === 'unchanged') unchangedCount++;
      else declinedCount++;

      cohortRows.push({
        beneficiary_code: b.beneficiary_code,
        display_name: b.displayName,
        metric,
        first_session_id: firstSessionId,
        first_session_number: submittedSessionNumById.get(firstSessionId) ?? 0,
        first_session_date: firstSessionDate,
        first_status: firstStatus,
        first_value: firstMeasured.numeric,
        first_value_display: firstMeasured.display,
        latest_session_id: latestSessionId,
        latest_session_number: submittedSessionNumById.get(latestSessionId) ?? 0,
        latest_session_date: latestSessionDate,
        latest_status: latestStatus,
        latest_value: latestMeasured.numeric,
        latest_value_display: latestMeasured.display,
        measurement_count: measurementCount,
        sessions_attended: sessionsAttended,
        net_change: netChange,
        transition_tag: transitionTag,
      });
    }

    const tagOrder: Record<CohortTransitionTag, number> = {
      declined: 0,
      improved: 1,
      single_measurement: 2,
      unchanged: 3,
    };
    cohortRows.sort((a, b) => {
      const td = tagOrder[a.transition_tag] - tagOrder[b.transition_tag];
      if (td !== 0) return td;
      return a.display_name.localeCompare(b.display_name);
    });

    cohortTracking[metric] = {
      metric,
      label: metric === 'bmi' ? 'BMI' : metric === 'whtr' ? 'WHtR' : metric === 'muac' ? 'MUAC' : 'Edema',
      total_measured: cohortRows.length,
      no_status_count: Math.max(0, enrolledCount - cohortRows.length),
      single_measurement_count: singleMeasurementCount,
      improved_count: improvedCount,
      unchanged_count: unchangedCount,
      declined_count: declinedCount,
      rows: cohortRows,
    };
  }

  return {
    program,
    sessions,
    weeks,
    nutritionalStatus: {
      has_nutritionist: hasNutritionist,
      available_metrics: availableMetrics,
      enrolled_count: enrolledCount,
      submitted_sessions: submittedSessionsList,
      cohort_tracking: cohortTracking,
      metrics: metricSummaries,
      monitor_rows: monitorRows,
      monitor_closely_rows: monitorCloselyRows,
      outdated_rows: outdatedRows,
    },
    beneficiaries,
    availableAllergies,
    assignedNutritionists,
    surveyQuestions,
    today,
  };
}
