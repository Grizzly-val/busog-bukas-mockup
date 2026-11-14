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
  classifyBmiStatus,
  classifyEdemaStatus,
  classifyMuacStatus,
  classifyWhtrStatus,
  computeBmiSignedChange,
  computeMuacSignedChange,
  computeWhtrSignedChange,
  resolveEffectiveHeight,
  type Sex,
} from '@/lib/statusRule';

function toNumOrNull(val: unknown): number | null {
  if (val === null || val === undefined || val === '') return null;
  const n = Number(val);
  return Number.isFinite(n) ? n : null;
}

/**
 * Recomputes and syncs a single beneficiary's per-metric status rows
 * (`beneficiary_bmi_status`, `beneficiary_whtr_status`, `beneficiary_muac_status`,
 * `beneficiary_edema_status`) across all of their sessions in the program,
 * ordered chronologically by `program_session.session_date`.
 *
 * This guarantees on every save (draft or submitted) that:
 * - Present source measurements upsert their status row.
 * - Cleared measurements (or is_present = FALSE) delete their status row.
 * - Carry-forward height and all subsequent `*_change` values stay accurate.
 */
async function syncBeneficiarySessionStatuses(
  conn: PoolConnection,
  programId: string,
  beneficiaryCode: string
): Promise<void> {
  const [benRows]: [RowDataPacket[], unknown] = await conn.query(
    `SELECT b.beneficiary_code, b.birth_month, b.birth_year, b.sex,
            b.initial_height_cm, b.initial_weight_kg, b.registered_session_id,
            DATE_FORMAT(ps_reg.session_date, '%Y-%m-%d') AS registration_date
       FROM beneficiary b
       JOIN program_session ps_reg
         ON ps_reg.session_id = b.registered_session_id
        AND ps_reg.program_id = b.program_id
      WHERE b.program_id = ? AND b.beneficiary_code = ?
      LIMIT 1`,
    [programId, beneficiaryCode]
  );

  if (benRows.length === 0) return;
  const ben = benRows[0] as {
    beneficiary_code: string;
    birth_month: number;
    birth_year: number;
    sex: Sex;
    initial_height_cm: number | string;
    initial_weight_kg: number | string;
    registered_session_id: string;
    registration_date: string;
  };

  const [sessionRows]: [RowDataPacket[], unknown] = await conn.query(
    `SELECT sr.session_id,
            DATE_FORMAT(ps.session_date, '%Y-%m-%d') AS session_date,
            sr.is_present, sr.weight_kg, sr.height_cm, sr.waist_cm,
            nr.muac_cm, nr.edema
       FROM session_record sr
       JOIN program_session ps
         ON ps.session_id = sr.session_id AND ps.program_id = sr.program_id
       LEFT JOIN nutritionist_record nr
         ON nr.session_id = sr.session_id
        AND nr.program_id = sr.program_id
        AND nr.beneficiary_code = sr.beneficiary_code
      WHERE sr.program_id = ? AND sr.beneficiary_code = ?
      ORDER BY ps.session_date ASC, sr.session_id ASC`,
    [programId, beneficiaryCode]
  );

  const priorHeights: Array<{ sessionDate: string; heightCm: number }> = [];
  const initialHeightCm = toNumOrNull(ben.initial_height_cm);

  let prevBmi: { bmi: number; sessionDate: string } | null = null;
  let prevWhtr: number | null = null;
  let prevMuac: number | null = null;

  for (const raw of sessionRows) {
    const sessionId = String(raw.session_id);
    const sessionDate = String(raw.session_date).slice(0, 10);
    const isPresent = Boolean(raw.is_present);

    if (!isPresent) {
      await conn.query(
        'DELETE FROM beneficiary_bmi_status WHERE session_id = ? AND program_id = ? AND beneficiary_code = ?',
        [sessionId, programId, beneficiaryCode]
      );
      await conn.query(
        'DELETE FROM beneficiary_whtr_status WHERE session_id = ? AND program_id = ? AND beneficiary_code = ?',
        [sessionId, programId, beneficiaryCode]
      );
      await conn.query(
        'DELETE FROM beneficiary_muac_status WHERE session_id = ? AND program_id = ? AND beneficiary_code = ?',
        [sessionId, programId, beneficiaryCode]
      );
      await conn.query(
        'DELETE FROM beneficiary_edema_status WHERE session_id = ? AND program_id = ? AND beneficiary_code = ?',
        [sessionId, programId, beneficiaryCode]
      );
      await conn.query(
        'DELETE FROM nutritionist_record WHERE session_id = ? AND program_id = ? AND beneficiary_code = ?',
        [sessionId, programId, beneficiaryCode]
      );
      continue;
    }

    const weightKg = toNumOrNull(raw.weight_kg);
    const heightCm = toNumOrNull(raw.height_cm);
    const waistCm = toNumOrNull(raw.waist_cm);
    const muacCm = toNumOrNull(raw.muac_cm);
    const edema = raw.edema === null || raw.edema === undefined ? null : Boolean(raw.edema);

    const effectiveHeight = resolveEffectiveHeight({
      sessionDate,
      sessionHeightCm: heightCm,
      priorHeights,
      initialHeightCm,
      registrationDate: ben.registration_date,
    });

    if (heightCm != null && heightCm > 0) {
      priorHeights.push({ sessionDate, heightCm });
    }

    // 1. BMI status
    const bmiRes = classifyBmiStatus({
      sex: ben.sex,
      birthMonth: Number(ben.birth_month),
      birthYear: Number(ben.birth_year),
      asOf: sessionDate,
      weightKg,
      heightCm: effectiveHeight.heightCm,
    });
    if (bmiRes) {
      const bmiChange = computeBmiSignedChange({
        currBmi: bmiRes.bmi,
        prevBmi: prevBmi?.bmi ?? null,
        birthMonth: Number(ben.birth_month),
        birthYear: Number(ben.birth_year),
        sex: ben.sex,
        currDate: sessionDate,
        prevDate: prevBmi?.sessionDate ?? sessionDate,
      });
      await conn.query(
        `INSERT INTO beneficiary_bmi_status (session_id, program_id, beneficiary_code, status_key, bmi_change)
         VALUES (?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
           status_key = VALUES(status_key),
           bmi_change = VALUES(bmi_change)`,
        [sessionId, programId, beneficiaryCode, bmiRes.statusKey, bmiChange]
      );
      prevBmi = { bmi: bmiRes.bmi, sessionDate };
    } else {
      await conn.query(
        'DELETE FROM beneficiary_bmi_status WHERE session_id = ? AND program_id = ? AND beneficiary_code = ?',
        [sessionId, programId, beneficiaryCode]
      );
    }

    // 2. WHtR status
    const whtrRes = classifyWhtrStatus({
      waistCm,
      heightCm: effectiveHeight.heightCm,
    });
    if (whtrRes) {
      const whtrChange = computeWhtrSignedChange(whtrRes.whtr, prevWhtr);
      await conn.query(
        `INSERT INTO beneficiary_whtr_status (session_id, program_id, beneficiary_code, status_key, whtr_change)
         VALUES (?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
           status_key = VALUES(status_key),
           whtr_change = VALUES(whtr_change)`,
        [sessionId, programId, beneficiaryCode, whtrRes.statusKey, whtrChange]
      );
      prevWhtr = whtrRes.whtr;
    } else {
      await conn.query(
        'DELETE FROM beneficiary_whtr_status WHERE session_id = ? AND program_id = ? AND beneficiary_code = ?',
        [sessionId, programId, beneficiaryCode]
      );
    }

    // 3. MUAC status
    const muacRes = classifyMuacStatus({
      muacCm,
      birthMonth: Number(ben.birth_month),
      birthYear: Number(ben.birth_year),
      asOf: sessionDate,
    });
    if (muacRes) {
      const muacChange = computeMuacSignedChange(muacRes.muacCm, prevMuac);
      await conn.query(
        `INSERT INTO beneficiary_muac_status (session_id, program_id, beneficiary_code, status_key, muac_change)
         VALUES (?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
           status_key = VALUES(status_key),
           muac_change = VALUES(muac_change)`,
        [sessionId, programId, beneficiaryCode, muacRes.statusKey, muacChange]
      );
      prevMuac = muacRes.muacCm;
    } else {
      await conn.query(
        'DELETE FROM beneficiary_muac_status WHERE session_id = ? AND program_id = ? AND beneficiary_code = ?',
        [sessionId, programId, beneficiaryCode]
      );
    }

    // 4. Edema status
    const edemaRes = classifyEdemaStatus(edema);
    if (edemaRes) {
      await conn.query(
        `INSERT INTO beneficiary_edema_status (session_id, program_id, beneficiary_code, status_key)
         VALUES (?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
           status_key = VALUES(status_key)`,
        [sessionId, programId, beneficiaryCode, edemaRes.statusKey]
      );
    } else {
      await conn.query(
        'DELETE FROM beneficiary_edema_status WHERE session_id = ? AND program_id = ? AND beneficiary_code = ?',
        [sessionId, programId, beneficiaryCode]
      );
    }
  }
}

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
  sex: Sex;
  initialWeightKg: number;
  initialHeightCm: number;
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
  const {
    programId,
    sessionId,
    birthMonth,
    birthYear,
    sex,
    initialWeightKg,
    initialHeightCm,
    name,
    allergies,
    guardian,
  } = input;
  const today = getMockToday();

  if (
    !Number.isFinite(initialWeightKg) ||
    initialWeightKg <= 0 ||
    !Number.isFinite(initialHeightCm) ||
    initialHeightCm <= 0
  ) {
    return {
      success: false,
      error: 'Initial weight (kg) and initial height (cm) are required and must be positive.',
    };
  }

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
  const isMinor = months < 216;
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

      // 2. Prepare guardian info if provided
      let pendingGuardian: { name: string; number: string; relationship: string } | null = null;
      if (guardian && guardian.name?.trim() && guardian.number?.trim()) {
        pendingGuardian = {
          name: guardian.name.trim(),
          number: guardian.number.trim(),
          relationship: guardian.relationship.trim(),
        };
      }

      // 3. Insert beneficiary initially with name = NULL so consent can be recorded before writing a real name (Invariant 9)
      await conn.query(
        `INSERT INTO beneficiary (
           program_id, beneficiary_code, name, birth_month, birth_year, sex,
           initial_weight_kg, initial_height_cm, registered_session_id
         ) VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?)`,
        [
          programId,
          beneficiaryCode,
          birthMonth,
          birthYear,
          sex,
          initialWeightKg,
          initialHeightCm,
          sessionId,
        ]
      );

      // 4. Insert alias if unnamed
      if (alias) {
        await conn.query(
          'INSERT INTO beneficiary_alias (program_id, beneficiary_code, alias) VALUES (?, ?, ?)',
          [programId, beneficiaryCode, alias]
        );
      }

      // 5. Insert consent (and guardian if provided) before setting beneficiary.name
      if (pendingGuardian) {
        const guardianId = crypto.randomUUID();
        await conn.query(
          'INSERT INTO guardian (guardian_id, name, `number`) VALUES (?, ?, ?)',
          [guardianId, pendingGuardian.name, pendingGuardian.number]
        );
        await conn.query(
          'INSERT INTO consent (program_id, beneficiary_code, guardian_id, relationship) VALUES (?, ?, ?, ?)',
          [programId, beneficiaryCode, guardianId, pendingGuardian.relationship]
        );
      } else if (trimmedName) {
        await conn.query(
          'INSERT INTO consent (program_id, beneficiary_code, guardian_id, relationship) VALUES (?, ?, NULL, NULL)',
          [programId, beneficiaryCode]
        );
      }

      if (trimmedName) {
        await conn.query(
          'UPDATE beneficiary SET name = ? WHERE program_id = ? AND beneficiary_code = ?',
          [trimmedName, programId, beneficiaryCode]
        );
      }

      // 6. Insert allergies if provided
      if (allergies && allergies.length > 0) {
        for (const allergyId of allergies) {
          await conn.query(
            'INSERT IGNORE INTO beneficiary_allergy (program_id, beneficiary_code, allergy_id) VALUES (?, ?, ?)',
            [programId, beneficiaryCode, allergyId]
          );
        }
      }

      // 7. Insert initial session_record (is_present = TRUE) with the same initial measurements
      await conn.query(
        `INSERT INTO session_record (session_id, program_id, beneficiary_code, is_present, weight_kg, height_cm, waist_cm)
         VALUES (?, ?, ?, TRUE, ?, ?, NULL)`,
        [sessionId, programId, beneficiaryCode, initialWeightKg, initialHeightCm]
      );

      // 8. Sync per-metric status row (BMI) inside the same transaction
      await syncBeneficiarySessionStatuses(conn, programId, beneficiaryCode);

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

  const cleanWeight = isPresent && weightKg != null && weightKg > 0 ? weightKg : null;
  const cleanHeight = isPresent && heightCm != null && heightCm > 0 ? heightCm : null;
  const cleanWaist = isPresent && waistCm != null && waistCm > 0 ? waistCm : null;

  try {
    return await withTransaction(async (conn) => {
      // Check if this draft session is the beneficiary's registration session (write-through invariant)
      const [benRows]: [RowDataPacket[], unknown] = await conn.query(
        'SELECT registered_session_id, initial_weight_kg, initial_height_cm FROM beneficiary WHERE program_id = ? AND beneficiary_code = ? FOR UPDATE',
        [programId, beneficiaryCode]
      );
      if (benRows.length === 0) {
        return { success: false, error: 'Beneficiary not found.' };
      }
      const ben = benRows[0] as {
        registered_session_id: string;
        initial_weight_kg: number | string;
        initial_height_cm: number | string;
      };
      const isRegistrationSession = ben.registered_session_id === sessionId;

      if (isRegistrationSession) {
        if (!isPresent || cleanWeight == null || cleanHeight == null) {
          return {
            success: false,
            error: 'Registration session records require attendance and positive weight and height values.',
          };
        }
        await conn.query(
          `UPDATE beneficiary
              SET initial_weight_kg = ?, initial_height_cm = ?
            WHERE program_id = ? AND beneficiary_code = ?`,
          [cleanWeight, cleanHeight, programId, beneficiaryCode]
        );
      }

      // 1. Upsert session_record
      await conn.query(
        `INSERT INTO session_record (session_id, program_id, beneficiary_code, is_present, weight_kg, height_cm, waist_cm)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
           is_present = VALUES(is_present),
           weight_kg = VALUES(weight_kg),
           height_cm = VALUES(height_cm),
           waist_cm = VALUES(waist_cm)`,
        [sessionId, programId, beneficiaryCode, isPresent, cleanWeight, cleanHeight, cleanWaist]
      );

      // 2. Replace survey_answer rows (clear if absent or empty)
      await conn.query(
        'DELETE FROM survey_answer WHERE session_id = ? AND program_id = ? AND beneficiary_code = ?',
        [sessionId, programId, beneficiaryCode]
      );

      if (isPresent && surveyAnswers && typeof surveyAnswers === 'object') {
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

      // 3. Upsert/delete per-metric statuses & recompute next rows' *_change
      await syncBeneficiarySessionStatuses(conn, programId, beneficiaryCode);

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

      // Upsert/delete per-metric statuses (MUAC / Edema) & recompute next rows' *_change
      await syncBeneficiarySessionStatuses(conn, programId, beneficiaryCode);

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

      // Check chronological ordering (no later session already submitted)
      const [laterRows]: [RowDataPacket[], unknown] = await conn.query(
        'SELECT session_id FROM program_session WHERE program_id = ? AND session_date > ? AND submitted_at IS NOT NULL LIMIT 1',
        [programId, session.session_date]
      );
      if (laterRows.length > 0) {
        return {
          success: false,
          error: 'Cannot submit: a later session has already been submitted. This session is skipped and locked.',
        };
      }

      // 2. Stamp submitted_at
      await conn.query(
        'UPDATE program_session SET submitted_at = ? WHERE session_id = ?',
        [submitTimestamp, sessionId]
      );

      // 3. Reconciliation pass: insert is_present = FALSE for registered beneficiaries who have no record
      await conn.query(
        `INSERT INTO session_record (session_id, program_id, beneficiary_code, is_present, weight_kg, height_cm, waist_cm)
         SELECT ?, b.program_id, b.beneficiary_code, FALSE, NULL, NULL, NULL
           FROM beneficiary b
           JOIN program_session ps_reg
             ON ps_reg.session_id = b.registered_session_id
            AND ps_reg.program_id = b.program_id
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

      revalidatePath(`/programs/${programId}`);
      revalidatePath('/');

      return {
        success: true,
        message: 'Session submitted and attendance reconciliation complete.',
      };
    });
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : 'Database error while submitting session.',
    };
  }
}
