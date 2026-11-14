/**
 * Session state and Program Week (Sun–Sat) rules for Busog Bukas.
 * Replaces the legacy 14-day Timeline helpers cleanly.
 */

export type SessionState = 'submitted' | 'skipped' | 'draft' | 'upcoming';
export type WeekState = 'completed' | 'current' | 'upcoming';

/** Adds whole days to 'YYYY-MM-DD' in UTC to prevent timezone drifting. */
export function addDays(dateStr: string, days: number): string {
  const [y, m, d] = dateStr.slice(0, 10).split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + days));
  return dt.toISOString().slice(0, 10);
}

/**
 * Generates Sun–Sat program weeks matching `generate_program_weeks` in 01_init_schema.sql:
 *   - Week 1 = startDate .. that week's Saturday (capped at endDate)
 *   - Week 2+ = Sunday .. Saturday (last week capped at endDate)
 */
export function generateProgramWeeksPure(
  startDate: string,
  endDate: string
): Array<{ week_number: number; week_start_date: string; week_end_date: string }> {
  const start = startDate.slice(0, 10);
  const end = endDate.slice(0, 10);
  if (!start || !end || start > end) return [];

  const result: Array<{ week_number: number; week_start_date: string; week_end_date: string }> = [];
  let cursor = start;
  let weekNumber = 1;

  while (cursor <= end) {
    const [y, m, d] = cursor.split('-').map(Number);
    const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay(); // 0=Sun..6=Sat
    const daysToSaturday = 6 - dow;
    const rawEnd = addDays(cursor, daysToSaturday);
    const weekEnd = rawEnd > end ? end : rawEnd;

    result.push({
      week_number: weekNumber,
      week_start_date: cursor,
      week_end_date: weekEnd,
    });

    weekNumber++;
    cursor = addDays(weekEnd, 1);
  }

  return result;
}

/**
 * Computes Session state:
 * - Submitted: submitted_at IS NOT NULL
 * - Skipped: submitted_at IS NULL AND a strictly later session has submitted_at IS NOT NULL
 * - Draft: unsubmitted with records > 0
 * - Upcoming: unsubmitted with 0 records
 */
export function computeSessionState(
  session: { session_id: string; session_date: string; submitted_at: string | null; record_count: number },
  allSessions: Array<{ session_date: string; submitted_at: string | null }>
): SessionState {
  if (session.submitted_at != null) {
    return 'submitted';
  }

  const sDate = session.session_date.slice(0, 10);
  const isLaterSubmitted = allSessions.some(
    (s) => s.session_date.slice(0, 10) > sDate && s.submitted_at != null
  );

  if (isLaterSubmitted) {
    return 'skipped';
  }

  if (session.record_count > 0) {
    return 'draft';
  }

  return 'upcoming';
}

export const SESSION_STATE_META: Record<
  SessionState,
  { label: string; badgeClass: string; dotClass: string; description: string }
> = {
  submitted: {
    label: 'Submitted',
    badgeClass: 'badge-pale-success',
    dotClass: 'bg-success',
    description: 'Session completed and submitted',
  },
  skipped: {
    label: 'Skipped / Locked',
    badgeClass: 'badge-pale-neutral',
    dotClass: 'bg-secondary',
    description: 'Unsubmitted but subsequent session submitted',
  },
  draft: {
    label: 'Draft',
    badgeClass: 'badge-pale-warning',
    dotClass: 'bg-warning',
    description: 'Contains unsubmitted records',
  },
  upcoming: {
    label: 'Upcoming',
    badgeClass: 'badge-pale-neutral',
    dotClass: 'bg-secondary-subtle',
    description: 'Scheduled session with no records',
  },
};

export function computeWeekState(
  week: { week_start_date: string; week_end_date: string; submitted_session_count: number; session_count: number },
  today: string
): WeekState {
  const todayStr = today.slice(0, 10);
  const startStr = week.week_start_date.slice(0, 10);
  const endStr = week.week_end_date.slice(0, 10);

  if (todayStr < startStr) {
    return 'upcoming';
  }
  if (
    week.session_count > 0 &&
    week.submitted_session_count === week.session_count &&
    todayStr > endStr
  ) {
    return 'completed';
  }
  if (todayStr > endStr && week.submitted_session_count > 0) {
    return 'completed';
  }
  if (todayStr >= startStr && todayStr <= endStr) {
    return 'current';
  }
  return week.submitted_session_count > 0 ? 'completed' : 'upcoming';
}

export const WEEK_STATE_META: Record<WeekState, { label: string; badgeClass: string }> = {
  completed: { label: 'Completed', badgeClass: 'badge-pale-success' },
  current: { label: 'Current week', badgeClass: 'badge-pale-info' },
  upcoming: { label: 'Upcoming', badgeClass: 'badge-pale-neutral' },
};

/** Soft color rotation for Week badges on the calendar and week selector. */
export const WEEK_COLORS: Array<{ hex: string; bgSoft: string; borderSoft: string; badgeClass: string }> = [
  { hex: '#0d6efd', bgSoft: '#e7f1ff', borderSoft: '#9ec5fe', badgeClass: 'bg-primary text-white' },
  { hex: '#087990', bgSoft: '#e0f8fc', borderSoft: '#9eeaf9', badgeClass: 'bg-info text-dark' },
  { hex: '#6f42c1', bgSoft: '#f2e8fc', borderSoft: '#cbb4f6', badgeClass: 'bg-indigo text-white' },
  { hex: '#198754', bgSoft: '#e8f5e9', borderSoft: '#a5d6a7', badgeClass: 'bg-success text-white' },
  { hex: '#fd7e14', bgSoft: '#fff0e6', borderSoft: '#fed1b0', badgeClass: 'bg-warning text-dark' },
  { hex: '#d63384', bgSoft: '#fcebf3', borderSoft: '#f7b0d4', badgeClass: 'bg-pink text-white' },
];

export function getWeekColor(weekNumber: number) {
  const idx = Math.max(0, weekNumber - 1) % WEEK_COLORS.length;
  return WEEK_COLORS[idx];
}
