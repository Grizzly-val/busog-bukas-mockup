'use server';

import crypto from 'node:crypto';
import { cookies } from 'next/headers';
import { revalidatePath } from 'next/cache';
import type { PoolConnection, RowDataPacket } from 'mysql2/promise';
import { ORG_COOKIE, isValidOrgId } from '@/lib/orgContext';
import { withTransaction, query } from '@/lib/db';
import { getMockToday } from '@/lib/mockToday';
import {
  ageInMonths,
  classifyStatus,
  summarizeTimeline,
  computeTimelineChanges,
  type SessionMeasurement,
} from '@/lib/statusRule';
import { formatDate } from '@/lib/format';
import { isSessionOwnedByTimeline } from '@/lib/timelineRules';

/**
 * "Switch Account" for the mockup (no auth): remembers the chosen organization
 * in the `selected_org_id` cookie and refreshes every route under the root layout.
 */
export async function switchAccountAction(orgId: string): Promise<void> {
  if (typeof orgId !== 'string' || !(await isValidOrgId(orgId))) return;

  const cookieStore = await cookies();
  cookieStore.set(ORG_COOKIE, orgId, {
    path: '/',
    httpOnly: true,
    sameSite: 'lax',
    maxAge: 60 * 60 * 24 * 30,
  });

  revalidatePath('/', 'layout');
}

// ---------------------------------------------------------------------------
// 1. Register Beneficiary Action
// ---------------------------------------------------------------------------

export type RegisterBeneficiaryInput = {
  programId: string;
  sessionId: string;
  birthMonth: number;
  birthYear: number;
  sex: 'female' | 'male';
  name?: string | null;
  allergies?: string[];
  guardian?: {
    name: string;
    number: string;
    relationship: string;
  } | null;
};

export type RegisterBeneficiaryResult = {
  success: boolean;
  beneficiaryCode?: string;
  displayName?: string;
  alias?: string | null;
  error?: string;
};

const ADJECTIVES = ['Red', 'Orange', 'Yellow', 'Green', 'Blue', 'Teal', 'Pink', 'Purple', 'Gold', 'Silver', 'Swift', 'Bright'];
const NOUNS = ['Calamansi', 'Lychee', 'Guava', 'Melon', 'Papaya', 'Pomelo', 'Mango', 'Santol', 'Banana', 'Avocado', 'Rambutan', 'Lansones'];

async function generateUniqueAlias(conn: PoolConnection, programId: string): Promise<string> {
  for (let attempt = 0; attempt < 50; attempt++) {
    const adj = ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)];
    const noun = NOUNS[Math.floor(Math.random() * NOUNS.length)];
    const num = Math.floor(Math.random() * 9) + 1;
    const candidate = `${adj}-${noun}-${num}`;

    const [rows]: [RowDataPacket[], unknown] = await conn.query(
      'SELECT 1 FROM beneficiary_alias WHERE program_id = ? AND alias = ? LIMIT 1',
      [programId, candidate]
    );
    if (rows.length === 0) return candidate;
  }
  return `Participant-${Math.floor(Math.random() * 9000) + 1000}`;
}

export async function registerBeneficiaryAction(
  input: RegisterBeneficiaryInput
): Promise<RegisterBeneficiaryResult> {
  const { programId, sessionId, birthMonth, birthYear, sex, name, allergies, guardian } = input;
  const today = getMockToday();

  // Validate session state and locking
  const [session] = await query<{ session_id: string; session_date: string; submitted_at: string | null }>(
    'SELECT session_id, session_date, submitted_at FROM program_session WHERE program_id = ? AND session_id = ? LIMIT 1',
    [programId, sessionId]
  );

  if (!session) {
    return { success: false, error: 'Session not found.' };
  }
  if (session.submitted_at != null) {
    return { success: false, error: 'Cannot register beneficiary into a submitted session.' };
  }

  const laterSubmitted = await query<{ session_id: string }>(
    'SELECT session_id FROM program_session WHERE program_id = ? AND session_date > ? AND submitted_at IS NOT NULL LIMIT 1',
    [programId, session.session_date]
  );
  if (laterSubmitted.length > 0) {
    return { success: false, error: 'Cannot register into a locked/skipped session.' };
  }

  // Validate age & guardian requirement
  const months = ageInMonths(birthMonth, birthYear, today);
  const isMinor = months < 216; // < 18 years
  const trimmedName = name?.trim() || null;

  if (isMinor && trimmedName) {
    if (!guardian?.name?.trim() || !guardian?.number?.trim() || !guardian?.relationship?.trim()) {
      return {
        success: false,
        error: 'Guardian name, contact number, and relationship are strictly required for minors when storing a full name.',
      };
    }
  }

  try {
    return await withTransaction(async (conn) => {
      // 1. Assign next 5-digit code
      const [codeRows]: [RowDataPacket[], unknown] = await conn.query(
        'SELECT MAX(CAST(beneficiary_code AS UNSIGNED)) AS max_code FROM beneficiary WHERE program_id = ? FOR UPDATE',
        [programId]
      );
      const maxCode = (codeRows[0] as { max_code: number | null }).max_code;
      const nextNum = maxCode ? Number(maxCode) + 1 : 10001;
      const beneficiaryCode = String(nextNum).padStart(5, '0');

      let alias: string | null = null;
      if (!trimmedName) {
        alias = await generateUniqueAlias(conn, programId);
      }

      // 2. Insert into beneficiary table
      await conn.query(
        `INSERT INTO beneficiary (program_id, beneficiary_code, name, birth_month, birth_year, sex, registered_session_id)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [programId, beneficiaryCode, trimmedName, birthMonth, birthYear, sex, sessionId]
      );

      // 3. Insert into beneficiary_alias if unnamed
      if (alias) {
        await conn.query(
          'INSERT INTO beneficiary_alias (program_id, beneficiary_code, alias) VALUES (?, ?, ?)',
          [programId, beneficiaryCode, alias]
        );
      }

      // 4. Guardian and Consent if provided
      if (guardian && guardian.name?.trim() && guardian.number?.trim()) {
        const guardianId = crypto.randomUUID();
        await conn.query(
          'INSERT INTO guardian (guardian_id, name, `number`) VALUES (?, ?, ?)',
          [guardianId, guardian.name.trim(), guardian.number.trim()]
        );
        await conn.query(
          'INSERT INTO consent (program_id, beneficiary_code, guardian_id, relationship) VALUES (?, ?, ?, ?)',
          [programId, beneficiaryCode, guardianId, guardian.relationship.trim()]
        );
      }

      // 5. Allergies if provided
      if (allergies && allergies.length > 0) {
        for (const allergyId of allergies) {
          await conn.query(
            'INSERT IGNORE INTO beneficiary_allergy (program_id, beneficiary_code, allergy_id) VALUES (?, ?, ?)',
            [programId, beneficiaryCode, allergyId]
          );
        }
      }

      // 6. Insert initial session_record(is_present = TRUE)
      await conn.query(
        `INSERT INTO session_record (session_id, program_id, beneficiary_code, is_present, weight_kg, height_cm, waist_cm)
         VALUES (?, ?, ?, TRUE, NULL, NULL, NULL)`,
        [sessionId, programId, beneficiaryCode]
      );

      revalidatePath(`/programs/${programId}`);
      revalidatePath('/');

      return {
        success: true,
        beneficiaryCode,
        displayName: trimmedName ?? alias ?? beneficiaryCode,
        alias,
      };
    });
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : 'Database error while registering beneficiary.',
    };
  }
}

// ---------------------------------------------------------------------------
// 2. Save Default Input Action
// ---------------------------------------------------------------------------

export type DefaultInputData = {
  programId: string;
  sessionId: string;
  beneficiaryCode: string;
  isPresent: boolean;
  weightKg?: number | null;
  heightCm?: number | null;
  waistCm?: number | null;
  surveyAnswers?: Record<string, number>;
};

export type ActionResult = {
  success: boolean;
  message?: string;
  error?: string;
};

export async function saveDefaultInputAction(input: DefaultInputData): Promise<ActionResult> {
  const { programId, sessionId, beneficiaryCode, isPresent, weightKg, heightCm, waistCm, surveyAnswers } = input;

  // Session state locking check
  const [session] = await query<{ session_id: string; session_date: string; submitted_at: string | null }>(
    'SELECT session_id, session_date, submitted_at FROM program_session WHERE program_id = ? AND session_id = ? LIMIT 1',
    [programId, sessionId]
  );

  if (!session) return { success: false, error: 'Session not found.' };
  if (session.submitted_at != null) return { success: false, error: 'Cannot edit a submitted session.' };

  const laterSubmitted = await query<{ session_id: string }>(
    'SELECT session_id FROM program_session WHERE program_id = ? AND session_date > ? AND submitted_at IS NOT NULL LIMIT 1',
    [programId, session.session_date]
  );
  if (laterSubmitted.length > 0) return { success: false, error: 'Cannot edit a skipped / locked session.' };

  try {
    return await withTransaction(async (conn) => {
      // 1. Upsert session_record
      await conn.query(
        `INSERT INTO session_record (session_id, program_id, beneficiary_code, is_present, weight_kg, height_cm, waist_cm)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
           is_present = VALUES(is_present),
           weight_kg = VALUES(weight_kg),
           height_cm = VALUES(height_cm),
           waist_cm = VALUES(waist_cm)`,
        [
          sessionId,
          programId,
          beneficiaryCode,
          isPresent,
          weightKg != null && weightKg > 0 ? weightKg : null,
          heightCm != null && heightCm > 0 ? heightCm : null,
          waistCm != null && waistCm > 0 ? waistCm : null,
        ]
      );

      // 2. Replace survey_answer rows
      await conn.query(
        'DELETE FROM survey_answer WHERE session_id = ? AND program_id = ? AND beneficiary_code = ?',
        [sessionId, programId, beneficiaryCode]
      );

      if (surveyAnswers && typeof surveyAnswers === 'object') {
        for (const [qId, val] of Object.entries(surveyAnswers)) {
          const numVal = Number(val);
          if (numVal >= 1 && numVal <= 5) {
            await conn.query(
              'INSERT INTO survey_answer (session_id, program_id, beneficiary_code, question_id, `value`) VALUES (?, ?, ?, ?, ?)',
              [sessionId, programId, beneficiaryCode, qId, numVal]
            );
          }
        }
      }

      revalidatePath(`/programs/${programId}`);
      revalidatePath('/');
      return { success: true, message: 'Default input saved successfully.' };
    });
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : 'Database error while saving default input.',
    };
  }
}

// ---------------------------------------------------------------------------
// 3. Save Nutritionist Input Action
// ---------------------------------------------------------------------------

export type NutritionistInputData = {
  programId: string;
  sessionId: string;
  beneficiaryCode: string;
  nutritionistId: string;
  muacCm?: number | null;
  edema?: boolean | null;
  clinicalNotes?: string | null;
};

export async function saveNutritionistInputAction(input: NutritionistInputData): Promise<ActionResult> {
  const { programId, sessionId, beneficiaryCode, nutritionistId, muacCm, edema, clinicalNotes } = input;

  // Session state locking check
  const [session] = await query<{ session_id: string; session_date: string; submitted_at: string | null }>(
    'SELECT session_id, session_date, submitted_at FROM program_session WHERE program_id = ? AND session_id = ? LIMIT 1',
    [programId, sessionId]
  );

  if (!session) return { success: false, error: 'Session not found.' };
  if (session.submitted_at != null) return { success: false, error: 'Cannot edit a submitted session.' };

  const laterSubmitted = await query<{ session_id: string }>(
    'SELECT session_id FROM program_session WHERE program_id = ? AND session_date > ? AND submitted_at IS NOT NULL LIMIT 1',
    [programId, session.session_date]
  );
  if (laterSubmitted.length > 0) return { success: false, error: 'Cannot edit a skipped / locked session.' };

  // Verify nutritionist is assigned to this program
  const assigned = await query<{ nutritionist_id: string }>(
    'SELECT nutritionist_id FROM program_nutritionist WHERE program_id = ? AND nutritionist_id = ? LIMIT 1',
    [programId, nutritionistId]
  );
  if (assigned.length === 0) {
    return { success: false, error: 'Selected nutritionist is not assigned to this program.' };
  }

  try {
    return await withTransaction(async (conn) => {
      // Ensure session_record exists (foreign key target)
      await conn.query(
        `INSERT INTO session_record (session_id, program_id, beneficiary_code, is_present)
         VALUES (?, ?, ?, TRUE)
         ON DUPLICATE KEY UPDATE is_present = TRUE`,
        [sessionId, programId, beneficiaryCode]
      );

      // Upsert nutritionist_record
      await conn.query(
        `INSERT INTO nutritionist_record (session_id, program_id, beneficiary_code, nutritionist_id, muac_cm, edema, clinical_notes)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
           nutritionist_id = VALUES(nutritionist_id),
           muac_cm = VALUES(muac_cm),
           edema = VALUES(edema),
           clinical_notes = VALUES(clinical_notes)`,
        [
          sessionId,
          programId,
          beneficiaryCode,
          nutritionistId,
          muacCm != null && muacCm > 0 ? muacCm : null,
          edema != null ? edema : null,
          clinicalNotes?.trim() || null,
        ]
      );

      revalidatePath(`/programs/${programId}`);
      revalidatePath('/');
      return { success: true, message: 'Nutritionist check saved successfully.' };
    });
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : 'Database error while saving nutritionist record.',
    };
  }
}

// ---------------------------------------------------------------------------
// 4. Submit Session Action (Single DB Transaction)
// ---------------------------------------------------------------------------

export type SubmitSessionResult = {
  success: boolean;
  message?: string;
  error?: string;
  closedTimelineSeq?: number;
};

export async function submitSessionAction(
  sessionId: string,
  programId: string
): Promise<SubmitSessionResult> {
  const today = getMockToday();
  const submitTimestamp = `${today} 14:00:00`;

  try {
    return await withTransaction(async (conn) => {
      // 1. Lock and verify session
      const [sessionRows]: [RowDataPacket[], unknown] = await conn.query(
        'SELECT session_id, session_date, submitted_at FROM program_session WHERE program_id = ? AND session_id = ? FOR UPDATE',
        [programId, sessionId]
      );
      if (sessionRows.length === 0) {
        return { success: false, error: 'Session not found.' };
      }
      const session = sessionRows[0] as { session_id: string; session_date: string; submitted_at: string | null };

      if (session.submitted_at != null) {
        return { success: false, error: 'Session is already submitted.' };
      }

      // Check no later session is submitted
      const [laterRows]: [RowDataPacket[], unknown] = await conn.query(
        'SELECT session_id FROM program_session WHERE program_id = ? AND session_date > ? AND submitted_at IS NOT NULL LIMIT 1',
        [programId, session.session_date]
      );
      if (laterRows.length > 0) {
        return { success: false, error: 'Cannot submit: a later session has already been submitted. This session is skipped and locked.' };
      }

      // 2. Stamp submitted_at
      await conn.query(
        'UPDATE program_session SET submitted_at = ? WHERE session_id = ?',
        [submitTimestamp, sessionId]
      );

      // 3. Reconciliation pass: insert is_present=FALSE for registered beneficiaries who have no record
      await conn.query(
        `INSERT INTO session_record (session_id, program_id, beneficiary_code, is_present, weight_kg, height_cm, waist_cm)
         SELECT ?, b.program_id, b.beneficiary_code, FALSE, NULL, NULL, NULL
           FROM beneficiary b
           JOIN program_session ps_reg ON ps_reg.session_id = b.registered_session_id
          WHERE b.program_id = ?
            AND ps_reg.session_date <= ?
            AND b.beneficiary_code NOT IN (
              SELECT sr.beneficiary_code
                FROM session_record sr
               WHERE sr.session_id = ?
                 AND sr.program_id = ?
            )`,
        [sessionId, programId, session.session_date, sessionId, programId]
      );

      // 4. Timeline Close check
      const [closingTimelineRows]: [RowDataPacket[], unknown] = await conn.query(
        `SELECT t.timeline_id, t.seq, t.start_session_id, t.end_session_id, t.closed_at,
                s_start.session_date AS start_date,
                s_end.session_date AS end_date
           FROM timeline t
           JOIN program_session s_start ON s_start.session_id = t.start_session_id
           JOIN program_session s_end ON s_end.session_id = t.end_session_id
          WHERE t.program_id = ?
            AND t.end_session_id = ?
            AND t.closed_at IS NULL
          LIMIT 1`,
        [programId, sessionId]
      );

      let closedSeq: number | undefined;

      if (closingTimelineRows.length > 0) {
        const tl = closingTimelineRows[0] as {
          timeline_id: string;
          seq: number;
          start_date: string;
          end_date: string;
        };
        closedSeq = tl.seq;

        // Stamp closed_at
        await conn.query('UPDATE timeline SET closed_at = ? WHERE timeline_id = ?', [
          submitTimestamp,
          tl.timeline_id,
        ]);

        // Fetch all submitted records for current timeline (including clinical nutritionist checks)
        const [currRecords]: [RowDataPacket[], unknown] = await conn.query(
          `SELECT sr.session_id, sr.beneficiary_code, sr.is_present, sr.weight_kg, sr.height_cm, sr.waist_cm,
                  ps.session_date, nr.muac_cm, nr.edema
             FROM session_record sr
             JOIN program_session ps ON ps.session_id = sr.session_id
             LEFT JOIN nutritionist_record nr
               ON nr.session_id = sr.session_id
              AND nr.program_id = sr.program_id
              AND nr.beneficiary_code = sr.beneficiary_code
            WHERE sr.program_id = ?
              AND ps.submitted_at IS NOT NULL
            ORDER BY ps.session_date ASC`,
          [programId]
        );

        // Fetch beneficiary demographic info
        const [benRows]: [RowDataPacket[], unknown] = await conn.query(
          `SELECT b.beneficiary_code, b.birth_month, b.birth_year, b.sex,
                  ps.session_date AS registered_session_date
             FROM beneficiary b
             JOIN program_session ps ON ps.session_id = b.registered_session_id
            WHERE b.program_id = ?`,
          [programId]
        );

        const benMap = new Map<string, { birth_month: number; birth_year: number; sex: 'female' | 'male'; regDate: string }>();
        for (const b of benRows as Array<{ beneficiary_code: string; birth_month: number; birth_year: number; sex: 'female' | 'male'; registered_session_date: string }>) {
          benMap.set(b.beneficiary_code, {
            birth_month: b.birth_month,
            birth_year: b.birth_year,
            sex: b.sex,
            regDate: b.registered_session_date.slice(0, 10),
          });
        }

        type RawTimelineRec = {
          beneficiary_code: string;
          session_date: string;
          is_present: number | boolean;
          weight_kg: number | null;
          height_cm: number | null;
          waist_cm: number | null;
          muac_cm: number | null;
          edema: number | boolean | null;
        };

        // Filter current timeline records using attribution rule
        const currByBen = new Map<string, SessionMeasurement[]>();
        for (const r of currRecords as RawTimelineRec[]) {
          const sDate = r.session_date.slice(0, 10);
          if (isSessionOwnedByTimeline(sDate, tl.seq, tl.start_date, tl.end_date)) {
            const list = currByBen.get(r.beneficiary_code) ?? [];
            list.push({
              session_date: sDate,
              is_present: Boolean(r.is_present),
              weight_kg: r.weight_kg != null ? Number(r.weight_kg) : null,
              height_cm: r.height_cm != null ? Number(r.height_cm) : null,
              waist_cm: r.waist_cm != null ? Number(r.waist_cm) : null,
              muac_cm: r.muac_cm != null ? Number(r.muac_cm) : null,
              edema: r.edema != null ? Boolean(r.edema) : null,
            });
            currByBen.set(r.beneficiary_code, list);
          }
        }

        // If seq > 1, get previous timeline dates and measurements
        const prevByBen = new Map<string, SessionMeasurement[]>();
        let prevTimelineEndDate = tl.end_date.slice(0, 10);
        if (tl.seq > 1) {
          const [prevTlRows]: [RowDataPacket[], unknown] = await conn.query(
            `SELECT t_prev.seq, s_start.session_date AS start_date, s_end.session_date AS end_date
               FROM timeline t_prev
               JOIN program_session s_start ON s_start.session_id = t_prev.start_session_id
               JOIN program_session s_end ON s_end.session_id = t_prev.end_session_id
              WHERE t_prev.program_id = ? AND t_prev.seq = ?
              LIMIT 1`,
            [programId, tl.seq - 1]
          );

          if (prevTlRows.length > 0) {
            const ptl = prevTlRows[0] as { seq: number; start_date: string; end_date: string };
            prevTimelineEndDate = ptl.end_date.slice(0, 10);
            for (const r of currRecords as RawTimelineRec[]) {
              const sDate = r.session_date.slice(0, 10);
              if (isSessionOwnedByTimeline(sDate, ptl.seq, ptl.start_date, ptl.end_date)) {
                const list = prevByBen.get(r.beneficiary_code) ?? [];
                list.push({
                  session_date: sDate,
                  is_present: Boolean(r.is_present),
                  weight_kg: r.weight_kg != null ? Number(r.weight_kg) : null,
                  height_cm: r.height_cm != null ? Number(r.height_cm) : null,
                  waist_cm: r.waist_cm != null ? Number(r.waist_cm) : null,
                  muac_cm: r.muac_cm != null ? Number(r.muac_cm) : null,
                  edema: r.edema != null ? Boolean(r.edema) : null,
                });
                prevByBen.set(r.beneficiary_code, list);
              }
            }
          }
        }

        // Calculate statuses and insert into beneficiary_timeline_status
        let baselineCount = 0;
        let monitorCount = 0;
        let monitorCloselyCount = 0;
        let unavailableCount = 0;
        let totalMeasured = 0;
        let sumBmi = 0;
        let countBmi = 0;
        let improvedCount = 0;

        for (const [code, ben] of benMap.entries()) {
          if (ben.regDate > tl.end_date.slice(0, 10)) continue;

          const currList = currByBen.get(code) ?? [];
          const currMetrics = summarizeTimeline(currList);

          const hasAnyMeasurement =
            currMetrics.weightKg != null ||
            currMetrics.heightCm != null ||
            currMetrics.waistCm != null ||
            currMetrics.muacCm != null ||
            currMetrics.edema === true;

          if (!hasAnyMeasurement) {
            continue;
          }

          const statusResult = classifyStatus({
            sex: ben.sex,
            birthMonth: ben.birth_month,
            birthYear: ben.birth_year,
            asOf: tl.end_date,
            bmi: currMetrics.bmi,
            whtr: currMetrics.whtr,
            muacCm: currMetrics.muacCm,
            edema: currMetrics.edema,
            hasPartialMeasurement: hasAnyMeasurement,
          });

          if (!statusResult) continue;

          totalMeasured++;
          if (currMetrics.bmi != null) {
            sumBmi += currMetrics.bmi;
            countBmi++;
          }

          if (statusResult.statusKey === 'baseline') baselineCount++;
          else if (statusResult.statusKey === 'monitor') monitorCount++;
          else if (statusResult.statusKey === 'monitor_closely') monitorCloselyCount++;
          else if (statusResult.statusKey === 'unavailable') unavailableCount++;

          let changes = { bmi_change: null as number | null, whtr_change: null as number | null, muac_change: null as number | null };
          if (tl.seq > 1) {
            const prevList = prevByBen.get(code) ?? [];
            const prevMetrics = summarizeTimeline(prevList);
            changes = computeTimelineChanges(currMetrics, prevMetrics, {
              sex: ben.sex,
              birthMonth: ben.birth_month,
              birthYear: ben.birth_year,
              currEndDate: tl.end_date.slice(0, 10),
              prevEndDate: prevTimelineEndDate,
            });
            if (changes.bmi_change != null && changes.bmi_change > 0) {
              improvedCount++;
            }
          }

          await conn.query(
            `INSERT INTO beneficiary_timeline_status (
               program_id, beneficiary_code, timeline_id,
               status_key, status_reason,
               bmi_change, whtr_change, muac_change
             )
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)
             ON DUPLICATE KEY UPDATE
               status_key = VALUES(status_key),
               status_reason = VALUES(status_reason),
               bmi_change = VALUES(bmi_change),
               whtr_change = VALUES(whtr_change),
               muac_change = VALUES(muac_change)`,
            [
              programId,
              code,
              tl.timeline_id,
              statusResult.statusKey,
              statusResult.reasonKey,
              changes.bmi_change,
              changes.whtr_change,
              changes.muac_change,
            ]
          );
        }

        // Templated AI trend interpretation
        const registeredCount = Array.from(benMap.values()).filter((b) => b.regDate <= tl.end_date).length;
        const pct = registeredCount > 0 ? Math.round((totalMeasured / registeredCount) * 100) : 0;
        const meanBmi = countBmi > 0 ? (sumBmi / countBmi).toFixed(1) : '—';
        const ordinal = tl.seq === 1 ? 'First Timeline' : `Timeline ${tl.seq}`;

        let comments = `${ordinal} (${formatDate(tl.start_date)} to ${formatDate(tl.end_date)}): ${totalMeasured} of ${registeredCount} beneficiaries were measured (${pct}%). Mean BMI is ${meanBmi}. ${baselineCount} are at baseline, ${monitorCount} need monitoring and ${monitorCloselyCount} need closer monitoring.`;
        if (tl.seq === 1) {
          comments += ' With no earlier Timeline, there is no trend yet.';
        } else {
          comments += ` ${improvedCount} beneficiaries moved closer to a healthy range compared to Timeline ${tl.seq - 1}.`;
        }

        const aiId = crypto.randomUUID();
        const aiTime = `${today} 14:02:00`;
        await conn.query(
          `INSERT INTO ai_interpretation (interpretation_id, scope, session_id, timeline_id, category, comments, created_at)
           VALUES (?, 'timeline', NULL, ?, 'nutrition_trend', ?, ?)`,
          [aiId, tl.timeline_id, comments, aiTime]
        );
      }

      revalidatePath(`/programs/${programId}`);
      revalidatePath('/');

      return {
        success: true,
        message: closedSeq
          ? `Session submitted, reconciliation complete, and Timeline ${closedSeq} closed.`
          : 'Session submitted and reconciliation complete.',
        closedTimelineSeq: closedSeq,
      };
    });
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : 'Database error while submitting session.',
    };
  }
}
