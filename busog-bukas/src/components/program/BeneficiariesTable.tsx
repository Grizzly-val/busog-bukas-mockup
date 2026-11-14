'use client';

import { useState, useMemo, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import type { BeneficiaryData, SessionData, ProgramWeekData, BeneficiaryMeasurement } from '@/lib/programData';
import { formatDate } from '@/lib/format';
import {
  ALL_METRICS,
  HEIGHT_NOTICE_MESSAGE,
  METRIC_LABEL,
  STATUS_BADGE_CLASS,
  STATUS_LABEL,
  type StatusKey,
} from '@/lib/statusRule';
import { getWeekColor } from '@/lib/timelineRules';
import {
  computeFirstToLatestDelta,
  filterBeneficiariesByCriteria,
  parseMinAttendedThreshold,
  summarizeFilteredBeneficiaries,
  type FilteredBeneficiariesSummary,
} from '@/lib/beneficiarySummary';

type Props = {
  beneficiaries: BeneficiaryData[];
  hasNutritionist?: boolean;
  today: string;
  sessions?: SessionData[];
  weeks?: ProgramWeekData[];
};

type SortField =
  | 'code'
  | 'name'
  | 'age'
  | 'sex'
  | 'bmi_optimality'
  | 'whtr_optimality'
  | 'weight_change'
  | 'waist_change'
  | 'attendance';

type SummaryFilterSnapshot = {
  statusFilter: 'all' | StatusKey | 'none';
  ageFilter: 'all' | 'minor' | 'adult';
  sexFilter: 'all' | 'female' | 'male';
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

function formatMonthDay(dateStr: string): string {
  if (!dateStr) return '—';
  const [, m, d] = dateStr.slice(0, 10).split('-').map(Number);
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${MONTHS[m - 1]} ${d}`;
}

export default function BeneficiariesTable({
  beneficiaries,
  hasNutritionist,
  sessions,
  weeks,
}: Props) {
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<'all' | StatusKey | 'none'>('all');
  const [ageFilter, setAgeFilter] = useState<'all' | 'minor' | 'adult'>('all');
  const [sexFilter, setSexFilter] = useState<'all' | 'female' | 'male'>('all');
  const [minAttendedInput, setMinAttendedInput] = useState('');

  // Snapshot state + modal open state for "Filter, then Summarize"
  const [isSummaryModalOpen, setIsSummaryModalOpen] = useState(false);
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
  const summaryModalRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setMounted(true);
  }, []);

  // Selected beneficiary for detail modal
  const [selectedBeneficiary, setSelectedBeneficiary] = useState<BeneficiaryData | null>(null);

  const showMuacSummary = useMemo(
    () =>
      hasNutritionist ??
      beneficiaries.some(
        (b) => b.latest_statuses.muac != null || b.measurements.some((m) => m.muac_cm != null)
      ),
    [hasNutritionist, beneficiaries]
  );

  // Lock parent body scroll and handle Escape key when either modal is active
  useEffect(() => {
    const activeDialog = selectedBeneficiary || isSummaryModalOpen;
    if (!activeDialog) return;

    const originalOverflow = document.body.style.overflow;
    const originalPaddingRight = document.body.style.paddingRight;
    const scrollbarWidth = window.innerWidth - document.documentElement.clientWidth;

    document.body.style.overflow = 'hidden';
    if (scrollbarWidth > 0) {
      document.body.style.paddingRight = `${scrollbarWidth}px`;
    }

    const focusTimer = setTimeout(() => {
      if (selectedBeneficiary) {
        modalContainerRef.current?.focus();
      } else if (isSummaryModalOpen) {
        summaryModalRef.current?.focus();
      }
    }, 20);

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (selectedBeneficiary) {
          setSelectedBeneficiary(null);
        } else if (isSummaryModalOpen) {
          setIsSummaryModalOpen(false);
        }
      }
    };
    window.addEventListener('keydown', handleKeyDown);

    return () => {
      clearTimeout(focusTimer);
      document.body.style.overflow = originalOverflow === 'hidden' ? '' : originalOverflow;
      document.body.style.paddingRight = originalPaddingRight;
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [selectedBeneficiary, isSummaryModalOpen]);

  // Map of sorted sessions to chronological session numbers (1, 2, 3...)
  const sessionChronologicalMap = useMemo(() => {
    if (!sessions) return new Map<string, { sessionNum: number; weekNum: number; isSubmitted: boolean }>();
    const sorted = [...sessions].sort((a, b) => a.session_date.localeCompare(b.session_date));
    const map = new Map<string, { sessionNum: number; weekNum: number; isSubmitted: boolean }>();
    sorted.forEach((s, idx) => {
      map.set(s.session_id, {
        sessionNum: idx + 1,
        weekNum: s.week_number ?? 1,
        isSubmitted: s.submitted_at != null,
      });
    });
    return map;
  }, [sessions]);

  const getMeasurementMeta = (m: BeneficiaryMeasurement, idx: number) => {
    const fromMap = sessionChronologicalMap.get(m.session_id);
    if (fromMap) return fromMap;

    let weekNum = m.week_number ?? 1;
    if (weeks && !m.week_number) {
      for (const wk of weeks) {
        if (m.session_date >= wk.week_start_date && m.session_date <= wk.week_end_date) {
          weekNum = wk.week_number;
          break;
        }
      }
    }
    return {
      sessionNum: idx + 1,
      weekNum,
      isSubmitted: m.submitted_at != null,
    };
  };

  // Beneficiaries matching the 4 cohort filters (ignoring the search box)
  const filterMatched = useMemo(() => {
    return filterBeneficiariesByCriteria(beneficiaries, {
      statusFilter,
      ageFilter,
      sexFilter,
      minAttendedSessions: minAttendedInput,
    });
  }, [beneficiaries, statusFilter, ageFilter, sexFilter, minAttendedInput]);

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
        minAttendedInput: minAttendedInput.trim(),
      },
    });
    setIsSummaryModalOpen(true);
  };

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
    const minAttended = parseMinAttendedThreshold(f.minAttendedInput);
    if (minAttended !== null) {
      chips.push(`Attended ≥ ${minAttended} session${minAttended === 1 ? '' : 's'}`);
    }
    if (chips.length === 0) {
      chips.push('All enrolled beneficiaries');
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
        case 'bmi_optimality':
          cmp = (a.latest_statuses.bmi?.change_value ?? -999) - (b.latest_statuses.bmi?.change_value ?? -999);
          break;
        case 'whtr_optimality':
          cmp = (a.latest_statuses.whtr?.change_value ?? -999) - (b.latest_statuses.whtr?.change_value ?? -999);
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

  return (
    <div className="card bb-card overflow-hidden">
      <div className="px-4 pt-4 pb-3 border-bottom" style={{ borderColor: 'rgba(0,0,0,0.06)' }}>
        <div className="d-flex flex-wrap justify-content-between align-items-baseline gap-2 mb-3">
          <div>
            <div className="d-flex align-items-baseline gap-2 mb-1">
              <h2 className="h5 fw-bold mb-0 text-dark" style={{ letterSpacing: '-0.015em' }}>
                Program Beneficiaries
              </h2>
              <span className="small text-body-secondary bb-num">
                {beneficiaries.length} enrolled
              </span>
            </div>
            <p className="text-body-secondary small mb-0">
              Profiles, measurement deltas, and attendance since registration. Select a row for full history.
            </p>
          </div>
        </div>

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

          {/* Attended >= __ sessions (attended_count >= X) */}
          <div style={{ flex: '0 0 auto' }}>
            <div
              className={`d-inline-flex align-items-center gap-1 rounded-2 px-2 border ${
                minAttendedInput.trim() !== ''
                  ? 'border-dark bg-white'
                  : 'border-secondary-subtle bg-white'
              }`}
              style={{ height: '31px' }}
              title="Filter beneficiaries who attended at least X sessions (attended_count >= X; leave blank for no filter)"
            >
              <label
                htmlFor="beneficiary-min-attended-input"
                className="small text-body-secondary text-nowrap mb-0"
                style={{ fontSize: '0.8rem', cursor: 'pointer' }}
              >
                Attended ≥
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
                aria-label="Attended at least sessions"
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

          {/* Summarize Button */}
          <div className="ms-md-auto" style={{ flex: '0 0 auto' }}>
            <button
              type="button"
              className="bb-action-chip bb-action-chip-primary"
              onClick={handleSummarize}
              title={`Summarize first-to-latest Weight, Waist${showMuacSummary ? ', and MUAC' : ''} changes across beneficiaries matching the current filters (ignores search box)`}
            >
              <span>Summarize</span>
              <span className="bb-num opacity-75">{filterMatched.length}</span>
            </button>
          </div>
        </div>
      </div>

      {/* Main Beneficiaries Table */}
      <div className="table-responsive px-3 px-md-4 pt-2 pb-1">
        <table className="bb-ns-table">
          <thead>
            <tr>
              <th scope="col" style={{ cursor: 'pointer', width: '88px' }} onClick={() => handleSort('code')}>
                Code{sortIndicator('code')}
              </th>
              <th scope="col" style={{ cursor: 'pointer' }} onClick={() => handleSort('name')}>
                Display Name{sortIndicator('name')}
              </th>
              <th scope="col" style={{ cursor: 'pointer', width: '92px' }} onClick={() => handleSort('age')}>
                Age{sortIndicator('age')}
              </th>
              <th scope="col" style={{ cursor: 'pointer', width: '78px' }} onClick={() => handleSort('sex')}>
                Sex{sortIndicator('sex')}
              </th>
              <th
                scope="col"
                className="text-end"
                style={{ cursor: 'pointer', width: '124px' }}
                onClick={() => handleSort('bmi_optimality')}
                title="Latest signed BMI change toward (+) or away from (-) healthy range"
              >
                BMI Change{sortIndicator('bmi_optimality')}
              </th>
              <th
                scope="col"
                className="text-end"
                style={{ cursor: 'pointer', width: '124px' }}
                onClick={() => handleSort('whtr_optimality')}
                title="Latest signed WHtR change toward (+) or away from (-) 0.47 optimal"
              >
                WHtR Change{sortIndicator('whtr_optimality')}
              </th>
              <th
                scope="col"
                className="text-end"
                style={{ cursor: 'pointer', width: '132px' }}
                onClick={() => handleSort('weight_change')}
                title="Latest valid weight (kg) minus first valid weight (kg) across present sessions"
              >
                Weight Change{sortIndicator('weight_change')}
              </th>
              <th
                scope="col"
                className="text-end"
                style={{ cursor: 'pointer', width: '132px' }}
                onClick={() => handleSort('waist_change')}
                title="Latest valid waist circumference (cm) minus first valid waist circumference (cm) across present sessions"
              >
                Waist Change{sortIndicator('waist_change')}
              </th>
              <th
                scope="col"
                style={{ cursor: 'pointer', width: '168px' }}
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
                <td colSpan={9} className="text-center py-5 text-body-secondary">
                  No beneficiaries found matching the selected filters.
                </td>
              </tr>
            ) : (
              pagedBeneficiaries.map((b) => {
                const bmiChangeVal = b.latest_statuses.bmi?.change_value ?? null;
                const whtrChangeVal = b.latest_statuses.whtr?.change_value ?? null;
                const weightDelta = computeFirstToLatestDelta(b.measurements, 'weight_kg');
                const waistDelta = computeFirstToLatestDelta(b.measurements, 'waist_cm');

                return (
                  <tr
                    key={b.beneficiary_code}
                    onClick={() => setSelectedBeneficiary(b)}
                    className="bb-history-row"
                    title="Click to view beneficiary detail modal"
                  >
                    <td>
                      <span className="fw-mono small fw-bold text-dark">#{b.beneficiary_code}</span>
                    </td>
                    <td>
                      <div className="d-flex flex-wrap align-items-center gap-1">
                        {b.name ? (
                          <span className="fw-semibold text-dark">{b.name}</span>
                        ) : b.alias ? (
                          <span className="fst-italic text-body-secondary">
                            {b.alias}
                            <span
                              className="badge rounded-pill bg-light border text-muted ms-1"
                              style={{ fontSize: '0.65rem' }}
                            >
                              Alias
                            </span>
                          </span>
                        ) : (
                          <span className="text-muted">—</span>
                        )}

                        {b.allergies.length > 0 && (
                          <span
                            className="badge text-bg-danger-subtle text-danger-emphasis ms-1"
                            style={{ fontSize: '0.65rem' }}
                          >
                            {b.allergies.length} allerg{b.allergies.length > 1 ? 'ies' : 'y'}
                          </span>
                        )}

                        {b.height_notice && (
                          <span
                            className="badge rounded-pill badge-pale-warning ms-1"
                            style={{ fontSize: '0.65rem' }}
                            title={HEIGHT_NOTICE_MESSAGE}
                          >
                            Fresh height due
                          </span>
                        )}
                      </div>
                    </td>
                    <td>
                      <span className="bb-num text-dark">{b.age} yo</span>
                      <small className="text-body-secondary d-block" style={{ fontSize: '0.7rem' }}>
                        {b.isAdult ? 'Adult' : 'Minor'}
                      </small>
                    </td>
                    <td>
                      <span className="text-capitalize small text-dark">{b.sex}</span>
                    </td>
                    <td className="text-end">
                      {bmiChangeVal != null ? (
                        <div>
                          <span
                            className={`fw-semibold small bb-num ${
                              bmiChangeVal > 0
                                ? 'text-success'
                                : bmiChangeVal < 0
                                ? 'text-danger'
                                : 'text-body-secondary'
                            }`}
                            title="Latest signed BMI status change (+ moved toward healthy, - moved away)"
                          >
                            {bmiChangeVal > 0 ? '↑ +' : bmiChangeVal < 0 ? '↓ ' : '→ '}
                            {bmiChangeVal.toFixed(3)}
                          </span>
                          <small className="text-body-secondary d-block" style={{ fontSize: '0.67rem' }}>
                            {bmiChangeVal > 0 ? 'Closer' : bmiChangeVal < 0 ? 'Farther' : 'Unchanged'}
                          </small>
                        </div>
                      ) : (
                        <span className="text-body-secondary">—</span>
                      )}
                    </td>
                    <td className="text-end">
                      {whtrChangeVal != null ? (
                        <div>
                          <span
                            className={`fw-semibold small bb-num ${
                              whtrChangeVal > 0
                                ? 'text-success'
                                : whtrChangeVal < 0
                                ? 'text-danger'
                                : 'text-body-secondary'
                            }`}
                            title="Latest signed WHtR status change (+ moved toward 0.47, - moved away)"
                          >
                            {whtrChangeVal > 0 ? '↑ +' : whtrChangeVal < 0 ? '↓ ' : '→ '}
                            {whtrChangeVal.toFixed(3)}
                          </span>
                          <small className="text-body-secondary d-block" style={{ fontSize: '0.67rem' }}>
                            {whtrChangeVal > 0 ? 'Closer' : whtrChangeVal < 0 ? 'Farther' : 'Unchanged'}
                          </small>
                        </div>
                      ) : (
                        <span className="text-body-secondary">—</span>
                      )}
                    </td>
                    <td className="text-end">
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
                    <td className="text-end">
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
      <div
        className="bg-white border-top px-4 py-3 d-flex flex-wrap justify-content-between align-items-center gap-2"
        style={{ borderColor: 'rgba(0,0,0,0.06)' }}
      >
        <span className="small text-body-secondary bb-num">
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

                        <dt className="col-5 text-body-secondary">Initial Weight / Height:</dt>
                        <dd className="col-7 bb-num">
                          {selectedBeneficiary.initial_weight_kg.toFixed(1)} kg · {selectedBeneficiary.initial_height_cm.toFixed(1)} cm
                        </dd>

                        <dt className="col-5 text-body-secondary">Effective Height:</dt>
                        <dd className="col-7 bb-num">
                          {selectedBeneficiary.effective_height_cm != null ? (
                            <>
                              {selectedBeneficiary.effective_height_cm.toFixed(1)} cm{' '}
                              <span className="text-body-secondary">
                                ({formatDate(selectedBeneficiary.effective_height_date)})
                              </span>
                            </>
                          ) : (
                            '—'
                          )}
                        </dd>

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

                {selectedBeneficiary.height_notice && (
                  <div className="alert alert-warning border-0 p-3 rounded-4 mb-4 small">
                    📏 <strong>Height Notice:</strong> {HEIGHT_NOTICE_MESSAGE}.
                  </div>
                )}

                {/* Per-Metric Latest Statuses & Deltas */}
                <div className="bg-light-subtle rounded-4 p-3 border mb-4">
                  <div className="d-flex flex-wrap justify-content-between align-items-center gap-2 mb-3">
                    <h4 className="h6 text-uppercase text-body-secondary small fw-bold mb-0">
                      Latest Per-Metric Statuses &amp; Changes
                    </h4>
                    {selectedBeneficiary.last_measured_sessions_ago != null && (
                      <span
                        className={`badge rounded-pill bb-num ${
                          selectedBeneficiary.last_measured_sessions_ago >= 1
                            ? 'badge-pale-warning'
                            : 'badge-pale-success'
                        }`}
                      >
                        Last measured {selectedBeneficiary.last_measured_sessions_ago} session
                        {selectedBeneficiary.last_measured_sessions_ago === 1 ? '' : 's'} ago
                      </span>
                    )}
                  </div>

                  {/* Per-metric cards */}
                  <div className="row row-cols-1 row-cols-sm-2 row-cols-lg-4 g-2 mb-3">
                    {ALL_METRICS.map((m) => {
                      const st = selectedBeneficiary.latest_statuses[m];
                      return (
                        <div key={m} className="col">
                          <div className="bg-white border rounded-3 p-2 h-100">
                            <div className="d-flex justify-content-between align-items-center mb-1">
                              <span className="small fw-bold text-dark">{METRIC_LABEL[m]}</span>
                              {st ? (
                                <span className={`badge ${STATUS_BADGE_CLASS[st.status_key]}`}>
                                  {STATUS_LABEL[st.status_key]}
                                </span>
                              ) : (
                                <span className="badge badge-pale-neutral text-muted">No status</span>
                              )}
                            </div>
                            {st ? (
                              <div className="small bb-num">
                                <div className="text-dark fw-semibold">{st.latest_value_display}</div>
                                <div className="text-body-secondary" style={{ fontSize: '0.72rem' }}>
                                  {formatDate(st.session_date)}
                                  {st.is_outdated && (
                                    <span className="text-warning-emphasis ms-1">(Outdated · {st.days_old}d)</span>
                                  )}
                                </div>
                                {st.change_value != null && (
                                  <div
                                    className={
                                      st.change_value > 0
                                        ? 'text-success'
                                        : st.change_value < 0
                                        ? 'text-danger'
                                        : 'text-body-secondary'
                                    }
                                    style={{ fontSize: '0.72rem' }}
                                  >
                                    Change: {st.change_value > 0 ? `+${st.change_value.toFixed(3)}` : st.change_value.toFixed(3)}
                                  </div>
                                )}
                              </div>
                            ) : (
                              <div className="text-body-secondary" style={{ fontSize: '0.75rem' }}>
                                Not yet measured
                              </div>
                            )}
                          </div>
                        </div>
                      );
                    })}
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
                      <div className="row row-cols-1 row-cols-sm-3 g-3 pt-2 border-top align-items-center">
                        <div className="col">
                          <span className="small text-body-secondary d-block">
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
                          <span className="small text-body-secondary d-block">
                            Waist Change (1st → Latest):
                          </span>
                          <strong className="small bb-num text-secondary-emphasis">
                            {modalWaistDelta != null
                              ? formatSignedDeltaWithUnit(modalWaistDelta.delta, 'cm', 2)
                              : '—'}
                          </strong>
                        </div>

                        <div className="col">
                          <span className="small text-body-secondary d-block">
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
                </div>

                {/* Measurement & Attendance History Table with Program Week Track & Edema */}
                <div>
                  <div className="d-flex flex-wrap justify-content-between align-items-center gap-2 mb-2">
                    <h4 className="h6 text-uppercase text-body-secondary small fw-bold mb-0">
                      Measurement &amp; Attendance History
                    </h4>

                    <div className="d-flex flex-wrap align-items-center gap-3 small">
                      <span className="text-body-secondary fw-semibold" style={{ fontSize: '0.72rem' }}>
                        Program Weeks:
                      </span>
                      {(weeks && weeks.length > 0 ? weeks : [{ week_number: 1 }]).map((wk) => (
                        <span key={wk.week_number} className="d-inline-flex align-items-center gap-1" style={{ fontSize: '0.72rem' }}>
                          <span
                            className="rounded-circle d-inline-block"
                            style={{ width: '8px', height: '8px', backgroundColor: getWeekColor(wk.week_number).hex }}
                          />
                          <span className="fw-medium text-dark">Week {wk.week_number}</span>
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
                            <th className="text-center align-middle" style={{ width: '56px' }}>Wk</th>
                            <th className="text-center align-middle" style={{ width: '56px' }}>#</th>
                            <th style={{ minWidth: '100px' }}>Date</th>
                            <th style={{ minWidth: '85px' }}>Status</th>
                            <th className="text-end" style={{ minWidth: '90px' }}>Weight (kg)</th>
                            <th className="text-end" style={{ minWidth: '110px' }}>Height (cm)</th>
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
                            const currWeek = meta.weekNum;
                            const prevWeek =
                              idx > 0
                                ? getMeasurementMeta(selectedBeneficiary.measurements[idx - 1], idx - 1).weekNum
                                : null;
                            const isNewWeek = idx === 0 || prevWeek !== currWeek;
                            const currColor = getWeekColor(currWeek).hex;
                            const prevColor = prevWeek != null ? getWeekColor(prevWeek).hex : currColor;
                            const isFirstRow = idx === 0;
                            const isLastRow = idx === selectedBeneficiary.measurements.length - 1;
                            const isSubmitted = meta.isSubmitted;

                            return (
                              <tr key={m.session_id}>
                                {/* Column 1: Week Track */}
                                <td
                                  className="position-relative text-center align-middle p-0"
                                  style={{ width: '56px', height: '52px' }}
                                >
                                  {!isFirstRow && (
                                    <div
                                      className="position-absolute start-50 translate-middle-x"
                                      style={{
                                        width: '4px',
                                        top: 0,
                                        height: '50%',
                                        backgroundColor: isNewWeek ? prevColor : currColor,
                                        zIndex: 1,
                                      }}
                                    />
                                  )}

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

                                  {isNewWeek ? (
                                    <span
                                      className="position-relative d-inline-flex align-items-center justify-content-center rounded-circle text-white fw-bold shadow-sm"
                                      style={{
                                        width: '28px',
                                        height: '28px',
                                        backgroundColor: currColor,
                                        zIndex: 2,
                                        fontSize: '0.72rem',
                                      }}
                                      title={`Week ${currWeek}`}
                                    >
                                      W{currWeek}
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
                                      title={`Session ${meta.sessionNum} (Week ${currWeek})`}
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

                                {/* Column 4: Attendance */}
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

                                {/* Column 6: Height (explicit or carried forward) */}
                                <td className="text-end align-middle bb-num">
                                  {m.height_cm != null ? (
                                    `${m.height_cm.toFixed(1)}`
                                  ) : m.effective_height_cm != null && m.height_carried_forward ? (
                                    <span className="text-body-secondary" title={`Carried forward from ${formatDate(m.effective_height_date)}`}>
                                      {m.effective_height_cm.toFixed(1)} (c)
                                    </span>
                                  ) : (
                                    '—'
                                  )}
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

      {/* Filtered Cohort Summary Pop-Up Modal */}
      {mounted &&
        isSummaryModalOpen &&
        summarySnapshot &&
        createPortal(
          <div
            className="bb-modal-overlay"
            role="presentation"
            onClick={(e) => {
              if (e.target === e.currentTarget) setIsSummaryModalOpen(false);
            }}
          >
            <div
              ref={summaryModalRef}
              tabIndex={-1}
              className="bb-modal-dialog"
              style={{ maxWidth: '820px', outline: 'none' }}
              role="dialog"
              aria-modal="true"
              aria-labelledby="cohortSummaryModalTitle"
            >
              {/* Modal Header */}
              <div
                className="px-4 py-3 border-bottom bg-white d-flex justify-content-between align-items-start gap-3 flex-shrink-0"
                style={{ borderColor: 'rgba(0,0,0,0.06)' }}
              >
                <div>
                  <div className="d-flex flex-wrap align-items-baseline gap-2">
                    <h3
                      id="cohortSummaryModalTitle"
                      className="h5 fw-bold mb-0 text-dark"
                      style={{ letterSpacing: '-0.015em' }}
                    >
                      Filtered Cohort Summary (1st → Latest Measurement)
                    </h3>
                    <span className="small text-body-secondary bb-num">
                      {summarySnapshot.summary.totalMatching} matching beneficiar
                      {summarySnapshot.summary.totalMatching === 1 ? 'y' : 'ies'}
                    </span>
                  </div>
                  <div className="d-flex flex-wrap align-items-center gap-1 mt-2">
                    <span className="small text-body-secondary me-1" style={{ fontSize: '0.75rem' }}>
                      Filters:
                    </span>
                    {appliedFilterChips.map((chip) => (
                      <span key={chip} className="bb-status-chip bg-light border text-dark">
                        {chip}
                      </span>
                    ))}
                    <span className="small text-body-secondary ms-1" style={{ fontSize: '0.73rem' }}>
                      · Search query not applied
                    </span>
                  </div>
                </div>

                <button
                  type="button"
                  className="btn-close mt-1"
                  aria-label="Close modal"
                  onClick={() => setIsSummaryModalOpen(false)}
                />
              </div>

              {/* Modal Body */}
              <div className="p-4 overflow-y-auto" style={{ overscrollBehavior: 'contain' }}>
                {summarySnapshot.summary.smallSampleWarning && (
                  <div className="alert alert-warning border-0 py-2 px-3 small mb-3 rounded-3">
                    <strong>Small sample notice:</strong> Only{' '}
                    <strong className="bb-num">{summarySnapshot.summary.totalMatching}</strong>{' '}
                    beneficiar{summarySnapshot.summary.totalMatching === 1 ? 'y matches' : 'ies match'}{' '}
                    the current filters (&lt; 5). Interpret averages with caution.
                  </div>
                )}

                {/* Outcome Distribution Legend */}
                <div
                  className="d-flex flex-wrap align-items-center gap-3 pb-3 mb-3 border-bottom small text-body-secondary"
                  style={{ borderColor: 'rgba(0,0,0,0.06)', fontSize: '0.76rem' }}
                >
                  <span className="d-inline-flex align-items-center gap-1">
                    <span
                      className="rounded-1 d-inline-block"
                      style={{ width: '10px', height: '10px', backgroundColor: '#15803d' }}
                    />
                    <span>Increased</span>
                  </span>
                  <span className="d-inline-flex align-items-center gap-1">
                    <span
                      className="rounded-1 d-inline-block"
                      style={{ width: '10px', height: '10px', backgroundColor: '#b91c1c' }}
                    />
                    <span>Decreased</span>
                  </span>
                  <span className="d-inline-flex align-items-center gap-1">
                    <span
                      className="rounded-1 d-inline-block"
                      style={{ width: '10px', height: '10px', backgroundColor: '#64748b' }}
                    />
                    <span>Unchanged</span>
                  </span>
                  <span className="d-inline-flex align-items-center gap-1">
                    <span
                      className="rounded-1 d-inline-block"
                      style={{ width: '10px', height: '10px', backgroundColor: '#cbd5e1' }}
                    />
                    <span>No paired data (&lt;2 sessions)</span>
                  </span>
                </div>

                {/* Per-Metric Stacked Bar & Directional Comparison Blocks */}
                <div className="d-flex flex-column gap-3">
                  {(showMuacSummary
                    ? [
                        summarySnapshot.summary.weight,
                        summarySnapshot.summary.waist,
                        summarySnapshot.summary.muac,
                      ]
                    : [summarySnapshot.summary.weight, summarySnapshot.summary.waist]
                  ).map((metric) => {
                    const total = summarySnapshot.summary.totalMatching;
                    const pairedCount = metric.increased.n + metric.decreased.n + metric.unchangedCount;
                    const incPct = total > 0 ? (metric.increased.n / total) * 100 : 0;
                    const decPct = total > 0 ? (metric.decreased.n / total) * 100 : 0;
                    const unchPct = total > 0 ? (metric.unchangedCount / total) * 100 : 0;
                    const noDataPct = total > 0 ? (metric.noDataCount / total) * 100 : 0;

                    return (
                      <div key={metric.key} className="bb-cohort-metric-block">
                        {/* Metric Header */}
                        <div className="d-flex flex-wrap justify-content-between align-items-baseline gap-2 mb-2">
                          <div className="d-flex align-items-baseline gap-2">
                            <h4 className="h6 fw-bold mb-0 text-dark">{metric.label}</h4>
                            <span className="small text-body-secondary">({metric.unit})</span>
                          </div>
                          <span className="small text-body-secondary bb-num">
                            <strong className="text-dark fw-semibold">{pairedCount}</strong> of {total} with ≥2 readings
                          </span>
                        </div>

                        {/* 100% Horizontal Stacked Outcome Bar */}
                        <div
                          className="bb-cohort-stack-bar mb-3"
                          role="img"
                          aria-label={`${metric.label}: ${metric.increased.n} increased, ${metric.decreased.n} decreased, ${metric.unchangedCount} unchanged, ${metric.noDataCount} no paired data`}
                        >
                          {incPct > 0 && (
                            <div
                              style={{ width: `${incPct}%`, backgroundColor: '#15803d' }}
                              title={`Increased: ${metric.increased.n} (${Math.round(incPct)}%)`}
                            />
                          )}
                          {decPct > 0 && (
                            <div
                              style={{ width: `${decPct}%`, backgroundColor: '#b91c1c' }}
                              title={`Decreased: ${metric.decreased.n} (${Math.round(decPct)}%)`}
                            />
                          )}
                          {unchPct > 0 && (
                            <div
                              style={{ width: `${unchPct}%`, backgroundColor: '#64748b' }}
                              title={`Unchanged: ${metric.unchangedCount} (${Math.round(unchPct)}%)`}
                            />
                          )}
                          {noDataPct > 0 && (
                            <div
                              style={{ width: `${noDataPct}%`, backgroundColor: '#cbd5e1' }}
                              title={`No paired data (<2 sessions): ${metric.noDataCount} (${Math.round(noDataPct)}%)`}
                            />
                          )}
                        </div>

                        {/* Side-by-Side Directional Cards: Increased vs. Decreased */}
                        <div className="row g-2">
                          <div className="col-12 col-sm-6">
                            <div className="bb-cohort-dir-card is-increased">
                              <div className="d-flex justify-content-between align-items-baseline gap-2 mb-1">
                                <span
                                  className="small fw-semibold"
                                  style={{ color: '#15803d' }}
                                >
                                  ↑ Increased
                                </span>
                                <span
                                  className="fw-bold fs-6 bb-num"
                                  style={{ color: '#14532d' }}
                                >
                                  {formatSummaryMean(metric.increased.mean, metric.unit)}
                                </span>
                              </div>
                              <div
                                className="d-flex justify-content-between align-items-baseline small text-body-secondary bb-num mb-2"
                                style={{ fontSize: '0.76rem' }}
                              >
                                <span>
                                  <strong className="text-dark">{metric.increased.n}</strong>{' '}
                                  beneficiar{metric.increased.n === 1 ? 'y' : 'ies'} ({Math.round(incPct)}%)
                                </span>
                                <span>avg gain</span>
                              </div>
                              <div
                                className="rounded-pill overflow-hidden"
                                style={{ height: '4px', backgroundColor: 'rgba(21, 128, 61, 0.14)' }}
                              >
                                <div
                                  style={{
                                    width: `${incPct}%`,
                                    height: '100%',
                                    backgroundColor: '#15803d',
                                  }}
                                />
                              </div>
                            </div>
                          </div>

                          <div className="col-12 col-sm-6">
                            <div className="bb-cohort-dir-card is-decreased">
                              <div className="d-flex justify-content-between align-items-baseline gap-2 mb-1">
                                <span
                                  className="small fw-semibold"
                                  style={{ color: '#b91c1c' }}
                                >
                                  ↓ Decreased
                                </span>
                                <span
                                  className="fw-bold fs-6 bb-num"
                                  style={{ color: '#7f1d1d' }}
                                >
                                  {formatSummaryMean(metric.decreased.mean, metric.unit)}
                                </span>
                              </div>
                              <div
                                className="d-flex justify-content-between align-items-baseline small text-body-secondary bb-num mb-2"
                                style={{ fontSize: '0.76rem' }}
                              >
                                <span>
                                  <strong className="text-dark">{metric.decreased.n}</strong>{' '}
                                  beneficiar{metric.decreased.n === 1 ? 'y' : 'ies'} ({Math.round(decPct)}%)
                                </span>
                                <span>avg loss</span>
                              </div>
                              <div
                                className="rounded-pill overflow-hidden"
                                style={{ height: '4px', backgroundColor: 'rgba(185, 28, 28, 0.14)' }}
                              >
                                <div
                                  style={{
                                    width: `${decPct}%`,
                                    height: '100%',
                                    backgroundColor: '#b91c1c',
                                  }}
                                />
                              </div>
                            </div>
                          </div>
                        </div>

                        {/* Companion Counts Strip: Unchanged & No Paired Data */}
                        <div className="bb-cohort-meta-strip">
                          <span className="d-inline-flex align-items-center gap-2 text-body-secondary">
                            <span className="bb-status-dot me-0" style={{ backgroundColor: '#64748b' }} />
                            <span>Unchanged (same 1st &amp; latest value)</span>
                            <strong className="text-dark bb-num">
                              {metric.unchangedCount}
                            </strong>
                            <span className="bb-num text-body-secondary" style={{ fontSize: '0.73rem' }}>
                              ({Math.round(unchPct)}%)
                            </span>
                          </span>

                          <span className="d-inline-flex align-items-center gap-2 text-body-secondary">
                            <span className="bb-status-dot me-0" style={{ backgroundColor: '#cbd5e1' }} />
                            <span>No paired data (&lt;2 sessions)</span>
                            <strong className="text-dark bb-num">
                              {metric.noDataCount}
                            </strong>
                            <span className="bb-num text-body-secondary" style={{ fontSize: '0.73rem' }}>
                              ({Math.round(noDataPct)}%)
                            </span>
                          </span>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>

              {/* Modal Footer */}
              <div
                className="px-4 py-3 border-top bg-white d-flex flex-wrap justify-content-between align-items-center gap-2 flex-shrink-0"
                style={{ borderColor: 'rgba(0,0,0,0.06)' }}
              >
                <small className="text-body-secondary">
                  Compares each beneficiary&apos;s earliest valid present reading against their latest valid present reading.
                </small>
                <button
                  type="button"
                  className="bb-action-chip px-3"
                  onClick={() => setIsSummaryModalOpen(false)}
                >
                  Close
                </button>
              </div>
            </div>
          </div>,
          document.body
        )}
    </div>
  );
}
