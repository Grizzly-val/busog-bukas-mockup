'use client';

import { useState, useMemo, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import type { BeneficiaryData, SessionData, TimelineData, BeneficiaryMeasurement } from '@/lib/programData';
import { formatDate } from '@/lib/format';
import { STATUS_BADGE_CLASS, STATUS_LABEL, STATUS_SEVERITY, type StatusKey } from '@/lib/statusRule';
import {
  computeFirstToLatestDelta,
  filterBeneficiariesByCriteria,
  parseMinAttendedThreshold,
  summarizeFilteredBeneficiaries,
  type FilteredBeneficiariesSummary,
} from '@/lib/beneficiarySummary';

type Props = {
  beneficiaries: BeneficiaryData[];
  today: string;
  openTimelineWarning: {
    active: boolean;
    seq: number;
    endDate: string;
    daysLeft: number;
    unmeasuredCount: number;
  } | null;
  sessions?: SessionData[];
  timelines?: TimelineData[];
};

type SortField =
  | 'code'
  | 'name'
  | 'age'
  | 'sex'
  | 'status'
  | 'bmi_optimality'
  | 'whtr_optimality'
  | 'weight_change'
  | 'waist_change'
  | 'attendance';

type SummaryFilterSnapshot = {
  statusFilter: 'all' | StatusKey | 'none';
  ageFilter: 'all' | 'minor' | 'adult';
  sexFilter: 'all' | 'female' | 'male';
  warningOnly: boolean;
  minAttendedInput: string;
};

function formatSignedDeltaWithUnit(delta: number, unit: 'kg' | 'cm', decimals = 2): string {
  const arrow = delta > 0 ? '↑ +' : delta < 0 ? '↓ ' : '→ ';
  return `${arrow}${delta.toFixed(decimals)} ${unit}`;
}

function formatSummaryMean(mean: number | null, unit: 'kg' | 'cm'): string {
  if (mean === null) return '—';
  const sign = mean > 0 ? '+' : '';
  return `${sign}${mean.toFixed(2)} ${unit}`;
}

const PAGE_SIZE = 15;

const TIMELINE_TRACK_COLORS: Record<number, string> = {
  1: '#2563eb', // Blue
  2: '#9333ea', // Purple
  3: '#0d9488', // Teal
  4: '#d97706', // Amber
  5: '#ec4899', // Pink
  6: '#10b981', // Emerald
};

function getTrackColor(seq: number): string {
  return TIMELINE_TRACK_COLORS[seq] ?? '#2563eb';
}

function formatMonthDay(dateStr: string): string {
  if (!dateStr) return '—';
  const [, m, d] = dateStr.slice(0, 10).split('-').map(Number);
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${MONTHS[m - 1]} ${d}`;
}

export default function BeneficiariesTable({
  beneficiaries,
  openTimelineWarning,
  sessions,
  timelines,
}: Props) {
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<'all' | StatusKey | 'none'>('all');
  const [ageFilter, setAgeFilter] = useState<'all' | 'minor' | 'adult'>('all');
  const [sexFilter, setSexFilter] = useState<'all' | 'female' | 'male'>('all');
  const [warningOnly, setWarningOnly] = useState(false);
  const [minAttendedInput, setMinAttendedInput] = useState('');

  // Snapshot state for "Filter, then Summarize"
  const [summarySnapshot, setSummarySnapshot] = useState<{
    summary: FilteredBeneficiariesSummary;
    filters: SummaryFilterSnapshot;
  } | null>(null);

  const [sortField, setSortField] = useState<SortField>('code');
  const [sortAsc, setSortAsc] = useState(true);
  const [page, setPage] = useState(1);

  // Client hydration flag for Portal rendering
  const [mounted, setMounted] = useState(false);
  const modalContainerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setMounted(true);
  }, []);

  // Selected beneficiary for detail modal
  const [selectedBeneficiary, setSelectedBeneficiary] = useState<BeneficiaryData | null>(null);

  // Lock parent body scroll, trap focus, and handle keyboard controls when modal is active
  useEffect(() => {
    if (!selectedBeneficiary) return;

    const originalOverflow = document.body.style.overflow;
    const originalPaddingRight = document.body.style.paddingRight;
    const scrollbarWidth = window.innerWidth - document.documentElement.clientWidth;

    document.body.style.overflow = 'hidden';
    if (scrollbarWidth > 0) {
      document.body.style.paddingRight = `${scrollbarWidth}px`;
    }

    // Shift focus into modal card so PageDown/Up, arrows, and keyboard inputs target modal
    const focusTimer = setTimeout(() => {
      modalContainerRef.current?.focus();
    }, 20);

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setSelectedBeneficiary(null);
      }
    };
    window.addEventListener('keydown', handleKeyDown);

    return () => {
      clearTimeout(focusTimer);
      document.body.style.overflow = originalOverflow === 'hidden' ? '' : originalOverflow;
      document.body.style.paddingRight = originalPaddingRight;
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [selectedBeneficiary]);

  // Map of sorted sessions to chronological session numbers (1, 2, 3...)
  const sessionChronologicalMap = useMemo(() => {
    if (!sessions) return new Map<string, { sessionNum: number; owningSeq: number; isSubmitted: boolean }>();
    const sorted = [...sessions].sort((a, b) => a.session_date.localeCompare(b.session_date));
    const map = new Map<string, { sessionNum: number; owningSeq: number; isSubmitted: boolean }>();
    sorted.forEach((s, idx) => {
      map.set(s.session_id, {
        sessionNum: idx + 1,
        owningSeq: s.owning_seq ?? 1,
        isSubmitted: s.submitted_at != null,
      });
    });
    return map;
  }, [sessions]);

  const getMeasurementMeta = (m: BeneficiaryMeasurement, idx: number) => {
    const fromMap = sessionChronologicalMap.get(m.session_id);
    if (fromMap) return fromMap;

    let owningSeq = 1;
    if (timelines) {
      for (const tl of timelines) {
        if (m.session_date >= tl.start_date && m.session_date <= tl.end_date) {
          owningSeq = tl.seq;
          break;
        }
      }
    }
    return {
      sessionNum: idx + 1,
      owningSeq,
      isSubmitted: m.submitted_at != null,
    };
  };

  // Beneficiaries matching the 5 cohort filters (ignoring the search box)
  const filterMatched = useMemo(() => {
    return filterBeneficiariesByCriteria(beneficiaries, {
      statusFilter,
      ageFilter,
      sexFilter,
      warningOnly,
      minAttendedSessions: minAttendedInput,
    });
  }, [beneficiaries, statusFilter, ageFilter, sexFilter, warningOnly, minAttendedInput]);

  // Filtered & Sorted beneficiaries for the table (applies search on top of cohort filters)
  const filtered = useMemo(() => {
    if (!search.trim()) return filterMatched;
    const q = search.toLowerCase();
    return filterMatched.filter((b) => {
      const codeMatch = b.beneficiary_code.includes(q);
      const nameMatch = b.name ? b.name.toLowerCase().includes(q) : false;
      const aliasMatch = b.alias ? b.alias.toLowerCase().includes(q) : false;
      return codeMatch || nameMatch || aliasMatch;
    });
  }, [filterMatched, search]);

  const handleSummarize = () => {
    const computed = summarizeFilteredBeneficiaries(filterMatched);
    setSummarySnapshot({
      summary: computed,
      filters: {
        statusFilter,
        ageFilter,
        sexFilter,
        warningOnly,
        minAttendedInput: minAttendedInput.trim(),
      },
    });
  };

  const isSummaryOutOfDate = useMemo(() => {
    if (!summarySnapshot) return false;
    const f = summarySnapshot.filters;
    return (
      f.statusFilter !== statusFilter ||
      f.ageFilter !== ageFilter ||
      f.sexFilter !== sexFilter ||
      f.warningOnly !== warningOnly ||
      parseMinAttendedThreshold(f.minAttendedInput) !== parseMinAttendedThreshold(minAttendedInput)
    );
  }, [summarySnapshot, statusFilter, ageFilter, sexFilter, warningOnly, minAttendedInput]);

  const appliedFilterChips = useMemo(() => {
    if (!summarySnapshot) return [];
    const f = summarySnapshot.filters;
    const chips: string[] = [];
    if (f.statusFilter !== 'all') {
      chips.push(
        `Status: ${f.statusFilter === 'none' ? 'No status yet' : STATUS_LABEL[f.statusFilter]}`
      );
    }
    if (f.ageFilter !== 'all') {
      chips.push(`Age: ${f.ageFilter === 'minor' ? 'Minors (<18)' : 'Adults (≥18)'}`);
    }
    if (f.sexFilter !== 'all') {
      chips.push(`Sex: ${f.sexFilter === 'female' ? 'Female' : 'Male'}`);
    }
    if (f.warningOnly) {
      chips.push('Needs measurement only');
    }
    const minAttended = parseMinAttendedThreshold(f.minAttendedInput);
    if (minAttended !== null) {
      chips.push(`Attended > ${minAttended} session${minAttended === 1 ? '' : 's'}`);
    }
    if (chips.length === 0) {
      chips.push('All enrolled beneficiaries (no active filters)');
    }
    return chips;
  }, [summarySnapshot]);

  const sorted = useMemo(() => {
    const list = [...filtered];
    list.sort((a, b) => {
      let cmp = 0;
      switch (sortField) {
        case 'code':
          cmp = a.beneficiary_code.localeCompare(b.beneficiary_code);
          break;
        case 'name':
          cmp = a.displayName.localeCompare(b.displayName);
          break;
        case 'age':
          cmp = a.age - b.age;
          break;
        case 'sex':
          cmp = a.sex.localeCompare(b.sex);
          break;
        case 'status': {
          const sevA = a.latest_status ? STATUS_SEVERITY[a.latest_status] : -1;
          const sevB = b.latest_status ? STATUS_SEVERITY[b.latest_status] : -1;
          cmp = sevA - sevB;
          break;
        }
        case 'bmi_optimality':
          cmp = (a.bmi_optimality ?? -999) - (b.bmi_optimality ?? -999);
          break;
        case 'whtr_optimality':
          cmp = (a.whtr_optimality ?? -999) - (b.whtr_optimality ?? -999);
          break;
        case 'weight_change':
          cmp = (a.weight_change ?? -999) - (b.weight_change ?? -999);
          break;
        case 'waist_change':
          cmp = (a.waist_change ?? -999) - (b.waist_change ?? -999);
          break;
        case 'attendance':
          cmp = a.attendance_pct - b.attendance_pct;
          break;
      }
      return sortAsc ? cmp : -cmp;
    });
    return list;
  }, [filtered, sortField, sortAsc]);

  // Pagination
  const totalPages = Math.max(1, Math.ceil(sorted.length / PAGE_SIZE));
  const currentPage = Math.min(page, totalPages);
  const pagedBeneficiaries = useMemo(() => {
    const start = (currentPage - 1) * PAGE_SIZE;
    return sorted.slice(start, start + PAGE_SIZE);
  }, [sorted, currentPage]);

  const handleSort = (field: SortField) => {
    if (sortField === field) {
      setSortAsc(!sortAsc);
    } else {
      setSortField(field);
      setSortAsc(true);
    }
    setPage(1);
  };

  const sortIndicator = (field: SortField) => {
    if (sortField !== field) return null;
    return sortAsc ? ' ↑' : ' ↓';
  };

  // Latest timeline with all submitted sessions (linked timeline for statuses)
  const linkedTimeline = useMemo(() => {
    if (!timelines || timelines.length === 0) return null;
    const fullySubmitted = timelines.filter(
      (tl) =>
        tl.state === 'closed' ||
        (tl.member_sessions.length > 0 && tl.member_sessions.every((s) => s.submitted_at != null))
    );
    if (fullySubmitted.length === 0) return null;
    return fullySubmitted.reduce(
      (latest, curr) => (curr.seq > latest.seq ? curr : latest),
      fullySubmitted[0]
    );
  }, [timelines]);

  return (
    <div className="card bb-card overflow-hidden shadow-sm">
      <div className="card-header bg-white border-bottom p-3 p-md-4">
        <div className="d-flex flex-wrap justify-content-between align-items-start gap-2 mb-3">
          <div>
            <h2 className="h5 fw-bold mb-1 text-dark">Program Beneficiaries</h2>
            <p className="text-body-secondary small mb-2">
              Profiles, latest nutritional status, overall measurement change (first to latest), and attendance since enrollment.
            </p>
            {linkedTimeline ? (
              <div className="d-inline-flex flex-wrap align-items-center gap-2 px-3 py-1 rounded-pill bg-light border small text-body-secondary">
                <span
                  className="rounded-circle d-inline-block flex-shrink-0"
                  style={{ width: '8px', height: '8px', backgroundColor: getTrackColor(linkedTimeline.seq) }}
                />
                <span>
                  Linked to <strong className="text-dark">Timeline {linkedTimeline.seq}</strong> ({formatDate(linkedTimeline.start_date)} – {formatDate(linkedTimeline.end_date)}) —{' '}
                  <span className="text-secondary">latest timeline with all submitted sessions</span>
                </span>
              </div>
            ) : (
              <div className="d-inline-flex align-items-center gap-2 px-3 py-1 rounded-pill bg-light border small text-body-secondary">
                <span>No linked timeline yet — statuses link to the latest timeline once all its sessions are submitted.</span>
              </div>
            )}
          </div>
          <span className="badge rounded-pill text-bg-light border px-3 py-2">
            Total: <strong>{beneficiaries.length}</strong> enrolled
          </span>
        </div>

        {/* Open Timeline Warning Infobox */}
        {openTimelineWarning && openTimelineWarning.active && (
          <div className="alert alert-warning border-0 p-3 mb-3 rounded-4 shadow-sm">
            <div className="d-flex flex-wrap justify-content-between align-items-center gap-2">
              <div className="d-flex align-items-center gap-3">
                <span className="fs-3">⚠️</span>
                <div>
                  <h3 className="h6 fw-bold mb-0 text-dark">
                    Open Timeline {openTimelineWarning.seq} Ending Soon
                  </h3>
                  <p className="small mb-0 text-dark-emphasis">
                    Timeline {openTimelineWarning.seq} ends on {formatDate(openTimelineWarning.endDate)}{' '}
                    ({openTimelineWarning.daysLeft} days remaining).{' '}
                    <strong>{openTimelineWarning.unmeasuredCount}</strong> beneficiaries have no qualifying
                    weight/height measurement in this Timeline yet.
                  </p>
                </div>
              </div>
              <button
                type="button"
                className={`btn btn-sm rounded-pill ${
                  warningOnly ? 'btn-dark' : 'btn-outline-dark'
                }`}
                onClick={() => {
                  setWarningOnly(!warningOnly);
                  setPage(1);
                }}
              >
                {warningOnly
                  ? 'Showing unmeasured (Clear filter)'
                  : `Filter ${openTimelineWarning.unmeasuredCount} unmeasured`}
              </button>
            </div>
          </div>
        )}

        {/* Search & Filter Toolbar */}
        <div className="d-flex flex-wrap align-items-center gap-2">
          {/* Search (does not count as a filter for Summarize) */}
          <div style={{ flex: '1 1 240px', minWidth: '210px', maxWidth: '340px' }}>
            <div className="input-group input-group-sm">
              <span className="input-group-text bg-white text-body-secondary">Search</span>
              <input
                type="text"
                className="form-control"
                placeholder="Code, name, or alias..."
                value={search}
                onChange={(e) => {
                  setSearch(e.target.value);
                  setPage(1);
                }}
              />
              {search && (
                <button
                  type="button"
                  className="btn btn-outline-secondary"
                  onClick={() => setSearch('')}
                  title="Clear search"
                >
                  ✕
                </button>
              )}
            </div>
          </div>

          {/* Status Filter */}
          <div style={{ flex: '0 0 auto', minWidth: '150px' }}>
            <select
              className="form-select form-select-sm"
              value={statusFilter}
              onChange={(e) => {
                setStatusFilter(e.target.value as typeof statusFilter);
                setPage(1);
              }}
              aria-label="Filter by nutritional status"
            >
              <option value="all">All statuses</option>
              <option value="baseline">Baseline</option>
              <option value="monitor">Monitor</option>
              <option value="monitor_closely">Monitor closely</option>
              <option value="unavailable">Unavailable</option>
              <option value="none">No status yet</option>
            </select>
          </div>

          {/* Age Filter */}
          <div style={{ flex: '0 0 auto', minWidth: '136px' }}>
            <select
              className="form-select form-select-sm"
              value={ageFilter}
              onChange={(e) => {
                setAgeFilter(e.target.value as typeof ageFilter);
                setPage(1);
              }}
              aria-label="Filter by age group"
            >
              <option value="all">All ages</option>
              <option value="minor">Minors (&lt;18)</option>
              <option value="adult">Adults (≥18)</option>
            </select>
          </div>

          {/* Sex Filter */}
          <div style={{ flex: '0 0 auto', minWidth: '122px' }}>
            <select
              className="form-select form-select-sm"
              value={sexFilter}
              onChange={(e) => {
                setSexFilter(e.target.value as typeof sexFilter);
                setPage(1);
              }}
              aria-label="Filter by sex"
            >
              <option value="all">All sexes</option>
              <option value="female">Female</option>
              <option value="male">Male</option>
            </select>
          </div>

          {/* Attended more than __ sessions (strictly greater than: attended_count > x) */}
          <div style={{ flex: '0 0 auto' }}>
            <div
              className={`d-inline-flex align-items-center gap-1 rounded-2 px-2 border ${
                minAttendedInput.trim() !== ''
                  ? 'border-dark bg-white'
                  : 'border-secondary-subtle bg-white'
              }`}
              style={{ height: '31px' }}
              title="Filter beneficiaries who attended strictly more than X sessions (attended_count > X; leave blank for no filter)"
            >
              <label
                htmlFor="beneficiary-min-attended-input"
                className="small text-body-secondary text-nowrap mb-0"
                style={{ fontSize: '0.8rem', cursor: 'pointer' }}
              >
                Attended &gt;
              </label>
              <input
                id="beneficiary-min-attended-input"
                type="number"
                min={0}
                step={1}
                className="form-control form-control-sm text-center fw-bold bb-num border-0 bg-body-secondary text-dark rounded-1 px-1 py-0"
                style={{
                  width: '54px',
                  minWidth: '54px',
                  height: '22px',
                  fontSize: '0.82rem',
                  flex: '0 0 54px',
                }}
                placeholder="any"
                aria-label="Attended more than sessions"
                value={minAttendedInput}
                onChange={(e) => {
                  setMinAttendedInput(e.target.value);
                  setPage(1);
                }}
              />
              <span
                className="small text-body-secondary text-nowrap"
                style={{ fontSize: '0.8rem' }}
              >
                sessions
              </span>
              {minAttendedInput.trim() !== '' && (
                <button
                  type="button"
                  className="btn btn-sm p-0 ms-1 text-secondary border-0 bg-transparent"
                  style={{ lineHeight: 1, fontSize: '0.75rem' }}
                  onClick={() => {
                    setMinAttendedInput('');
                    setPage(1);
                  }}
                  title="Clear attendance filter"
                  aria-label="Clear attendance filter"
                >
                  ✕
                </button>
              )}
            </div>
          </div>

          {/* Warning Toggle */}
          <div style={{ flex: '0 0 auto' }}>
            <button
              type="button"
              className={`btn btn-sm rounded-pill text-nowrap px-3 ${
                warningOnly ? 'btn-warning fw-semibold' : 'btn-outline-warning text-dark'
              }`}
              onClick={() => {
                setWarningOnly(!warningOnly);
                setPage(1);
              }}
            >
              Needs measurement
            </button>
          </div>

          {/* Summarize Button */}
          <div className="ms-md-auto" style={{ flex: '0 0 auto' }}>
            <button
              type="button"
              className={`btn btn-sm rounded-pill fw-semibold text-nowrap px-3 ${
                isSummaryOutOfDate ? 'btn-primary' : 'btn-dark'
              }`}
              onClick={handleSummarize}
              title="Summarize first-to-latest Weight, Waist, and MUAC changes across beneficiaries matching the current filters (ignores search box)"
            >
              {isSummaryOutOfDate ? 'Update Summary' : 'Summarize'}
            </button>
          </div>
        </div>

        {/* Filter, then Summarize Panel */}
        {summarySnapshot && (
          <div
            className={`mt-3 p-3 p-md-4 rounded-4 border ${
              isSummaryOutOfDate ? 'bg-warning-subtle border-warning' : 'bg-light-subtle'
            }`}
          >
            <div className="d-flex flex-wrap justify-content-between align-items-start gap-2 mb-3">
              <div>
                <div className="d-flex flex-wrap align-items-center gap-2">
                  <h3 className="h6 fw-bold mb-0 text-dark">
                    Filtered Cohort Summary (1st → Latest Measurement)
                  </h3>
                  <span className="badge rounded-pill text-bg-dark bb-num">
                    {summarySnapshot.summary.totalMatching} matching beneficiar
                    {summarySnapshot.summary.totalMatching === 1 ? 'y' : 'ies'}
                  </span>
                  {isSummaryOutOfDate ? (
                    <span className="badge rounded-pill text-bg-warning text-dark fw-semibold">
                      Out of date — filters changed
                    </span>
                  ) : (
                    <span className="badge rounded-pill bg-white text-secondary border">
                      Snapshot up to date
                    </span>
                  )}
                </div>
                <div className="d-flex flex-wrap align-items-center gap-1 mt-2">
                  <span className="small text-body-secondary me-1" style={{ fontSize: '0.75rem' }}>
                    Applied filters:
                  </span>
                  {appliedFilterChips.map((chip) => (
                    <span
                      key={chip}
                      className="badge rounded-pill bg-white text-dark border fw-medium"
                      style={{ fontSize: '0.73rem' }}
                    >
                      {chip}
                    </span>
                  ))}
                  <span
                    className="small text-body-secondary ms-1"
                    style={{ fontSize: '0.72rem' }}
                  >
                    · Search query is not applied to summary
                  </span>
                </div>
              </div>

              <div className="d-flex align-items-center gap-2">
                {isSummaryOutOfDate && (
                  <button
                    type="button"
                    className="btn btn-sm btn-primary rounded-pill fw-semibold text-nowrap px-3"
                    onClick={handleSummarize}
                  >
                    Re-compute Summary
                  </button>
                )}
                <button
                  type="button"
                  className="btn btn-sm btn-outline-secondary rounded-pill text-nowrap px-3"
                  onClick={() => setSummarySnapshot(null)}
                  aria-label="Close summary panel"
                >
                  Dismiss
                </button>
              </div>
            </div>

            {summarySnapshot.summary.smallSampleWarning && (
              <div className="alert alert-warning border-0 py-2 px-3 small mb-3 rounded-3">
                <strong>Small sample notice:</strong> Only{' '}
                <strong className="bb-num">{summarySnapshot.summary.totalMatching}</strong>{' '}
                beneficiar{summarySnapshot.summary.totalMatching === 1 ? 'y matches' : 'ies match'}{' '}
                the current filters (&lt; 5). Group averages are shown below, but interpret with caution.
              </div>
            )}

            <div className="table-responsive bg-white rounded-3 border">
              <table className="table table-sm table-borderless align-middle mb-0 small">
                <thead className="table-light border-bottom">
                  <tr
                    className="text-uppercase text-body-secondary"
                    style={{ fontSize: '0.7rem', letterSpacing: '0.03em' }}
                  >
                    <th scope="col" className="ps-3 py-2" style={{ width: '210px' }}>
                      Direction (1st → Latest)
                    </th>
                    <th scope="col" className="text-end py-2" style={{ width: '120px' }}>
                      Beneficiaries (n)
                    </th>
                    <th scope="col" className="text-end pe-3 py-2" style={{ width: '150px' }}>
                      Average Change
                    </th>
                    <th scope="col" className="ps-3 pe-3 py-2 border-start">
                      Data Coverage &amp; Unchanged Breakdown (of {summarySnapshot.summary.totalMatching} Matching)
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {[
                    summarySnapshot.summary.weight,
                    summarySnapshot.summary.waist,
                    summarySnapshot.summary.muac,
                  ].flatMap((metric) => {
                    const total = summarySnapshot.summary.totalMatching;
                    const changedCount = metric.increased.n + metric.decreased.n;
                    const changedPct = total > 0 ? (changedCount / total) * 100 : 0;
                    const unchPct = total > 0 ? (metric.unchangedCount / total) * 100 : 0;
                    const noDataPct = total > 0 ? (metric.noDataCount / total) * 100 : 0;

                    return [
                      <tr key={`${metric.key}-inc`} className="border-top">
                        <td className="ps-3 py-2 fw-semibold text-dark">
                          <span className="text-body-secondary me-1">↑</span>
                          {metric.label} increased
                        </td>
                        <td className="text-end py-2 bb-num fw-semibold text-dark">
                          {metric.increased.n}
                        </td>
                        <td className="text-end pe-3 py-2 bb-num fw-medium text-dark">
                          {formatSummaryMean(metric.increased.mean, metric.unit)}
                        </td>
                        <td
                          rowSpan={2}
                          className="ps-3 pe-3 py-2 align-middle border-start bg-light-subtle"
                        >
                          {/* Segmented Coverage Bar */}
                          {total > 0 && (
                            <div
                              className="progress mb-2 bg-white border"
                              style={{ height: '5px', borderRadius: '999px', overflow: 'hidden' }}
                            >
                              <div
                                className="progress-bar"
                                style={{ width: `${changedPct}%`, backgroundColor: '#334155' }}
                                title={`Changed (Increased or Decreased): ${changedCount}`}
                              />
                              <div
                                className="progress-bar"
                                style={{ width: `${unchPct}%`, backgroundColor: '#94a3b8' }}
                                title={`Unchanged (same value): ${metric.unchangedCount}`}
                              />
                              <div
                                className="progress-bar"
                                style={{ width: `${noDataPct}%`, backgroundColor: '#cbd5e1' }}
                                title={`No paired data (<2 measurements): ${metric.noDataCount}`}
                              />
                            </div>
                          )}

                          {/* 3-Column Plain-English Breakdown */}
                          <div className="row g-2 text-start bb-num">
                            <div className="col-12 col-sm-4">
                              <div className="p-2 rounded-2 bg-white border h-100">
                                <div className="d-flex justify-content-between align-items-baseline">
                                  <span className="text-body-secondary" style={{ fontSize: '0.72rem' }}>
                                    Changed (↑ / ↓)
                                  </span>
                                  <strong className="text-dark" style={{ fontSize: '0.85rem' }}>
                                    {changedCount}
                                  </strong>
                                </div>
                                <small
                                  className="text-body-secondary d-block"
                                  style={{ fontSize: '0.68rem' }}
                                >
                                  {metric.increased.n} increased · {metric.decreased.n} decreased
                                </small>
                              </div>
                            </div>

                            <div className="col-6 col-sm-4">
                              <div className="p-2 rounded-2 bg-white border h-100">
                                <div className="d-flex justify-content-between align-items-baseline">
                                  <span className="text-body-secondary" style={{ fontSize: '0.72rem' }}>
                                    Unchanged
                                  </span>
                                  <strong className="text-dark" style={{ fontSize: '0.85rem' }}>
                                    {metric.unchangedCount}
                                  </strong>
                                </div>
                                <small
                                  className="text-body-secondary d-block"
                                  style={{ fontSize: '0.68rem' }}
                                >
                                  Same 1st &amp; latest value
                                </small>
                              </div>
                            </div>

                            <div className="col-6 col-sm-4">
                              <div className="p-2 rounded-2 bg-white border h-100">
                                <div className="d-flex justify-content-between align-items-baseline">
                                  <span className="text-body-secondary" style={{ fontSize: '0.72rem' }}>
                                    No paired data
                                  </span>
                                  <strong className="text-dark" style={{ fontSize: '0.85rem' }}>
                                    {metric.noDataCount}
                                  </strong>
                                </div>
                                <small
                                  className="text-body-secondary d-block"
                                  style={{ fontSize: '0.68rem' }}
                                >
                                  Measured in &lt; 2 sessions
                                </small>
                              </div>
                            </div>
                          </div>
                        </td>
                      </tr>,
                      <tr key={`${metric.key}-dec`}>
                        <td className="ps-3 py-2 fw-semibold text-dark">
                          <span className="text-body-secondary me-1">↓</span>
                          {metric.label} decreased
                        </td>
                        <td className="text-end py-2 bb-num fw-semibold text-dark">
                          {metric.decreased.n}
                        </td>
                        <td className="text-end pe-3 py-2 bb-num fw-medium text-dark">
                          {formatSummaryMean(metric.decreased.mean, metric.unit)}
                        </td>
                      </tr>,
                    ];
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>

      {/* Main Beneficiaries Table (Action column removed, entire row clickable) */}
      <div className="table-responsive">
        <table className="table table-hover align-middle mb-0">
          <thead className="table-light">
            <tr className="small text-uppercase text-body-secondary">
              <th scope="col" style={{ cursor: 'pointer', width: '90px' }} onClick={() => handleSort('code')}>
                Code{sortIndicator('code')}
              </th>
              <th scope="col" style={{ cursor: 'pointer' }} onClick={() => handleSort('name')}>
                Display Name{sortIndicator('name')}
              </th>
              <th scope="col" style={{ cursor: 'pointer', width: '95px' }} onClick={() => handleSort('age')}>
                Age{sortIndicator('age')}
              </th>
              <th scope="col" style={{ cursor: 'pointer', width: '85px' }} onClick={() => handleSort('sex')}>
                Sex{sortIndicator('sex')}
              </th>
              <th
                scope="col"
                style={{ cursor: 'pointer' }}
                onClick={() => handleSort('status')}
                title={
                  linkedTimeline
                    ? `Linked to Timeline ${linkedTimeline.seq} (latest timeline with all submitted sessions)`
                    : 'Latest evaluated timeline status'
                }
              >
                Latest Status{linkedTimeline ? ` (T${linkedTimeline.seq})` : ''}
                {sortIndicator('status')}
              </th>
              <th
                scope="col"
                style={{ cursor: 'pointer', width: '125px' }}
                onClick={() => handleSort('bmi_optimality')}
                title="How much closer (+) or farther (-) BMI moved toward the optimal value (1st to latest measurement)"
              >
                BMI Optimality{sortIndicator('bmi_optimality')}
              </th>
              <th
                scope="col"
                style={{ cursor: 'pointer', width: '125px' }}
                onClick={() => handleSort('whtr_optimality')}
                title="How much closer (+) or farther (-) WHtR moved toward the 0.47 optimal value (1st to latest measurement)"
              >
                WHtR Optimality{sortIndicator('whtr_optimality')}
              </th>
              <th
                scope="col"
                style={{ cursor: 'pointer', width: '130px' }}
                onClick={() => handleSort('weight_change')}
                title="Latest valid weight (kg) minus first valid weight (kg) across present sessions"
              >
                Weight Change{sortIndicator('weight_change')}
              </th>
              <th
                scope="col"
                style={{ cursor: 'pointer', width: '130px' }}
                onClick={() => handleSort('waist_change')}
                title="Latest valid waist circumference (cm) minus first valid waist circumference (cm) across present sessions"
              >
                Waist Change{sortIndicator('waist_change')}
              </th>
              <th
                scope="col"
                style={{ cursor: 'pointer', width: '165px' }}
                onClick={() => handleSort('attendance')}
                title="Attendance across submitted sessions since the beneficiary started attending"
              >
                Attendance{sortIndicator('attendance')}
              </th>
            </tr>
          </thead>
          <tbody>
            {pagedBeneficiaries.length === 0 ? (
              <tr>
                <td colSpan={10} className="text-center py-5 text-body-secondary">
                  No beneficiaries found matching the selected filters.
                </td>
              </tr>
            ) : (
              pagedBeneficiaries.map((b) => {
                const statusBadge = b.latest_status
                  ? STATUS_BADGE_CLASS[b.latest_status]
                  : 'text-bg-secondary';
                const statusLabel = b.latest_status
                  ? STATUS_LABEL[b.latest_status]
                  : 'No status yet';

                const weightDelta = computeFirstToLatestDelta(b.measurements, 'weight_kg');
                const waistDelta = computeFirstToLatestDelta(b.measurements, 'waist_cm');

                return (
                  <tr
                    key={b.beneficiary_code}
                    onClick={() => setSelectedBeneficiary(b)}
                    role="button"
                    style={{ cursor: 'pointer' }}
                    className={b.needs_measurement_warning ? 'table-warning-subtle' : ''}
                    title="Click to view beneficiary detail modal"
                  >
                    <td>
                      <span className="fw-mono small fw-bold">#{b.beneficiary_code}</span>
                    </td>
                    <td>
                      <div>
                        {b.name ? (
                          <span className="fw-semibold text-dark">{b.name}</span>
                        ) : b.alias ? (
                          <span className="fst-italic text-body-secondary">
                            {b.alias}
                            <span className="badge rounded-pill bg-light border text-muted ms-1" style={{ fontSize: '0.65rem' }}>
                              Alias
                            </span>
                          </span>
                        ) : (
                          <span className="text-muted">—</span>
                        )}

                        {b.allergies.length > 0 && (
                          <span className="badge text-bg-danger-subtle text-danger-emphasis ms-2" style={{ fontSize: '0.65rem' }}>
                            {b.allergies.length} allerg{b.allergies.length > 1 ? 'ies' : 'y'}
                          </span>
                        )}

                        {b.needs_measurement_warning && (
                          <span className="badge text-bg-warning ms-1" style={{ fontSize: '0.65rem' }}>
                            ⚠️ Needs measurement
                          </span>
                        )}
                      </div>
                    </td>
                    <td>
                      <span>{b.age} yo</span>
                      <small className="text-body-secondary d-block" style={{ fontSize: '0.7rem' }}>
                        {b.isAdult ? 'Adult' : 'Minor'}
                      </small>
                    </td>
                    <td>
                      <span className="text-capitalize small">{b.sex}</span>
                    </td>
                    <td>
                      <div>
                        <span
                          className={`badge rounded-pill ${statusBadge}`}
                          title={b.latest_status_reason ?? undefined}
                        >
                          {statusLabel}
                        </span>
                        {b.latest_status_reason_key && (
                          <small
                            className="text-body-secondary d-block text-truncate mt-1 fw-mono"
                            style={{ fontSize: '0.68rem', maxWidth: '210px' }}
                            title={b.latest_status_reason ?? b.latest_status_reason_key}
                          >
                            key: {b.latest_status_reason_key}
                          </small>
                        )}
                      </div>
                    </td>
                    <td>
                      {b.bmi_optimality != null ? (
                        <div>
                          <span
                            className={`fw-semibold small bb-num ${
                              b.bmi_optimality > 0
                                ? 'text-success'
                                : b.bmi_optimality < 0
                                ? 'text-danger'
                                : 'text-body-secondary'
                            }`}
                            title="Movement toward (+) or away from (-) optimal BMI / Z-score (1st to latest)"
                          >
                            {b.bmi_optimality > 0 ? '↑ +' : b.bmi_optimality < 0 ? '↓ ' : '→ '}
                            {b.bmi_optimality.toFixed(2)}
                          </span>
                          <small className="text-body-secondary d-block" style={{ fontSize: '0.67rem' }}>
                            {b.bmi_optimality > 0 ? 'Closer' : b.bmi_optimality < 0 ? 'Farther' : 'Unchanged'}
                          </small>
                        </div>
                      ) : (
                        <span className="text-body-secondary">—</span>
                      )}
                    </td>
                    <td>
                      {b.whtr_optimality != null ? (
                        <div>
                          <span
                            className={`fw-semibold small bb-num ${
                              b.whtr_optimality > 0
                                ? 'text-success'
                                : b.whtr_optimality < 0
                                ? 'text-danger'
                                : 'text-body-secondary'
                            }`}
                            title="Movement toward (+) or away from (-) 0.47 optimal WHtR (1st to latest)"
                          >
                            {b.whtr_optimality > 0 ? '↑ +' : b.whtr_optimality < 0 ? '↓ ' : '→ '}
                            {b.whtr_optimality.toFixed(2)}
                          </span>
                          <small className="text-body-secondary d-block" style={{ fontSize: '0.67rem' }}>
                            {b.whtr_optimality > 0 ? 'Closer' : b.whtr_optimality < 0 ? 'Farther' : 'Unchanged'}
                          </small>
                        </div>
                      ) : (
                        <span className="text-body-secondary">—</span>
                      )}
                    </td>
                    <td>
                      {weightDelta != null ? (
                        <div>
                          <span
                            className="fw-semibold small bb-num text-secondary-emphasis"
                            title={`First: ${weightDelta.first.toFixed(2)} kg → Latest: ${weightDelta.latest.toFixed(2)} kg`}
                          >
                            {formatSignedDeltaWithUnit(weightDelta.delta, 'kg', 2)}
                          </span>
                          <small className="text-body-secondary d-block bb-num" style={{ fontSize: '0.67rem' }}>
                            {weightDelta.pctChange != null
                              ? `${weightDelta.pctChange > 0 ? '+' : ''}${weightDelta.pctChange.toFixed(1)}% · 1st → Latest`
                              : '1st → Latest'}
                          </small>
                        </div>
                      ) : (
                        <span className="text-body-secondary">—</span>
                      )}
                    </td>
                    <td>
                      {waistDelta != null ? (
                        <div>
                          <span
                            className="fw-semibold small bb-num text-secondary-emphasis"
                            title={`First: ${waistDelta.first.toFixed(2)} cm → Latest: ${waistDelta.latest.toFixed(2)} cm`}
                          >
                            {formatSignedDeltaWithUnit(waistDelta.delta, 'cm', 2)}
                          </span>
                          <small className="text-body-secondary d-block" style={{ fontSize: '0.67rem' }}>
                            1st → Latest
                          </small>
                        </div>
                      ) : (
                        <span className="text-body-secondary">—</span>
                      )}
                    </td>
                    <td>
                      <div style={{ minWidth: '140px' }}>
                        <div className="d-flex justify-content-between align-items-baseline gap-2 mb-1">
                          <span className="small text-body-secondary bb-num">
                            <strong className="text-dark fw-semibold">
                              {b.attended_count}/{b.eligible_sessions_count}
                            </strong>{' '}
                            {b.eligible_sessions_count === 1 ? 'session' : 'sessions'}
                          </span>
                          <span className="fw-semibold small bb-num text-dark">{b.attendance_pct}%</span>
                        </div>
                        <div
                          className="progress"
                          style={{ height: '5px' }}
                          role="progressbar"
                          aria-valuenow={b.attendance_pct}
                          aria-valuemin={0}
                          aria-valuemax={100}
                        >
                          <div
                            className={`progress-bar ${
                              b.attendance_pct >= 80
                                ? 'bg-success'
                                : b.attendance_pct >= 60
                                ? 'bg-warning'
                                : 'bg-danger'
                            }`}
                            style={{ width: `${b.attendance_pct}%` }}
                          />
                        </div>
                      </div>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      {/* Pagination Footer */}
      <div className="card-footer bg-white border-top p-3 d-flex flex-wrap justify-content-between align-items-center gap-2">
        <span className="small text-body-secondary">
          Showing {sorted.length === 0 ? 0 : (currentPage - 1) * PAGE_SIZE + 1}–
          {Math.min(currentPage * PAGE_SIZE, sorted.length)} of {sorted.length} beneficiaries
        </span>

        {totalPages > 1 && (
          <nav aria-label="Beneficiary pages">
            <ul className="pagination pagination-sm mb-0">
              <li className={`page-item ${currentPage === 1 ? 'disabled' : ''}`}>
                <button className="page-link" onClick={() => setPage(currentPage - 1)}>
                  Previous
                </button>
              </li>
              {Array.from({ length: totalPages }, (_, i) => i + 1).map((p) => (
                <li key={p} className={`page-item ${p === currentPage ? 'active' : ''}`}>
                  <button className="page-link" onClick={() => setPage(p)}>
                    {p}
                  </button>
                </li>
              ))}
              <li className={`page-item ${currentPage === totalPages ? 'disabled' : ''}`}>
                <button className="page-link" onClick={() => setPage(currentPage + 1)}>
                  Next
                </button>
              </li>
            </ul>
          </nav>
        )}
      </div>

      {/* Read-only Beneficiary Detail Modal (Upgraded to modal-xl with Timeline Track, Edema, & Isolated Stacking) */}
      {mounted && selectedBeneficiary && createPortal(
        <div
          ref={modalContainerRef}
          className="modal show d-block"
          tabIndex={-1}
          role="dialog"
          aria-modal="true"
          aria-labelledby="beneficiaryModalTitle"
          style={{
            backgroundColor: 'rgba(0,0,0,0.65)',
            backdropFilter: 'blur(6px)',
            WebkitBackdropFilter: 'blur(6px)',
            zIndex: 1055,
            overscrollBehavior: 'contain',
            outline: 'none',
          }}
          onClick={() => setSelectedBeneficiary(null)}
        >
          <div
            className="modal-dialog modal-dialog-centered modal-xl modal-dialog-scrollable"
            style={{ maxWidth: '1140px', width: '92vw', overscrollBehavior: 'contain' }}
            role="document"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="modal-content rounded-4 border-0 shadow-lg" style={{ overscrollBehavior: 'contain' }}>
              <div className="modal-header border-bottom p-3 p-md-4">
                <div>
                  <h3 id="beneficiaryModalTitle" className="modal-title h5 fw-bold mb-0 text-dark">
                    Beneficiary #{selectedBeneficiary.beneficiary_code}
                  </h3>
                  <p className="text-body-secondary small mb-0">
                    {selectedBeneficiary.displayName}{' '}
                    {!selectedBeneficiary.name && selectedBeneficiary.alias && '(Alias)'}
                  </p>
                </div>
                <button
                  type="button"
                  className="btn-close"
                  aria-label="Close"
                  onClick={() => setSelectedBeneficiary(null)}
                />
              </div>

              <div className="modal-body p-3 p-md-4" style={{ overscrollBehavior: 'contain' }}>
                {/* Demographics & Guardian Details */}
                <div className="row g-3 mb-4">
                  <div className="col-12 col-md-6">
                    <div className="bg-light rounded-4 p-3 h-100 border">
                      <h4 className="h6 text-uppercase text-body-secondary small fw-bold mb-2">
                        Profile &amp; Demographics
                      </h4>
                      <dl className="row mb-0 small">
                        <dt className="col-5 text-body-secondary">Code:</dt>
                        <dd className="col-7 fw-mono">#{selectedBeneficiary.beneficiary_code}</dd>

                        <dt className="col-5 text-body-secondary">Full Name:</dt>
                        <dd className="col-7">{selectedBeneficiary.name ?? <em className="text-muted">Not consented (Alias used)</em>}</dd>

                        <dt className="col-5 text-body-secondary">Alias:</dt>
                        <dd className="col-7">{selectedBeneficiary.alias ?? '—'}</dd>

                        <dt className="col-5 text-body-secondary">Sex:</dt>
                        <dd className="col-7 text-capitalize">{selectedBeneficiary.sex}</dd>

                        <dt className="col-5 text-body-secondary">Age / Category:</dt>
                        <dd className="col-7">{selectedBeneficiary.age} yo ({selectedBeneficiary.isAdult ? 'Adult' : 'Minor'})</dd>

                        <dt className="col-5 text-body-secondary">Birth Date:</dt>
                        <dd className="col-7">{selectedBeneficiary.birth_month}/{selectedBeneficiary.birth_year}</dd>

                        <dt className="col-5 text-body-secondary">Registered:</dt>
                        <dd className="col-7">{formatDate(selectedBeneficiary.registered_session_date)}</dd>

                        <dt className="col-5 text-body-secondary">Attendance:</dt>
                        <dd className="col-7 bb-num">
                          <strong>
                            {selectedBeneficiary.attended_count}/{selectedBeneficiary.eligible_sessions_count}
                          </strong>{' '}
                          {selectedBeneficiary.eligible_sessions_count === 1 ? 'session' : 'sessions'} (
                          {selectedBeneficiary.attendance_pct}%)
                        </dd>
                      </dl>
                    </div>
                  </div>

                  <div className="col-12 col-md-6">
                    <div className="bg-light rounded-4 p-3 h-100 border">
                      <h4 className="h6 text-uppercase text-body-secondary small fw-bold mb-2">
                        Consent &amp; Guardians
                      </h4>
                      {selectedBeneficiary.isAdult ? (
                        <div className="alert alert-info border-0 p-2 small mb-0">
                          <span className="badge text-bg-primary me-1">Adult</span>
                          Adults provide self-consent; guardian records are not required.
                        </div>
                      ) : selectedBeneficiary.guardians.length > 0 ? (
                        selectedBeneficiary.guardians.map((g, idx) => (
                          <dl key={idx} className="row mb-0 small">
                            <dt className="col-5 text-body-secondary">Guardian:</dt>
                            <dd className="col-7 fw-semibold">{g.name}</dd>

                            <dt className="col-5 text-body-secondary">Relationship:</dt>
                            <dd className="col-7 text-capitalize">{g.relationship}</dd>

                            <dt className="col-5 text-body-secondary">Contact Number:</dt>
                            <dd className="col-7">{g.number}</dd>
                          </dl>
                        ))
                      ) : (
                        <div className="alert alert-warning border-0 p-2 small mb-0">
                          ⚠️ No guardian consent record on file for this minor.
                        </div>
                      )}

                      {/* Allergies */}
                      <h4 className="h6 text-uppercase text-body-secondary small fw-bold mt-3 mb-2">
                        Allergies
                      </h4>
                      {selectedBeneficiary.allergies.length > 0 ? (
                        <div className="d-flex flex-wrap gap-1">
                          {selectedBeneficiary.allergies.map((a) => (
                            <span key={a} className="badge rounded-pill text-bg-danger-subtle text-danger-emphasis">
                              🚫 {a}
                            </span>
                          ))}
                        </div>
                      ) : (
                        <span className="small text-body-secondary">No recorded allergies.</span>
                      )}
                    </div>
                  </div>
                </div>

                {/* Nutritional Status & Deltas */}
                <div className="bg-light-subtle rounded-4 p-3 border mb-4">
                  <div className="d-flex flex-wrap justify-content-between align-items-center gap-2 mb-2">
                    <h4 className="h6 text-uppercase text-body-secondary small fw-bold mb-0">
                      Latest Nutritional Status &amp; Changes
                    </h4>
                    {selectedBeneficiary.latest_status_timeline_seq != null && (
                      <span className="badge rounded-pill bg-light text-secondary border" style={{ fontSize: '0.7rem' }}>
                        Evaluated at Timeline {selectedBeneficiary.latest_status_timeline_seq}
                      </span>
                    )}
                  </div>
                  {(() => {
                    const modalWeightDelta = computeFirstToLatestDelta(
                      selectedBeneficiary.measurements,
                      'weight_kg'
                    );
                    const modalWaistDelta = computeFirstToLatestDelta(
                      selectedBeneficiary.measurements,
                      'waist_cm'
                    );
                    const modalMuacDelta = computeFirstToLatestDelta(
                      selectedBeneficiary.measurements,
                      'muac_cm'
                    );

                    return (
                      <div className="row row-cols-2 row-cols-md-3 row-cols-xl-6 g-3 align-items-center">
                        <div className="col">
                          <span className="small text-body-secondary d-block">Status:</span>
                          <span
                            className={`badge rounded-pill ${
                              selectedBeneficiary.latest_status
                                ? STATUS_BADGE_CLASS[selectedBeneficiary.latest_status]
                                : 'text-bg-secondary'
                            }`}
                            title={selectedBeneficiary.latest_status_reason ?? undefined}
                          >
                            {selectedBeneficiary.latest_status
                              ? STATUS_LABEL[selectedBeneficiary.latest_status]
                              : 'No status yet'}
                          </span>
                        </div>

                        <div className="col">
                          <span
                            className="small text-body-secondary d-block"
                            title="Movement toward (+) or away from (-) the optimal BMI / Z-score (1st to latest)"
                          >
                            BMI Optimality (1st → Latest):
                          </span>
                          <strong
                            className={`small bb-num ${
                              selectedBeneficiary.bmi_optimality != null
                                ? selectedBeneficiary.bmi_optimality > 0
                                  ? 'text-success'
                                  : selectedBeneficiary.bmi_optimality < 0
                                  ? 'text-danger'
                                  : 'text-dark'
                                : 'text-dark'
                            }`}
                          >
                            {selectedBeneficiary.bmi_optimality != null
                              ? `${selectedBeneficiary.bmi_optimality > 0 ? '+' : ''}${selectedBeneficiary.bmi_optimality.toFixed(2)} (${
                                  selectedBeneficiary.bmi_optimality > 0
                                    ? 'Closer'
                                    : selectedBeneficiary.bmi_optimality < 0
                                    ? 'Farther'
                                    : 'Same'
                                })`
                              : '—'}
                          </strong>
                        </div>

                        <div className="col">
                          <span
                            className="small text-body-secondary d-block"
                            title="Movement toward (+) or away from (-) the 0.47 optimal WHtR (1st to latest)"
                          >
                            WHtR Optimality (1st → Latest):
                          </span>
                          <strong
                            className={`small bb-num ${
                              selectedBeneficiary.whtr_optimality != null
                                ? selectedBeneficiary.whtr_optimality > 0
                                  ? 'text-success'
                                  : selectedBeneficiary.whtr_optimality < 0
                                  ? 'text-danger'
                                  : 'text-dark'
                                : 'text-dark'
                            }`}
                          >
                            {selectedBeneficiary.whtr_optimality != null
                              ? `${selectedBeneficiary.whtr_optimality > 0 ? '+' : ''}${selectedBeneficiary.whtr_optimality.toFixed(2)} (${
                                  selectedBeneficiary.whtr_optimality > 0
                                    ? 'Closer'
                                    : selectedBeneficiary.whtr_optimality < 0
                                    ? 'Farther'
                                    : 'Same'
                                })`
                              : '—'}
                          </strong>
                        </div>

                        <div className="col">
                          <span
                            className="small text-body-secondary d-block"
                            title="Latest valid weight (kg) minus first valid weight (kg) across present sessions"
                          >
                            Weight Change (1st → Latest):
                          </span>
                          <strong className="small bb-num text-secondary-emphasis">
                            {modalWeightDelta != null
                              ? `${formatSignedDeltaWithUnit(modalWeightDelta.delta, 'kg', 2)}${
                                  modalWeightDelta.pctChange != null
                                    ? ` (${modalWeightDelta.pctChange > 0 ? '+' : ''}${modalWeightDelta.pctChange.toFixed(1)}%)`
                                    : ''
                                }`
                              : '—'}
                          </strong>
                        </div>

                        <div className="col">
                          <span
                            className="small text-body-secondary d-block"
                            title="Latest valid waist circumference (cm) minus first valid waist circumference (cm) across present sessions"
                          >
                            Waist Change (1st → Latest):
                          </span>
                          <strong className="small bb-num text-secondary-emphasis">
                            {modalWaistDelta != null
                              ? formatSignedDeltaWithUnit(modalWaistDelta.delta, 'cm', 2)
                              : '—'}
                          </strong>
                        </div>

                        <div className="col">
                          <span
                            className="small text-body-secondary d-block"
                            title="Latest valid MUAC (cm) minus first valid MUAC (cm) across present sessions"
                          >
                            MUAC Change (1st → Latest):
                          </span>
                          <strong className="small bb-num text-secondary-emphasis">
                            {modalMuacDelta != null
                              ? formatSignedDeltaWithUnit(modalMuacDelta.delta, 'cm', 1)
                              : '—'}
                          </strong>
                        </div>
                      </div>
                    );
                  })()}

                  {selectedBeneficiary.latest_status_reason && (
                    <div className="mt-3 pt-2 border-top d-flex flex-wrap align-items-center gap-2">
                      <span className="small text-body-secondary fw-semibold" style={{ fontSize: '0.75rem' }}>
                        Status Reason:
                      </span>
                      {selectedBeneficiary.latest_status_reason_key && (
                        <span className="badge rounded-pill bg-light text-dark border fw-mono" style={{ fontSize: '0.72rem' }}>
                          {selectedBeneficiary.latest_status_reason_key}
                        </span>
                      )}
                      <span className="small text-dark fw-medium" style={{ fontSize: '0.8rem' }}>
                        {selectedBeneficiary.latest_status_reason}
                      </span>
                    </div>
                  )}
                </div>

                {/* Measurement & Attendance History Table with Timeline Track & Edema */}
                <div>
                  <div className="d-flex flex-wrap justify-content-between align-items-center gap-2 mb-2">
                    <h4 className="h6 text-uppercase text-body-secondary small fw-bold mb-0">
                      Measurement &amp; Attendance History
                    </h4>

                    {/* Inline Color Legend for Timelines */}
                    <div className="d-flex flex-wrap align-items-center gap-3 small">
                      <span className="text-body-secondary fw-semibold" style={{ fontSize: '0.72rem' }}>
                        Timeline Track:
                      </span>
                      {(timelines && timelines.length > 0 ? timelines : [{ seq: 1 }, { seq: 2 }]).map((t) => (
                        <span key={t.seq} className="d-inline-flex align-items-center gap-1" style={{ fontSize: '0.72rem' }}>
                          <span
                            className="rounded-circle d-inline-block"
                            style={{ width: '8px', height: '8px', backgroundColor: getTrackColor(t.seq) }}
                          />
                          <span className="fw-medium text-dark">Timeline {t.seq}</span>
                        </span>
                      ))}
                    </div>
                  </div>

                  {selectedBeneficiary.measurements.length === 0 ? (
                    <p className="small text-body-secondary mb-0">No session measurements on record.</p>
                  ) : (
                    <div className="table-responsive border rounded-3 overflow-hidden">
                      <table className="table table-sm table-bordered align-middle small mb-0">
                        <thead className="table-light">
                          <tr className="text-secondary small">
                            <th className="text-center align-middle" style={{ width: '56px' }}>⏳</th>
                            <th className="text-center align-middle" style={{ width: '56px' }}>📝</th>
                            <th style={{ minWidth: '100px' }}>Date</th>
                            <th style={{ minWidth: '85px' }}>Status</th>
                            <th className="text-end" style={{ minWidth: '90px' }}>Weight (kg)</th>
                            <th className="text-end" style={{ minWidth: '90px' }}>Height (cm)</th>
                            <th className="text-end" style={{ minWidth: '90px' }}>Waist (cm)</th>
                            <th className="text-end" style={{ minWidth: '70px' }}>BMI</th>
                            <th className="text-end" style={{ minWidth: '90px' }}>MUAC (cm)</th>
                            <th className="text-center" style={{ minWidth: '75px' }}>Edema</th>
                            <th>Notes</th>
                          </tr>
                        </thead>
                        <tbody>
                          {selectedBeneficiary.measurements.map((m, idx) => {
                            const meta = getMeasurementMeta(m, idx);
                            const currSeq = meta.owningSeq;
                            const prevSeq =
                              idx > 0
                                ? getMeasurementMeta(selectedBeneficiary.measurements[idx - 1], idx - 1).owningSeq
                                : null;
                            const isNewTimeline = idx === 0 || prevSeq !== currSeq;
                            const currColor = getTrackColor(currSeq);
                            const prevColor = prevSeq != null ? getTrackColor(prevSeq) : currColor;
                            const isFirstRow = idx === 0;
                            const isLastRow = idx === selectedBeneficiary.measurements.length - 1;
                            const isSubmitted = meta.isSubmitted;

                            return (
                              <tr key={m.session_id}>
                                {/* Column 1: Timeline Track */}
                                <td
                                  className="position-relative text-center align-middle p-0"
                                  style={{ width: '56px', height: '52px' }}
                                >
                                  {/* Top half connector line */}
                                  {!isFirstRow && (
                                    <div
                                      className="position-absolute start-50 translate-middle-x"
                                      style={{
                                        width: '4px',
                                        top: 0,
                                        height: '50%',
                                        backgroundColor: isNewTimeline ? prevColor : currColor,
                                        zIndex: 1,
                                      }}
                                    />
                                  )}

                                  {/* Bottom half connector line */}
                                  {!isLastRow && (
                                    <div
                                      className="position-absolute start-50 translate-middle-x"
                                      style={{
                                        width: '4px',
                                        top: '50%',
                                        bottom: 0,
                                        backgroundColor: currColor,
                                        zIndex: 1,
                                      }}
                                    />
                                  )}

                                  {/* Node badge or dot */}
                                  {isNewTimeline ? (
                                    <span
                                      className="position-relative d-inline-flex align-items-center justify-content-center rounded-circle text-white fw-bold shadow-sm"
                                      style={{
                                        width: '28px',
                                        height: '28px',
                                        backgroundColor: currColor,
                                        zIndex: 2,
                                        fontSize: '0.8rem',
                                      }}
                                      title={`Timeline ${currSeq}`}
                                    >
                                      {currSeq}
                                    </span>
                                  ) : (
                                    <span
                                      className="position-relative d-inline-block rounded-circle"
                                      style={{
                                        width: '12px',
                                        height: '12px',
                                        backgroundColor: isSubmitted ? currColor : '#ffffff',
                                        border: `2px solid ${currColor}`,
                                        zIndex: 2,
                                      }}
                                      title={`Session ${meta.sessionNum} (Timeline ${currSeq})`}
                                    />
                                  )}
                                </td>

                                {/* Column 2: Session # */}
                                <td className="text-center align-middle fw-semibold bb-num" style={{ width: '56px' }}>
                                  {meta.sessionNum}
                                </td>

                                {/* Column 3: Date */}
                                <td className="align-middle text-nowrap">
                                  <span className="me-1" aria-hidden="true">📅</span>
                                  <span className="fw-semibold">{formatMonthDay(m.session_date)}</span>
                                </td>

                                {/* Column 4: Status */}
                                <td className="align-middle">
                                  {m.is_present ? (
                                    <span className="badge rounded-pill badge-pale-success">Present</span>
                                  ) : (
                                    <span className="badge rounded-pill badge-pale-neutral">Absent</span>
                                  )}
                                </td>

                                {/* Column 5: Weight */}
                                <td className="text-end align-middle bb-num">
                                  {m.weight_kg != null ? `${m.weight_kg.toFixed(1)}` : '—'}
                                </td>

                                {/* Column 6: Height */}
                                <td className="text-end align-middle bb-num">
                                  {m.height_cm != null ? `${m.height_cm.toFixed(1)}` : '—'}
                                </td>

                                {/* Column 7: Waist */}
                                <td className="text-end align-middle bb-num">
                                  {m.waist_cm != null ? `${m.waist_cm.toFixed(1)}` : '—'}
                                </td>

                                {/* Column 8: BMI */}
                                <td className="text-end align-middle bb-num fw-semibold">
                                  {m.bmi != null ? m.bmi.toFixed(1) : '—'}
                                </td>

                                {/* Column 9: MUAC */}
                                <td className="text-end align-middle bb-num">
                                  {m.muac_cm != null ? `${m.muac_cm.toFixed(1)}` : '—'}
                                </td>

                                {/* Column 10: Edema */}
                                <td className="text-center align-middle">
                                  {m.edema === true ? (
                                    <span className="badge rounded-pill badge-pale-danger">Yes</span>
                                  ) : m.edema === false ? (
                                    <span className="badge rounded-pill badge-pale-success">No</span>
                                  ) : (
                                    <span className="text-body-secondary">—</span>
                                  )}
                                </td>

                                {/* Column 11: Notes */}
                                <td className="align-middle">
                                  {m.clinical_notes ? (
                                    <span className="small text-dark" title={m.clinical_notes}>
                                      {m.clinical_notes}
                                    </span>
                                  ) : (
                                    <span className="text-body-secondary">—</span>
                                  )}
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              </div>

              <div className="modal-footer border-top p-3 d-flex justify-content-between">
                <small className="text-body-secondary">
                  🔒 Read-only modal view. Edits will be enabled in subsequent stages.
                </small>
                <button
                  type="button"
                  className="btn btn-secondary rounded-pill px-4"
                  onClick={() => setSelectedBeneficiary(null)}
                >
                  Close
                </button>
              </div>
            </div>
          </div>
        </div>,
        document.body
      )}
    </div>
  );
}
