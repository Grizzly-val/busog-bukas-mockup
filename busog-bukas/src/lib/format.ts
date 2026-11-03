/** Small display helpers shared by server components. */

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** 'YYYY-MM-DD' (or 'YYYY-MM-DD hh:mm:ss') → 'Oct 15, 2026'. Parsed by hand, so no timezone surprises. */
export function formatDate(value: string | null | undefined): string {
  if (!value) return '—';
  const [y, m, d] = value.slice(0, 10).split('-').map(Number);
  return `${MONTHS[m - 1]} ${d}, ${y}`;
}

/** Whole days from `a` to `b` (both 'YYYY-MM-DD'). */
export function daysBetween(a: string, b: string): number {
  const ms = Date.parse(`${b.slice(0, 10)}T00:00:00Z`) - Date.parse(`${a.slice(0, 10)}T00:00:00Z`);
  return Math.round(ms / 86_400_000);
}

/** 'Barangay Poblacion Social Welfare Office' → 'BP'. */
export function initials(name: string): string {
  const words = name.split(/\s+/).filter((w) => /^[A-Za-z]/.test(w) && w.length > 2);
  const picked = (words.length ? words : name.split(/\s+/)).slice(0, 2);
  return picked.map((w) => w[0]!.toUpperCase()).join('');
}

export type ProgramPhase = 'upcoming' | 'ongoing' | 'completed';

/** Program phase relative to the mock "today". */
export function programPhase(startDate: string, endDate: string, today: string): ProgramPhase {
  if (today < startDate.slice(0, 10)) return 'upcoming';
  if (today > endDate.slice(0, 10)) return 'completed';
  return 'ongoing';
}

export const PHASE_BADGE: Record<ProgramPhase, { label: string; className: string }> = {
  upcoming: { label: 'Upcoming', className: 'text-bg-info' },
  ongoing: { label: 'Ongoing', className: 'text-bg-success' },
  completed: { label: 'Completed', className: 'text-bg-secondary' },
};
