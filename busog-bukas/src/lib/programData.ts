import { query } from './db';
import { getMockToday } from './mockToday';
import {
  verifyTimelinesWithDb,
  computeSessionState,
  computeTimelineState,
  isSessionOwnedByTimeline,
  checkBoundarySession,
  type SessionState,
  type TimelineState,
  type BoundaryInfo,
  type TimelineDbRow,
} from './timelineRules';
import {
  ageInMonths,
  isAdultAt,
  computeBmi,
  computeWhtr,
  computeTimelineChanges,
  REASON_DESCRIPTION,
  type StatusKey,
  type ReasonKey,
} from './statusRule';
import { daysBetween } from './format';
import { computeFirstToLatestDelta } from './beneficiarySummary';

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
  timeline_total: number;
  nutritionist_count: number;
};

export type SessionNoteRow = {
  note_id: string;
  session_id: string;
  category: string;
  note: string;
};

export type SessionRecordSummary = {
  session_id: string;
  beneficiary_code: string;
  name: string | null;
  alias: string | null;
  displayName: string;
  sex: 'female' | 'male';
  age: number;
  is_present: boolean;
  weight_kg: number | null;
  height_cm: number | null;
  waist_cm: number | null;
  bmi: number | null;
  whtr: number | null;
  survey_answers: Record<string, number>;
  nutritionist_id: string | null;
  muac_cm: number | null;
  edema: boolean | null;
  clinical_notes: string | null;
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
  ai_comments?: string | null;
  ai_category?: string | null;
};

export type SessionData = {
  session_id: string;
  program_id: string;
  session_date: string;
  submitted_at: string | null;
  record_count: number;
  present_count: number;
  state: SessionState;
  boundary: BoundaryInfo;
  owning_seq: number | null;
  notes: Array<{ note_id: string; category: string; note: string }>;
  aggregates: SessionAggregates;
  records: SessionRecordSummary[];
};

export type TimelineBeneficiaryStatusRow = {
  beneficiary_code: string;
  status_key: StatusKey;
  status_reason: ReasonKey;
};

export type TimelineData = {
  timeline_id: string;
  seq: number;
  start_session_id: string;
  end_session_id: string;
  start_date: string;
  end_date: string;
  closed_at: string | null;
  state: TimelineState;
  member_sessions: SessionData[];
  registered_count: number;
  measured_count: number;
  coverage_pct: number;
  status_counts?: Record<StatusKey, number>;
  beneficiary_statuses?: TimelineBeneficiaryStatusRow[];
  ai_interpretation?: { category: string; comments: string; created_at: string } | null;
};

export type BeneficiaryMeasurement = {
  session_id: string;
  session_date: string;
  submitted_at: string | null;
  is_present: boolean;
  weight_kg: number | null;
  height_cm: number | null;
  waist_cm: number | null;
  bmi: number | null;
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
  sex: 'female' | 'male';
  age: number;
  isAdult: boolean;
  registered_session_id: string;
  registered_session_date: string;
  latest_status: StatusKey | null;
  latest_status_reason_key: ReasonKey | null;
  latest_status_reason: string | null;
  latest_status_timeline_seq: number | null;
  bmi_optimality: number | null;
  whtr_optimality: number | null;
  weight_change: number | null;
  weight_change_pct: number | null;
  waist_change: number | null;
  muac_change: number | null;
  last_measured_date: string | null;
  attendance_pct: number;
  attended_count: number;
  eligible_sessions_count: number;
  needs_measurement_warning: boolean;
  allergies: string[];
  guardians: Array<{ name: string; number: string; relationship: string }>;
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
  timelines: TimelineData[];
  beneficiaries: BeneficiaryData[];
  availableAllergies: AvailableAllergy[];
  assignedNutritionists: AssignedNutritionist[];
  surveyQuestions: SurveyQuestion[];
  today: string;
  openTimelineWarning: {
    active: boolean;
    seq: number;
    endDate: string;
    daysLeft: number;
    unmeasuredCount: number;
  } | null;
};

export async function getProgramPageData(programId: string): Promise<ProgramPageData | null> {
  const today = getMockToday();

  // 1. Program details
  const [program] = await query<ProgramDetail>(
    `SELECT p.program_id, p.org_id, p.title, p.location, p.description, p.start_date, p.end_date, p.max_beneficiaries,
            (SELECT COUNT(*) FROM beneficiary b WHERE b.program_id = p.program_id) AS enrolled,
            (SELECT COUNT(*) FROM program_session s WHERE s.program_id = p.program_id) AS session_total,
            (SELECT COUNT(*) FROM timeline t WHERE t.program_id = p.program_id) AS timeline_total,
            (SELECT COUNT(*) FROM program_nutritionist pn WHERE pn.program_id = p.program_id) AS nutritionist_count
       FROM program p
      WHERE p.program_id = ?
      LIMIT 1`,
    [programId]
  );

  if (!program) return null;

  // 2. Program sessions
  type RawSession = {
    session_id: string;
    program_id: string;
    session_date: string;
    submitted_at: string | null;
    record_count: number;
    present_count: number;
  };

  const rawSessions = await query<RawSession>(
    `SELECT s.session_id, s.program_id, s.session_date, s.submitted_at,
            (SELECT COUNT(*) FROM session_record sr WHERE sr.session_id = s.session_id) AS record_count,
            (SELECT COUNT(*) FROM session_record sr WHERE sr.session_id = s.session_id AND sr.is_present = TRUE) AS present_count
       FROM program_session s
      WHERE s.program_id = ?
      ORDER BY s.session_date ASC`,
    [programId]
  );

  // 3. Session notes
  const notes = await query<SessionNoteRow>(
    `SELECT sn.note_id, sn.session_id, sn.category, sn.note
       FROM session_note sn
       JOIN program_session s ON s.session_id = sn.session_id
      WHERE s.program_id = ?
      ORDER BY s.session_date ASC`,
    [programId]
  );

  const notesBySession = new Map<string, Array<{ note_id: string; category: string; note: string }>>();
  for (const n of notes) {
    const list = notesBySession.get(n.session_id) ?? [];
    list.push({ note_id: n.note_id, category: n.category, note: n.note });
    notesBySession.set(n.session_id, list);
  }

  // 4. Timelines from DB
  const rawTimelines = await query<TimelineDbRow>(
    `SELECT t.timeline_id, t.program_id, t.seq, t.start_session_id, t.end_session_id, t.closed_at,
            s_start.session_date AS start_date,
            s_end.session_date AS end_date
       FROM timeline t
       JOIN program_session s_start ON s_start.session_id = t.start_session_id
       JOIN program_session s_end ON s_end.session_id = t.end_session_id
      WHERE t.program_id = ?
      ORDER BY t.seq ASC`,
    [programId]
  );

  // 14-day rule self-check: recomputes timelines and logs any mismatch
  verifyTimelinesWithDb(programId, rawSessions, rawTimelines);

  const timelinesMeta = rawTimelines.map((tl) => ({
    seq: tl.seq,
    closed_at: tl.closed_at,
    start_date: tl.start_date ?? '',
  }));

  // 5. Metadata: Survey Questions, Allergies, Assigned Nutritionists
  const surveyQuestions = await query<SurveyQuestion>(
    'SELECT question_id, prompt_minor, prompt_adult FROM survey_question ORDER BY question_id ASC'
  );

  const availableAllergies = await query<AvailableAllergy>(
    'SELECT allergy_id, name FROM allergy ORDER BY name ASC'
  );

  const assignedNutritionists = await query<AssignedNutritionist>(
    `SELECT n.nutritionist_id, n.name, n.credentials
       FROM program_nutritionist pn
       JOIN nutritionist n ON n.nutritionist_id = pn.nutritionist_id
      WHERE pn.program_id = ?
      ORDER BY n.name ASC`,
    [programId]
  );

  // 6. Survey answers for this program
  type RawSurveyAnswer = {
    session_id: string;
    beneficiary_code: string;
    question_id: string;
    value: number;
  };

  const surveyAnswers = await query<RawSurveyAnswer>(
    `SELECT session_id, beneficiary_code, question_id, value
       FROM survey_answer
      WHERE program_id = ?`,
    [programId]
  );

  const surveyMap = new Map<string, Record<string, number>>();
  for (const sa of surveyAnswers) {
    const key = `${sa.session_id}_${sa.beneficiary_code}`;
    const obj = surveyMap.get(key) ?? {};
    obj[sa.question_id] = Number(sa.value);
    surveyMap.set(key, obj);
  }

  // 7. Session-scoped AI Interpretations
  type RawSessionAi = {
    interpretation_id: string;
    session_id: string;
    category: string;
    comments: string;
    created_at: string;
  };

  const sessionAiRows = await query<RawSessionAi>(
    `SELECT interpretation_id, session_id, category, comments, created_at
       FROM ai_interpretation
      WHERE scope = 'session'
        AND session_id IN (SELECT session_id FROM program_session WHERE program_id = ?)
      ORDER BY created_at DESC`,
    [programId]
  );

  const sessionAiMap = new Map<string, RawSessionAi>();
  for (const row of sessionAiRows) {
    if (!sessionAiMap.has(row.session_id)) {
      sessionAiMap.set(row.session_id, row);
    }
  }

  // 8. Timeline-scoped AI Interpretations
  type RawTimelineAi = {
    interpretation_id: string;
    timeline_id: string;
    category: string;
    comments: string;
    created_at: string;
  };

  const timelineAiRows = await query<RawTimelineAi>(
    `SELECT interpretation_id, timeline_id, category, comments, created_at
       FROM ai_interpretation
      WHERE scope = 'timeline'
        AND timeline_id IN (SELECT timeline_id FROM timeline WHERE program_id = ?)
      ORDER BY created_at DESC`,
    [programId]
  );

  const aiByTimeline = new Map<string, { category: string; comments: string; created_at: string }>();
  for (const row of timelineAiRows) {
    if (row.timeline_id && !aiByTimeline.has(row.timeline_id)) {
      aiByTimeline.set(row.timeline_id, {
        category: row.category,
        comments: row.comments,
        created_at: row.created_at,
      });
    }
  }

  // 9. Status counts per timeline
  type RawStatusCount = {
    timeline_id: string;
    status_key: string;
    count: number;
  };

  const rawStatusCounts = await query<RawStatusCount>(
    `SELECT bts.timeline_id, bts.status_key, COUNT(*) AS count
       FROM beneficiary_timeline_status bts
      WHERE bts.program_id = ?
      GROUP BY bts.timeline_id, bts.status_key`,
    [programId]
  );

  // 10. Beneficiaries basic data
  type RawBeneficiary = {
    program_id: string;
    beneficiary_code: string;
    name: string | null;
    birth_month: number;
    birth_year: number;
    sex: 'female' | 'male';
    registered_session_id: string;
    registered_session_date: string;
    alias: string | null;
  };

  const rawBeneficiaries = await query<RawBeneficiary>(
    `SELECT b.program_id, b.beneficiary_code, b.name, b.birth_month, b.birth_year, b.sex, b.registered_session_id,
            s.session_date AS registered_session_date,
            ba.alias
       FROM beneficiary b
       JOIN program_session s ON s.session_id = b.registered_session_id
       LEFT JOIN beneficiary_alias ba ON ba.program_id = b.program_id AND ba.beneficiary_code = b.beneficiary_code
      WHERE b.program_id = ?
      ORDER BY b.beneficiary_code ASC`,
    [programId]
  );

  // Beneficiary quick lookup map
  const benInfoMap = new Map<string, { name: string | null; alias: string | null; displayName: string; sex: 'female' | 'male'; age: number; isAdult: boolean; regDate: string }>();
  for (const b of rawBeneficiaries) {
    const ageMonthsVal = ageInMonths(b.birth_month, b.birth_year, today);
    const ageVal = Math.floor(ageMonthsVal / 12);
    const isAdultVal = isAdultAt(b.birth_month, b.birth_year, today);
    const displayName = b.name ? b.name : b.alias ? b.alias : '—';
    benInfoMap.set(b.beneficiary_code, {
      name: b.name,
      alias: b.alias,
      displayName,
      sex: b.sex,
      age: ageVal,
      isAdult: isAdultVal,
      regDate: b.registered_session_date.slice(0, 10),
    });
  }

  // 11. Allergies
  type RawAllergy = {
    beneficiary_code: string;
    allergy_name: string;
  };

  const rawAllergies = await query<RawAllergy>(
    `SELECT ba.beneficiary_code, a.name AS allergy_name
       FROM beneficiary_allergy ba
       JOIN allergy a ON a.allergy_id = ba.allergy_id
      WHERE ba.program_id = ?
      ORDER BY a.name ASC`,
    [programId]
  );

  const allergiesByBeneficiary = new Map<string, string[]>();
  for (const a of rawAllergies) {
    const list = allergiesByBeneficiary.get(a.beneficiary_code) ?? [];
    list.push(a.allergy_name);
    allergiesByBeneficiary.set(a.beneficiary_code, list);
  }

  // 12. Guardians & Consents
  type RawConsent = {
    beneficiary_code: string;
    relationship: string;
    guardian_name: string;
    guardian_number: string;
  };

  const rawConsents = await query<RawConsent>(
    `SELECT c.beneficiary_code, c.relationship, g.name AS guardian_name, g.number AS guardian_number
       FROM consent c
       JOIN guardian g ON g.guardian_id = c.guardian_id
      WHERE c.program_id = ?`,
    [programId]
  );

  const guardiansByBeneficiary = new Map<string, Array<{ name: string; number: string; relationship: string }>>();
  for (const c of rawConsents) {
    const list = guardiansByBeneficiary.get(c.beneficiary_code) ?? [];
    list.push({ name: c.guardian_name, number: c.guardian_number, relationship: c.relationship });
    guardiansByBeneficiary.set(c.beneficiary_code, list);
  }

  // 13. Timeline Statuses for beneficiaries
  type RawTimelineStatus = {
    beneficiary_code: string;
    timeline_id: string;
    status_key: StatusKey;
    status_reason: ReasonKey;
    status_reason_description: string | null;
    bmi_change: number | null;
    whtr_change: number | null;
    muac_change: number | null;
    timeline_seq: number;
  };

  const rawTimelineStatuses = await query<RawTimelineStatus>(
    `SELECT bts.beneficiary_code, bts.timeline_id, bts.status_key, bts.status_reason,
            srd.description AS status_reason_description,
            bts.bmi_change, bts.whtr_change, bts.muac_change,
            t.seq AS timeline_seq
       FROM beneficiary_timeline_status bts
       JOIN timeline t ON t.timeline_id = bts.timeline_id
       LEFT JOIN status_reason_definition srd ON srd.reason_key = bts.status_reason
      WHERE bts.program_id = ?
      ORDER BY t.seq DESC`,
    [programId]
  );

  const latestStatusByBeneficiary = new Map<string, RawTimelineStatus>();
  for (const s of rawTimelineStatuses) {
    if (!latestStatusByBeneficiary.has(s.beneficiary_code)) {
      latestStatusByBeneficiary.set(s.beneficiary_code, s);
    }
  }

  // 14. Session records and measurements
  type RawSessionRecord = {
    session_id: string;
    beneficiary_code: string;
    is_present: number | boolean;
    weight_kg: number | null;
    height_cm: number | null;
    waist_cm: number | null;
    session_date: string;
    submitted_at: string | null;
    nutritionist_id: string | null;
    muac_cm: number | null;
    edema: number | boolean | null;
    clinical_notes: string | null;
  };

  const rawRecords = await query<RawSessionRecord>(
    `SELECT sr.session_id, sr.beneficiary_code, sr.is_present, sr.weight_kg, sr.height_cm, sr.waist_cm,
            ps.session_date, ps.submitted_at,
            nr.nutritionist_id, nr.muac_cm, nr.edema, nr.clinical_notes
       FROM session_record sr
       JOIN program_session ps ON ps.session_id = sr.session_id
       LEFT JOIN nutritionist_record nr ON nr.session_id = sr.session_id AND nr.beneficiary_code = sr.beneficiary_code
      WHERE sr.program_id = ?
      ORDER BY ps.session_date ASC`,
    [programId]
  );

  // Group records by beneficiary for timeline calculations
  const recordsByBeneficiary = new Map<string, BeneficiaryMeasurement[]>();
  // Group records by session for LargeSessionCard
  const recordsBySession = new Map<string, SessionRecordSummary[]>();

  for (const r of rawRecords) {
    const wKg = r.weight_kg != null ? Number(r.weight_kg) : null;
    const hCm = r.height_cm != null ? Number(r.height_cm) : null;
    const wstCm = r.waist_cm != null ? Number(r.waist_cm) : null;
    const computedBmiVal = computeBmi(wKg, hCm);
    const computedWhtrVal = computeWhtr(wstCm, hCm);
    const isPres = Boolean(r.is_present);
    const surveyAns = surveyMap.get(`${r.session_id}_${r.beneficiary_code}`) ?? {};

    // For beneficiary measurement history
    const benList = recordsByBeneficiary.get(r.beneficiary_code) ?? [];
    benList.push({
      session_id: r.session_id,
      session_date: r.session_date.slice(0, 10),
      submitted_at: r.submitted_at,
      is_present: isPres,
      weight_kg: wKg,
      height_cm: hCm,
      waist_cm: wstCm,
      bmi: computedBmiVal,
      muac_cm: r.muac_cm != null ? Number(r.muac_cm) : null,
      edema: r.edema != null ? Boolean(r.edema) : null,
      clinical_notes: r.clinical_notes,
    });
    recordsByBeneficiary.set(r.beneficiary_code, benList);

    // For session record summary
    const ben = benInfoMap.get(r.beneficiary_code);
    const sessList = recordsBySession.get(r.session_id) ?? [];
    sessList.push({
      session_id: r.session_id,
      beneficiary_code: r.beneficiary_code,
      name: ben?.name ?? null,
      alias: ben?.alias ?? null,
      displayName: ben?.displayName ?? r.beneficiary_code,
      sex: ben?.sex ?? 'female',
      age: ben?.age ?? 0,
      is_present: isPres,
      weight_kg: wKg,
      height_cm: hCm,
      waist_cm: wstCm,
      bmi: computedBmiVal,
      whtr: computedWhtrVal,
      survey_answers: surveyAns,
      nutritionist_id: r.nutritionist_id,
      muac_cm: r.muac_cm != null ? Number(r.muac_cm) : null,
      edema: r.edema != null ? Boolean(r.edema) : null,
      clinical_notes: r.clinical_notes,
    });
    recordsBySession.set(r.session_id, sessList);
  }

  // 15. Build Sessions list with live aggregates and records
  const sessions: SessionData[] = rawSessions.map((s) => {
    const state = computeSessionState(s, rawSessions);
    const boundary = checkBoundarySession(
      s.session_id,
      rawTimelines.map((t) => ({ seq: t.seq, start_session_id: t.start_session_id, end_session_id: t.end_session_id }))
    );

    let owningSeq: number | null = null;
    for (const tl of rawTimelines) {
      if (tl.start_date && tl.end_date && isSessionOwnedByTimeline(s.session_date, tl.seq, tl.start_date, tl.end_date)) {
        owningSeq = tl.seq;
        break;
      }
    }

    const sDate = s.session_date.slice(0, 10);
    const sessionRecords = recordsBySession.get(s.session_id) ?? [];

    // Registered beneficiaries as of this session date
    const registeredCount = rawBeneficiaries.filter(
      (b) => b.registered_session_date.slice(0, 10) <= sDate
    ).length;

    // Measured in this session (is_present && (weight || height))
    const measuredCount = sessionRecords.filter(
      (r) => r.is_present && (r.weight_kg != null || r.height_cm != null)
    ).length;

    // BMI mean & n
    const bmis = sessionRecords
      .filter((r) => r.bmi != null)
      .map((r) => r.bmi as number);
    const bmiMean = bmis.length > 0 ? Math.round((bmis.reduce((a, b) => a + b, 0) / bmis.length) * 10) / 10 : null;

    // WHtR mean & n
    const whtrs = sessionRecords
      .filter((r) => r.whtr != null)
      .map((r) => r.whtr as number);
    const whtrMean = whtrs.length > 0 ? Math.round((whtrs.reduce((a, b) => a + b, 0) / whtrs.length) * 100) / 100 : null;

    // Survey averages per question
    const surveyAverages: Record<string, { avg: number; n: number }> = {};
    for (const q of surveyQuestions) {
      const vals: number[] = [];
      for (const r of sessionRecords) {
        if (r.survey_answers[q.question_id] != null) {
          vals.push(r.survey_answers[q.question_id]);
        }
      }
      surveyAverages[q.question_id] = {
        avg: vals.length > 0 ? Math.round((vals.reduce((a, b) => a + b, 0) / vals.length) * 10) / 10 : 0,
        n: vals.length,
      };
    }

    // Nutritionist checks count
    const nutritionistChecksCount = sessionRecords.filter(
      (r) => r.muac_cm != null || r.edema != null || r.clinical_notes != null
    ).length;

    const ai = sessionAiMap.get(s.session_id);

    const aggregates: SessionAggregates = {
      present_count: Number(s.present_count),
      registered_count: registeredCount,
      measured_count: measuredCount,
      bmi_mean: bmiMean,
      bmi_n: bmis.length,
      whtr_mean: whtrMean,
      whtr_n: whtrs.length,
      survey_averages: surveyAverages,
      nutritionist_checks_count: nutritionistChecksCount,
      ai_comments: ai?.comments ?? null,
      ai_category: ai?.category ?? null,
    };

    return {
      session_id: s.session_id,
      program_id: s.program_id,
      session_date: sDate,
      submitted_at: s.submitted_at,
      record_count: Number(s.record_count),
      present_count: Number(s.present_count),
      state,
      boundary,
      owning_seq: owningSeq,
      notes: notesBySession.get(s.session_id) ?? [],
      aggregates,
      records: sessionRecords,
    };
  });

  // 16. Build Timelines Data
  const timelines: TimelineData[] = rawTimelines.map((tl) => {
    const sDate = tl.start_date?.slice(0, 10) ?? '';
    const eDate = tl.end_date?.slice(0, 10) ?? '';
    const state = computeTimelineState(
      { seq: tl.seq, closed_at: tl.closed_at, start_date: sDate, end_date: eDate },
      timelinesMeta,
      today
    );

    const memberSessions = sessions.filter((s) =>
      isSessionOwnedByTimeline(s.session_date, tl.seq, sDate, eDate)
    );

    const eligibleBen = rawBeneficiaries.filter(
      (b) => b.registered_session_date.slice(0, 10) <= eDate
    );
    const registered_count = eligibleBen.length;

    const measured_count = eligibleBen.filter((b) => {
      const records = recordsByBeneficiary.get(b.beneficiary_code) ?? [];
      return records.some(
        (r) =>
          isSessionOwnedByTimeline(r.session_date, tl.seq, sDate, eDate) &&
          (tl.closed_at == null || r.submitted_at != null) &&
          r.is_present &&
          (r.weight_kg != null || r.height_cm != null || r.waist_cm != null || r.muac_cm != null || r.edema === true)
      );
    }).length;

    const coverage_pct = registered_count > 0 ? Math.round((measured_count / registered_count) * 100) : 0;

    const statusCounts: Record<StatusKey, number> = {
      baseline: 0,
      monitor: 0,
      monitor_closely: 0,
      unavailable: 0,
    };
    for (const sc of rawStatusCounts.filter((r) => r.timeline_id === tl.timeline_id)) {
      if (sc.status_key in statusCounts) {
        statusCounts[sc.status_key as StatusKey] = Number(sc.count);
      }
    }

    const beneficiaryStatuses: TimelineBeneficiaryStatusRow[] = rawTimelineStatuses
      .filter((r) => r.timeline_id === tl.timeline_id)
      .map((r) => ({
        beneficiary_code: r.beneficiary_code,
        status_key: r.status_key,
        status_reason: r.status_reason,
      }));

    return {
      timeline_id: tl.timeline_id,
      seq: tl.seq,
      start_session_id: tl.start_session_id,
      end_session_id: tl.end_session_id,
      start_date: sDate,
      end_date: eDate,
      closed_at: tl.closed_at,
      state,
      member_sessions: memberSessions,
      registered_count,
      measured_count,
      coverage_pct,
      status_counts: statusCounts,
      beneficiary_statuses: beneficiaryStatuses,
      ai_interpretation: aiByTimeline.get(tl.timeline_id) ?? null,
    };
  });

  // 17. Open Timeline 5-day warning check
  const openTimeline = timelines.find((t) => t.state === 'open');
  let openTimelineWarningActive = false;
  let openTimelineWarningDaysLeft = 0;
  let openTimelineSeq = 0;
  let openTimelineEndDate = '';

  if (openTimeline) {
    const daysLeft = daysBetween(today, openTimeline.end_date);
    if (daysLeft >= 0 && daysLeft <= 5) {
      openTimelineWarningActive = true;
      openTimelineWarningDaysLeft = daysLeft;
      openTimelineSeq = openTimeline.seq;
      openTimelineEndDate = openTimeline.end_date;
    }
  }

  // 18. Build Beneficiaries Data
  const submittedSessions = sessions.filter((s) => s.submitted_at != null);

  const beneficiaries: BeneficiaryData[] = rawBeneficiaries.map((b) => {
    const regDate = b.registered_session_date.slice(0, 10);
    const months = ageInMonths(b.birth_month, b.birth_year, today);
    const age = Math.floor(months / 12);
    const isAdult = isAdultAt(b.birth_month, b.birth_year, today);

    const displayName = b.name ? b.name : b.alias ? b.alias : '—';
    const latestStatus = latestStatusByBeneficiary.get(b.beneficiary_code);
    const measurements = recordsByBeneficiary.get(b.beneficiary_code) ?? [];

    const eligibleSessions = submittedSessions.filter((s) => s.session_date >= regDate);
    const attendedCount = eligibleSessions.filter((s) => {
      const rec = measurements.find((m) => m.session_id === s.session_id);
      return rec ? rec.is_present : false;
    }).length;

    const attendancePct =
      eligibleSessions.length > 0 ? Math.round((attendedCount / eligibleSessions.length) * 100) : 100;

    const qualifyingRecords = measurements.filter(
      (m) => m.is_present && (m.weight_kg != null || m.height_cm != null || m.muac_cm != null || m.edema === true)
    );
    const lastMeasuredDate =
      qualifyingRecords.length > 0
        ? qualifyingRecords[qualifyingRecords.length - 1].session_date
        : null;

    // Overall changes from the beneficiary's first ever measurement to their latest measurement
    const presentMeasurements = measurements.filter((m) => m.is_present);

    const bmiRecords = presentMeasurements.filter((m) => m.bmi != null);
    let overallBmiOptimality: number | null = null;
    if (bmiRecords.length >= 2) {
      const firstBmiRec = bmiRecords[0];
      const latestBmiRec = bmiRecords[bmiRecords.length - 1];
      const bmiComputed = computeTimelineChanges(
        {
          weightKg: latestBmiRec.weight_kg,
          heightCm: latestBmiRec.height_cm,
          waistCm: null,
          muacCm: null,
          edema: null,
          bmi: latestBmiRec.bmi,
          whtr: null,
        },
        {
          weightKg: firstBmiRec.weight_kg,
          heightCm: firstBmiRec.height_cm,
          waistCm: null,
          muacCm: null,
          edema: null,
          bmi: firstBmiRec.bmi,
          whtr: null,
        },
        {
          sex: b.sex,
          birthMonth: b.birth_month,
          birthYear: b.birth_year,
          currEndDate: latestBmiRec.session_date,
          prevEndDate: firstBmiRec.session_date,
        }
      );
      overallBmiOptimality = bmiComputed.bmi_optimality;
    }

    const whtrRecords = presentMeasurements.filter((m) => m.waist_cm != null && m.height_cm != null);
    let overallWhtrOptimality: number | null = null;
    if (whtrRecords.length >= 2) {
      const firstWhtrRec = whtrRecords[0];
      const latestWhtrRec = whtrRecords[whtrRecords.length - 1];
      const whtrComputed = computeTimelineChanges(
        {
          weightKg: null,
          heightCm: latestWhtrRec.height_cm,
          waistCm: latestWhtrRec.waist_cm,
          muacCm: null,
          edema: null,
          bmi: null,
          whtr: computeWhtr(latestWhtrRec.waist_cm, latestWhtrRec.height_cm),
        },
        {
          weightKg: null,
          heightCm: firstWhtrRec.height_cm,
          waistCm: firstWhtrRec.waist_cm,
          muacCm: null,
          edema: null,
          bmi: null,
          whtr: computeWhtr(firstWhtrRec.waist_cm, firstWhtrRec.height_cm),
        }
      );
      overallWhtrOptimality = whtrComputed.whtr_optimality;
    }

    const weightDelta = computeFirstToLatestDelta(measurements, 'weight_kg');
    const waistDelta = computeFirstToLatestDelta(measurements, 'waist_cm');
    const muacDelta = computeFirstToLatestDelta(measurements, 'muac_cm');

    let hasMeasurementInOpenTimeline = false;
    if (openTimelineWarningActive && openTimeline) {
      hasMeasurementInOpenTimeline = measurements.some((m) => {
        const isOwned = isSessionOwnedByTimeline(
          m.session_date,
          openTimeline.seq,
          openTimeline.start_date,
          openTimeline.end_date
        );
        return (
          isOwned &&
          m.is_present &&
          (m.weight_kg != null || m.height_cm != null || m.muac_cm != null || m.edema === true)
        );
      });
    }

    const needsWarning = openTimelineWarningActive && !hasMeasurementInOpenTimeline;

    return {
      program_id: b.program_id,
      beneficiary_code: b.beneficiary_code,
      name: b.name,
      alias: b.alias,
      displayName,
      birth_month: b.birth_month,
      birth_year: b.birth_year,
      sex: b.sex,
      age,
      isAdult,
      registered_session_id: b.registered_session_id,
      registered_session_date: regDate,
      latest_status: latestStatus ? latestStatus.status_key : null,
      latest_status_reason_key: latestStatus ? latestStatus.status_reason : null,
      latest_status_reason: latestStatus
        ? latestStatus.status_reason_description ??
          REASON_DESCRIPTION[latestStatus.status_reason] ??
          latestStatus.status_reason
        : null,
      latest_status_timeline_seq: latestStatus ? Number(latestStatus.timeline_seq) : null,
      bmi_optimality: overallBmiOptimality,
      whtr_optimality: overallWhtrOptimality,
      weight_change: weightDelta ? weightDelta.delta : null,
      weight_change_pct: weightDelta ? weightDelta.pctChange : null,
      waist_change: waistDelta ? waistDelta.delta : null,
      muac_change: muacDelta ? muacDelta.delta : null,
      last_measured_date: lastMeasuredDate,
      attendance_pct: attendancePct,
      attended_count: attendedCount,
      eligible_sessions_count: eligibleSessions.length,
      needs_measurement_warning: needsWarning,
      allergies: allergiesByBeneficiary.get(b.beneficiary_code) ?? [],
      guardians: guardiansByBeneficiary.get(b.beneficiary_code) ?? [],
      measurements,
    };
  });

  const unmeasuredCount = beneficiaries.filter((b) => b.needs_measurement_warning).length;

  return {
    program,
    sessions,
    timelines,
    beneficiaries,
    availableAllergies,
    assignedNutritionists,
    surveyQuestions,
    today,
    openTimelineWarning: openTimelineWarningActive
      ? {
          active: true,
          seq: openTimelineSeq,
          endDate: openTimelineEndDate,
          daysLeft: openTimelineWarningDaysLeft,
          unmeasuredCount,
        }
      : null,
  };
}
