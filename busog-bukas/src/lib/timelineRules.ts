/**
 * Timeline rules and self-check logic for Busog Bukas.
 *
 * Rules:
 * 1. 14-day rule: A Timeline starts at a session and ends at the session nearest
 *    start + 14 days (earlier session on a tie). The ending session also starts
 *    the next Timeline.
 * 2. Attribution rule: Timeline 1 owns sessions between start and end date inclusive.
 *    Timelines with seq > 1 own sessions where session_date > start_date AND session_date <= end_date.
 */

import { daysBetween } from './format';

export type RecomputedTimeline = {
  seq: number;
  start_session_id: string;
  end_session_id: string;
  start_date: string;
  end_date: string;
};

export type TimelineDbRow = {
  timeline_id: string;
  program_id: string;
  seq: number;
  start_session_id: string;
  end_session_id: string;
  closed_at: string | null;
  start_date?: string;
  end_date?: string;
};

export type TimelineCheckResult = {
  computed: RecomputedTimeline[];
  mismatches: string[];
};

export type SessionState = 'submitted' | 'skipped' | 'draft' | 'upcoming';
export type TimelineState = 'closed' | 'open' | 'upcoming';

/** Adds whole days to 'YYYY-MM-DD' in UTC to prevent timezone drifting. */
export function addDays(dateStr: string, days: number): string {
  const [y, m, d] = dateStr.slice(0, 10).split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + days));
  return dt.toISOString().slice(0, 10);
}

/**
 * Recompute Timelines from program_session dates using the 14-day rule.
 * - Timeline starts at a session.
 * - Ends at the session nearest to start + 14 days (earlier session on a tie).
 * - The ending session also starts the next Timeline.
 */
export function recomputeTimelines(
  sessions: Array<{ session_id: string; session_date: string }>
): RecomputedTimeline[] {
  const sorted = [...sessions].sort((a, b) => a.session_date.localeCompare(b.session_date));
  if (sorted.length < 2) return [];

  const result: RecomputedTimeline[] = [];
  let startIndex = 0;
  let seq = 1;

  while (startIndex < sorted.length - 1) {
    const startSession = sorted[startIndex];
    const targetDate = addDays(startSession.session_date, 14);

    let bestCandidate: { session_id: string; session_date: string } | null = null;
    let bestDist = Infinity;
    let bestIndex = -1;

    for (let i = startIndex + 1; i < sorted.length; i++) {
      const candidate = sorted[i];
      const dist = Math.abs(daysBetween(targetDate, candidate.session_date));
      // Strict `<` preserves earlier session on a tie
      if (dist < bestDist) {
        bestDist = dist;
        bestCandidate = candidate;
        bestIndex = i;
      }
    }

    if (!bestCandidate) break;

    result.push({
      seq,
      start_session_id: startSession.session_id,
      end_session_id: bestCandidate.session_id,
      start_date: startSession.session_date.slice(0, 10),
      end_date: bestCandidate.session_date.slice(0, 10),
    });

    seq++;
    // If ending session is the last session in the program, we are done
    if (bestIndex === sorted.length - 1) {
      break;
    }
    // Ending session starts next Timeline
    startIndex = bestIndex;
  }

  return result;
}

/**
 * Verifies recomputed timelines against the database `timeline` table rows.
 * Logs any mismatch using console.warn as specified in Requirement 1.
 */
export function verifyTimelinesWithDb(
  programId: string,
  sessions: Array<{ session_id: string; session_date: string }>,
  dbTimelines: TimelineDbRow[]
): TimelineCheckResult {
  const computed = recomputeTimelines(sessions);
  const mismatches: string[] = [];

  const dbBySeq = new Map<number, TimelineDbRow>(dbTimelines.map((t) => [t.seq, t]));
  const computedBySeq = new Map<number, RecomputedTimeline>(computed.map((t) => [t.seq, t]));

  if (computed.length !== dbTimelines.length) {
    const msg = `Count mismatch: DB has ${dbTimelines.length} timelines, recomputed has ${computed.length}`;
    mismatches.push(msg);
    console.warn(`[TimelineSelfCheck] Program ${programId}: ${msg}`);
  }

  const allSeqs = new Set([...dbBySeq.keys(), ...computedBySeq.keys()]);
  for (const seq of Array.from(allSeqs).sort((a, b) => a - b)) {
    const db = dbBySeq.get(seq);
    const cp = computedBySeq.get(seq);

    if (!db) {
      const msg = `Seq ${seq} exists in recomputed timelines but is missing in DB`;
      mismatches.push(msg);
      console.warn(`[TimelineSelfCheck] Program ${programId}: ${msg}`);
      continue;
    }

    if (!cp) {
      const msg = `Seq ${seq} exists in DB but not in recomputed timelines`;
      mismatches.push(msg);
      console.warn(`[TimelineSelfCheck] Program ${programId}: ${msg}`);
      continue;
    }

    if (db.start_session_id !== cp.start_session_id) {
      const msg = `Seq ${seq} start session mismatch: DB=${db.start_session_id}, computed=${cp.start_session_id}`;
      mismatches.push(msg);
      console.warn(`[TimelineSelfCheck] Program ${programId}: ${msg}`);
    }

    if (db.end_session_id !== cp.end_session_id) {
      const msg = `Seq ${seq} end session mismatch: DB=${db.end_session_id}, computed=${cp.end_session_id}`;
      mismatches.push(msg);
      console.warn(`[TimelineSelfCheck] Program ${programId}: ${msg}`);
    }
  }

  return { computed, mismatches };
}

/**
 * Data attribution:
 * Timeline 1 owns sessions between start and end date inclusive.
 * Timelines with seq > 1 own sessions where session_date > start_date AND session_date <= end_date.
 */
export function isSessionOwnedByTimeline(
  sessionDate: string,
  timelineSeq: number,
  startDate: string,
  endDate: string
): boolean {
  const d = sessionDate.slice(0, 10);
  const start = startDate.slice(0, 10);
  const end = endDate.slice(0, 10);

  if (timelineSeq === 1) {
    return d >= start && d <= end;
  }
  return d > start && d <= end;
}

/** Returns the sequence number of the Timeline that owns this session date. */
export function getOwningTimelineSeq(
  sessionDate: string,
  timelines: Array<{ seq: number; start_date: string; end_date: string }>
): number | null {
  for (const tl of timelines) {
    if (isSessionOwnedByTimeline(sessionDate, tl.seq, tl.start_date, tl.end_date)) {
      return tl.seq;
    }
  }
  return null;
}

/**
 * Checks if a session is a boundary session (ends Timeline N and starts Timeline N+1).
 */
export type BoundaryInfo = {
  isBoundary: boolean;
  endsSeq?: number;
  startsSeq?: number;
};

export function checkBoundarySession(
  sessionId: string,
  timelines: Array<{ seq: number; start_session_id: string; end_session_id: string }>
): BoundaryInfo {
  const ends = timelines.find((t) => t.end_session_id === sessionId);
  const starts = timelines.find((t) => t.start_session_id === sessionId);

  if (ends && starts && ends.seq !== starts.seq) {
    return {
      isBoundary: true,
      endsSeq: ends.seq,
      startsSeq: starts.seq,
    };
  }
  return { isBoundary: false };
}

/**
 * Computes session state badge type:
 * - Submitted: submitted_at IS NOT NULL
 * - Skipped/Locked: unsubmitted but a later session is submitted
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

/**
 * Computes Timeline state:
 * - Closed: closed_at IS NOT NULL
 * - Open: closed_at IS NULL and timeline has reached its start date or preceding timeline is closed
 * - Upcoming: closed_at IS NULL and not yet reached
 */
export function computeTimelineState(
  timeline: { seq: number; closed_at: string | null; start_date: string; end_date: string },
  allTimelines: Array<{ seq: number; closed_at: string | null; start_date: string }>,
  today: string
): TimelineState {
  if (timeline.closed_at != null) {
    return 'closed';
  }

  const prev = allTimelines.find((t) => t.seq === timeline.seq - 1);
  const prevClosed = prev ? prev.closed_at != null : true;

  if (prevClosed && today >= timeline.start_date.slice(0, 10)) {
    return 'open';
  }

  return 'upcoming';
}

export const TIMELINE_STATE_META: Record<TimelineState, { label: string; badgeClass: string }> = {
  closed: { label: 'Closed', badgeClass: 'badge-pale-neutral' },
  open: { label: 'Open', badgeClass: 'badge-pale-info' },
  upcoming: { label: 'Upcoming', badgeClass: 'badge-pale-neutral' },
};

/** Theme styling for timeline sequence colors */
export const TIMELINE_COLORS: Array<{ hex: string; bgSoft: string; borderSoft: string; badgeClass: string }> = [
  { hex: '#0d6efd', bgSoft: '#e7f1ff', borderSoft: '#9ec5fe', badgeClass: 'bg-primary text-white' },
  { hex: '#6f42c1', bgSoft: '#f2e8fc', borderSoft: '#cbb4f6', badgeClass: 'bg-indigo text-white' },
  { hex: '#087990', bgSoft: '#e0f8fc', borderSoft: '#9eeaf9', badgeClass: 'bg-info text-dark' },
  { hex: '#d63384', bgSoft: '#fcebf3', borderSoft: '#f7b0d4', badgeClass: 'bg-pink text-white' },
  { hex: '#fd7e14', bgSoft: '#fff0e6', borderSoft: '#fed1b0', badgeClass: 'bg-warning text-dark' },
  { hex: '#198754', bgSoft: '#e8f5e9', borderSoft: '#a5d6a7', badgeClass: 'bg-success text-white' },
];

export function getTimelineColor(seq: number) {
  return TIMELINE_COLORS[(seq - 1) % TIMELINE_COLORS.length];
}
