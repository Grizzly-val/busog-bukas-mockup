'use client';

import { useState, useMemo, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import type {
  BeneficiaryCohortRow,
  BeneficiaryData,
  NutritionalStatusModalRow,
  NutritionalStatusProgramData,
} from '@/lib/programData';
import {
  COHORT_TRANSITION_TAG_META,
  METRIC_LABEL,
  STATUS_BADGE_CLASS,
  STATUS_LABEL,
  STATUS_SEVERITY,
  type MetricKey,
  type MetricStatusHistoryPoint,
  type StatusKey,
} from '@/lib/statusRule';
import { formatDate } from '@/lib/format';

type Props = {
  nutritionalStatus: NutritionalStatusProgramData;
  beneficiaries: BeneficiaryData[];
  today: string;
};

type ActiveModal =
  | 'monitor'
  | 'monitor_closely'
  | 'outdated'
  | 'view_beneficiaries'
  | 'cohort_transitions'
  | null;
type CardTab = 'history' | 'transitions';

const PAGE_SIZE = 10;
const SHORT_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const METRIC_SUBTITLE: Record<MetricKey, string> = {
  bmi: 'Weight-to-height / age z-score',
  whtr: 'Waist-to-height ratio',
  muac: 'Mid-upper arm circumference',
  edema: 'Bilateral pitting check',
};

const HISTORY_STATUS_DOT_COLOR: Record<StatusKey, string> = {
  baseline: '#15803d',
  monitor: '#d97706',
  monitor_closely: '#dc2626',
};

function formatShortMonthDay(dateStr: string): string {
  if (!dateStr) return '—';
  const parts = dateStr.slice(0, 10).split('-').map(Number);
  if (parts.length < 3 || Number.isNaN(parts[1]) || Number.isNaN(parts[2])) {
    return formatDate(dateStr);
  }
  return `${SHORT_MONTHS[parts[1] - 1] ?? ''} ${parts[2]}`;
}

function formatCohortNetChange(
  metric: MetricKey,
  val: number | null,
  measurementCount: number
): string {
  if (measurementCount < 2 || metric === 'edema' || val == null) return '—';
  const sign = val > 0 ? '+' : '';
  if (metric === 'bmi') return `${sign}${val.toFixed(2)}`;
  if (metric === 'muac') return `${sign}${val.toFixed(1)} cm`;
  return `${sign}${val.toFixed(3)}`;
}

export default function NutritionalStatusSection({
  nutritionalStatus,
  beneficiaries,
  today,
}: Props) {
  const {
    has_nutritionist: hasNutritionist,
    available_metrics: availableMetrics,
    submitted_sessions: submittedSessions,
    cohort_tracking: cohortTracking,
  } = nutritionalStatus;
  const totalSubmittedSessions = submittedSessions.length;

  // In-card view tabs (Per-Beneficiary History & Transitions)
  const [activeTab, setActiveTab] = useState<CardTab>('history');

  // History view state
  const [historySearch, setHistorySearch] = useState('');
  const [historyPage, setHistoryPage] = useState(1);
  const [expandedCodes, setExpandedCodes] = useState<Record<string, boolean>>({});

  // Cohort Transitions state (default to all beneficiaries with 1+ sessions attended)
  const [minAttendance, setMinAttendance] = useState<number>(1);
  const [transitionModalMetric, setTransitionModalMetric] = useState<MetricKey>('bmi');

  // Modal state
  const [activeModal, setActiveModal] = useState<ActiveModal>(null);
  const [modalMetricTab, setModalMetricTab] = useState<MetricKey | 'all'>('bmi');
  const [mounted, setMounted] = useState(false);
  const modalRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setMounted(true);
  }, []);

  useEffect(() => {
    if (!activeModal) return;

    const prevOverflow = document.body.style.overflow;
    const prevPaddingRight = document.body.style.paddingRight;
    const scrollbarWidth = window.innerWidth - document.documentElement.clientWidth;

    document.body.style.overflow = 'hidden';
    if (scrollbarWidth > 0) {
      document.body.style.paddingRight = `${scrollbarWidth}px`;
    }

    const focusTimer = setTimeout(() => {
      modalRef.current?.focus();
    }, 20);

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setActiveModal(null);
      }
    };
    window.addEventListener('keydown', handleKeyDown);

    return () => {
      clearTimeout(focusTimer);
      document.body.style.overflow = prevOverflow === 'hidden' ? '' : prevOverflow;
      document.body.style.paddingRight = prevPaddingRight;
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [activeModal]);

  // Auto-enabled metrics come directly from the backend (`available_metrics`)
  const activeMetrics: MetricKey[] = availableMetrics;

  // Filtered per-beneficiary history list
  const filteredBeneficiaries = useMemo(() => {
    const q = historySearch.trim().toLowerCase();
    if (!q) return beneficiaries;
    return beneficiaries.filter(
      (b) =>
        b.displayName.toLowerCase().includes(q) ||
        b.beneficiary_code.toLowerCase().includes(q)
    );
  }, [beneficiaries, historySearch]);

  const totalHistoryPages = Math.max(1, Math.ceil(filteredBeneficiaries.length / PAGE_SIZE));
  const safeHistoryPage = Math.min(historyPage, totalHistoryPages);
  const pagedBeneficiaries = useMemo(
    () =>
      filteredBeneficiaries.slice(
        (safeHistoryPage - 1) * PAGE_SIZE,
        safeHistoryPage * PAGE_SIZE
      ),
    [filteredBeneficiaries, safeHistoryPage]
  );

  const toggleExpandRow = (code: string) => {
    setExpandedCodes((prev) => ({ ...prev, [code]: !prev[code] }));
  };

  // Beneficiaries eligible for "View beneficiaries" (have latest status for ALL activeMetrics)
  const qualifyingBeneficiaries = useMemo(() => {
    return beneficiaries
      .filter((b) => activeMetrics.every((m) => b.latest_statuses[m] != null))
      .map((b) => {
        const outdatedCountForSelected = activeMetrics.filter(
          (m) => b.latest_statuses[m]?.is_outdated
        ).length;
        return {
          beneficiary: b,
          hasOutdatedMetric: outdatedCountForSelected > 0,
          outdatedCountForSelected,
        };
      });
  }, [beneficiaries, activeMetrics]);

  const qualifyingOutdatedBeneficiariesCount = useMemo(
    () => qualifyingBeneficiaries.filter((item) => item.hasOutdatedMetric).length,
    [qualifyingBeneficiaries]
  );

  // First-vs-Latest Cohort Status Transitions calculations
  const maxSubmittedSessions = Math.max(1, totalSubmittedSessions);
  const effectiveMinAttendance = Math.min(Math.max(1, minAttendance), maxSubmittedSessions);

  const cohortByMetric = useMemo(() => {
    return activeMetrics.map((metric) => {
      const allRows = cohortTracking[metric]?.rows ?? [];
      const cohortRows = allRows.filter(
        (r) => r.sessions_attended >= effectiveMinAttendance
      );
      const multiMeasurementRows = cohortRows.filter((r) => r.measurement_count >= 2);
      const singleMeasurementCount = cohortRows.filter((r) => r.measurement_count === 1).length;
      const improvedCount = cohortRows.filter((r) => r.transition_tag === 'improved').length;
      const unchangedCount = cohortRows.filter((r) => r.transition_tag === 'unchanged').length;
      const declinedCount = cohortRows.filter((r) => r.transition_tag === 'declined').length;
      return {
        metric,
        cohortRows,
        multiMeasurementRows,
        singleMeasurementCount,
        improvedCount,
        unchangedCount,
        declinedCount,
      };
    });
  }, [activeMetrics, cohortTracking, effectiveMinAttendance]);

  const modalCohortRows = useMemo<BeneficiaryCohortRow[]>(() => {
    if (activeModal !== 'cohort_transitions') return [];
    return (
      cohortByMetric.find((c) => c.metric === transitionModalMetric)?.cohortRows ?? []
    );
  }, [activeModal, cohortByMetric, transitionModalMetric]);

  const openModal = (modal: Exclude<ActiveModal, 'cohort_transitions' | null>) => {
    setModalMetricTab(modal === 'outdated' ? 'all' : 'bmi');
    setActiveModal(modal);
  };

  const openCohortModal = (metric: MetricKey) => {
    setTransitionModalMetric(metric);
    setActiveModal('cohort_transitions');
  };

  // Base summary modal counts
  const totalMonitorAcrossActive = activeMetrics.reduce(
    (sum, m) => sum + nutritionalStatus.metrics[m].monitor_count,
    0
  );
  const totalCloselyAcrossActive = activeMetrics.reduce(
    (sum, m) => sum + nutritionalStatus.metrics[m].monitor_closely_count,
    0
  );
  const filteredOutdatedRows = useMemo(() => {
    const visible = nutritionalStatus.outdated_rows.filter((r) =>
      availableMetrics.includes(r.metric)
    );
    if (modalMetricTab === 'all') return visible;
    return visible.filter((r) => r.metric === modalMetricTab);
  }, [nutritionalStatus.outdated_rows, availableMetrics, modalMetricTab]);

  const currentStatusModalRows: NutritionalStatusModalRow[] = useMemo(() => {
    if (activeModal !== 'monitor' && activeModal !== 'monitor_closely') return [];
    const metric: MetricKey = modalMetricTab === 'all' ? 'bmi' : modalMetricTab;
    return activeModal === 'monitor'
      ? nutritionalStatus.monitor_rows[metric]
      : nutritionalStatus.monitor_closely_rows[metric];
  }, [activeModal, modalMetricTab, nutritionalStatus]);

  return (
    <section className="card bb-card mb-4 overflow-hidden">
      {/* Header */}
      <div className="px-4 pt-4 pb-3 border-bottom" style={{ borderColor: 'rgba(0,0,0,0.06)' }}>
        <div className="d-flex flex-wrap justify-content-between align-items-baseline gap-2">
          <div>
            <div className="d-flex align-items-baseline gap-2 mb-1">
              <h2 className="h5 fw-bold mb-0 text-dark" style={{ letterSpacing: '-0.015em' }}>
                Program Nutritional Status
              </h2>
              <span className="small text-body-secondary bb-num">
                {nutritionalStatus.enrolled_count} enrolled
              </span>
            </div>
            <p className="text-body-secondary small mb-0" style={{ maxWidth: '64ch' }}>
              Latest submitted measurements across auto-enabled metrics. Readings older than 14 days before{' '}
              <span className="bb-num">{formatDate(today)}</span> are flagged outdated.
            </p>
          </div>

          <div className="small text-body-secondary">
            <span>{availableMetrics.map((m) => METRIC_LABEL[m]).join(' · ')}</span>
            {!hasNutritionist && (
              <span className="ms-1 text-muted">· No nutritionist assigned</span>
            )}
          </div>
        </div>
      </div>

      <div className="p-4">
        {/* Base Per-Metric Summary Table */}
        <div className="table-responsive mb-4">
          <table className="bb-ns-table">
            <thead>
              <tr>
                <th>Metric</th>
                <th className="text-end">
                  <span className="bb-status-dot" style={{ backgroundColor: '#24582a' }} />
                  Baseline
                </th>
                <th className="text-end">
                  <span className="bb-status-dot" style={{ backgroundColor: '#956400' }} />
                  Monitor
                </th>
                <th className="text-end">
                  <span className="bb-status-dot" style={{ backgroundColor: '#9f2f2d' }} />
                  Monitor closely
                </th>
                <th className="text-end">Outdated (&gt;14d)</th>
                <th className="text-end">No status</th>
              </tr>
            </thead>
            <tbody>
              {activeMetrics.map((m) => {
                const row = nutritionalStatus.metrics[m];
                return (
                  <tr key={m}>
                    <td>
                      <div className="fw-semibold text-dark">{row.label}</div>
                      <div className="text-body-secondary" style={{ fontSize: '0.75rem' }}>
                        {METRIC_SUBTITLE[m]}
                      </div>
                    </td>
                    <td className="text-end bb-num">
                      <span className={row.baseline_count > 0 ? 'fw-semibold text-dark' : 'text-body-secondary'}>
                        {row.baseline_count}
                      </span>
                    </td>
                    <td className="text-end bb-num">
                      <span
                        className={row.monitor_count > 0 ? 'fw-semibold' : 'text-body-secondary'}
                        style={row.monitor_count > 0 ? { color: '#855b00' } : undefined}
                      >
                        {row.monitor_count}
                      </span>
                    </td>
                    <td className="text-end bb-num">
                      <span
                        className={row.monitor_closely_count > 0 ? 'fw-semibold' : 'text-body-secondary'}
                        style={row.monitor_closely_count > 0 ? { color: '#9f2f2d' } : undefined}
                      >
                        {row.monitor_closely_count}
                      </span>
                    </td>
                    <td
                      className="text-end bb-num"
                      title="Subset overlay across Baseline, Monitor, and Monitor closely rows older than 14 days"
                    >
                      <span
                        className={row.outdated_count > 0 ? 'fw-medium' : 'text-body-secondary'}
                        style={row.outdated_count > 0 ? { color: '#855b00' } : undefined}
                      >
                        {row.outdated_count}
                      </span>
                    </td>
                    <td className="text-end bb-num text-body-secondary">
                      {row.no_status_count}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {/* Drilldown Action Bar */}
        <div className="d-flex flex-wrap align-items-center justify-content-between gap-2 pb-4 mb-4 border-bottom" style={{ borderColor: 'rgba(0,0,0,0.06)' }}>
          <div className="d-flex flex-wrap gap-2">
            <button
              type="button"
              className="bb-action-chip"
              onClick={() => openModal('monitor')}
            >
              <span className="bb-status-dot me-0" style={{ backgroundColor: '#956400' }} />
              <span>Monitor</span>
              <span className="bb-num text-body-secondary">{totalMonitorAcrossActive}</span>
            </button>
            <button
              type="button"
              className="bb-action-chip"
              onClick={() => openModal('monitor_closely')}
            >
              <span className="bb-status-dot me-0" style={{ backgroundColor: '#9f2f2d' }} />
              <span>Monitor closely</span>
              <span className="bb-num text-body-secondary">{totalCloselyAcrossActive}</span>
            </button>
            <button
              type="button"
              className="bb-action-chip"
              onClick={() => openModal('outdated')}
            >
              <span>Outdated</span>
              <span className="bb-num text-body-secondary">
                {nutritionalStatus.outdated_rows.filter((r) => availableMetrics.includes(r.metric)).length}
              </span>
            </button>
            <button
              type="button"
              className="bb-action-chip bb-action-chip-primary"
              onClick={() => openModal('view_beneficiaries')}
            >
              <span>View beneficiaries</span>
              <span className="bb-num opacity-75">{qualifyingBeneficiaries.length}</span>
            </button>
          </div>
          <div className="small text-body-secondary" style={{ fontSize: '0.77rem' }}>
            Complete across {activeMetrics.map((m) => METRIC_LABEL[m]).join(', ')}
          </div>
        </div>

        {/* Sub-view Switcher: Per-Beneficiary History vs. Status Transitions */}
        <div className="bb-tab-bar" role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === 'history'}
            className={`bb-tab-btn ${activeTab === 'history' ? 'is-active' : ''}`}
            onClick={() => setActiveTab('history')}
          >
            Per-Beneficiary History <span className="bb-num opacity-75 ms-1">{beneficiaries.length}</span>
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === 'transitions'}
            className={`bb-tab-btn ${activeTab === 'transitions' ? 'is-active' : ''}`}
            onClick={() => setActiveTab('transitions')}
          >
            Status Transitions (First vs. Latest)
          </button>
        </div>

        {/* Panel A: Expandable Per-Beneficiary History View */}
        {activeTab === 'history' && (
          <div>
            <div className="d-flex flex-wrap justify-content-between align-items-center gap-2 mb-3">
              <div className="input-group input-group-sm" style={{ maxWidth: '300px' }}>
                <span className="input-group-text bg-white text-body-secondary">Search</span>
                <input
                  type="text"
                  className="form-control"
                  placeholder="Code, name, or alias..."
                  value={historySearch}
                  onChange={(e) => {
                    setHistorySearch(e.target.value);
                    setHistoryPage(1);
                  }}
                />
              </div>
              <div className="text-body-secondary" style={{ fontSize: '0.78rem' }}>
                Select a row to inspect session history and numeric deltas
              </div>
            </div>

            <div className="table-responsive">
              <table className="bb-ns-table">
                <thead>
                  <tr>
                    <th style={{ width: 28 }} aria-label="Expand" />
                    <th>Beneficiary</th>
                    {availableMetrics.map((m) => (
                      <th key={m}>{METRIC_LABEL[m]}</th>
                    ))}
                    <th className="text-end">Recency</th>
                  </tr>
                </thead>
                <tbody>
                  {pagedBeneficiaries.length === 0 ? (
                    <tr>
                      <td colSpan={3 + availableMetrics.length} className="text-center py-4 text-body-secondary">
                        No matching beneficiaries found.
                      </td>
                    </tr>
                  ) : (
                    pagedBeneficiaries.map((b) => {
                      const isExpanded = Boolean(expandedCodes[b.beneficiary_code]);
                      return (
                        <FragmentRow
                          key={b.beneficiary_code}
                          beneficiary={b}
                          availableMetrics={availableMetrics}
                          isExpanded={isExpanded}
                          onToggle={() => toggleExpandRow(b.beneficiary_code)}
                        />
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>

            {totalHistoryPages > 1 && (
              <div className="d-flex justify-content-between align-items-center mt-3 pt-2 border-top small" style={{ borderColor: 'rgba(0,0,0,0.06)' }}>
                <span className="text-body-secondary bb-num">
                  Page {safeHistoryPage} of {totalHistoryPages} · {filteredBeneficiaries.length} beneficiaries
                </span>
                <div className="d-flex gap-2">
                  <button
                    type="button"
                    className="bb-action-chip py-1 px-2"
                    disabled={safeHistoryPage === 1}
                    onClick={() => setHistoryPage((p) => Math.max(1, p - 1))}
                  >
                    Previous
                  </button>
                  <button
                    type="button"
                    className="bb-action-chip py-1 px-2"
                    disabled={safeHistoryPage === totalHistoryPages}
                    onClick={() => setHistoryPage((p) => Math.min(totalHistoryPages, p + 1))}
                  >
                    Next
                  </button>
                </div>
              </div>
            )}
          </div>
        )}

        {/* Panel B: First-vs-Latest Cohort Status Transitions */}
        {activeTab === 'transitions' && (
          <div>
            {submittedSessions.length === 0 ? (
              <div className="text-body-secondary small py-4 text-center">
                No submitted sessions yet. Cohort transitions appear once at least one session is submitted.
              </div>
            ) : (
              <>
                <div className="bb-train-bar d-flex flex-column flex-sm-row align-items-stretch align-items-sm-center justify-content-between gap-3 mb-4">
                  <div className="small text-body-secondary">
                    <div className="fw-medium text-dark">All enrolled beneficiaries</div>
                    <div className="bb-num" style={{ fontSize: '0.77rem' }}>
                      First vs. latest submitted reading across {totalSubmittedSessions} submitted session
                      {totalSubmittedSessions === 1 ? '' : 's'}
                    </div>
                  </div>

                  <div className="flex-shrink-0">
                    <label
                      htmlFor="bb-attendance-filter"
                      className="d-block text-uppercase fw-semibold text-body-secondary mb-1"
                      style={{ fontSize: '0.68rem', letterSpacing: '0.06em' }}
                    >
                      Minimum Sessions Attended
                    </label>
                    <select
                      id="bb-attendance-filter"
                      className="form-select bb-attendance-select bb-num"
                      value={effectiveMinAttendance}
                      onChange={(e) => setMinAttendance(Number(e.target.value))}
                    >
                      {Array.from({ length: maxSubmittedSessions }, (_, idx) => idx + 1).map(
                        (count) => (
                          <option key={count} value={count}>
                            {count === 1
                              ? 'All beneficiaries (1+ sessions)'
                              : count === maxSubmittedSessions && maxSubmittedSessions > 1
                              ? `Attended all ${count} sessions`
                              : `Attended at least ${count} sessions`}
                          </option>
                        )
                      )}
                    </select>
                  </div>
                </div>

                <div className="table-responsive">
                  <table className="bb-ns-table">
                    <thead>
                      <tr>
                        <th style={{ width: '19%' }}>Metric</th>
                        <th>First → Latest Status Flow</th>
                        <th className="text-end" style={{ width: '15%' }}>Single Reading</th>
                        <th className="text-end" style={{ width: '13%' }}>Cohort List</th>
                      </tr>
                    </thead>
                    <tbody>
                      {cohortByMetric.map((rep) => (
                        <tr key={rep.metric}>
                          <td className="align-top pt-3">
                            <div className="fw-semibold text-dark">{METRIC_LABEL[rep.metric]}</div>
                            <div className="text-body-secondary" style={{ fontSize: '0.74rem' }}>
                              {METRIC_SUBTITLE[rep.metric]}
                            </div>
                            <div className="text-body-secondary bb-num mt-1" style={{ fontSize: '0.73rem' }}>
                              {rep.cohortRows.length} in cohort
                            </div>
                          </td>
                          <td className="align-middle">
                            <MetricCohortSankey
                              rows={rep.cohortRows}
                              improvedCount={rep.improvedCount}
                              unchangedCount={rep.unchangedCount}
                              declinedCount={rep.declinedCount}
                            />
                          </td>
                          <td className="text-end align-top pt-3 bb-num">
                            <div
                              className={
                                rep.singleMeasurementCount > 0
                                  ? 'fw-semibold text-dark'
                                  : 'text-body-secondary'
                              }
                            >
                              {rep.singleMeasurementCount}
                            </div>
                            <div className="text-body-secondary" style={{ fontSize: '0.72rem' }}>
                              1 measurement
                            </div>
                          </td>
                          <td className="text-end align-top pt-3">
                            <button
                              type="button"
                              className="bb-action-chip"
                              onClick={() => openCohortModal(rep.metric)}
                              disabled={rep.cohortRows.length === 0}
                            >
                              List ({rep.cohortRows.length})
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            )}
          </div>
        )}
      </div>

      {/* AI Longitudinal Trend panel remains intentionally hidden (ghost feature) */}

      {/* Modals via Portal */}
      {mounted &&
        activeModal &&
        createPortal(
          <div
            className="bb-modal-overlay"
            role="presentation"
            onClick={(e) => {
              if (e.target === e.currentTarget) setActiveModal(null);
            }}
          >
            <div
              ref={modalRef}
              tabIndex={-1}
              className="bb-modal-dialog card shadow-lg border-0"
              style={{ maxWidth: '880px' }}
              role="dialog"
              aria-modal="true"
            >
              <div className="card-header bg-white border-bottom p-3 d-flex justify-content-between align-items-center">
                <div>
                  <h3 className="h6 fw-bold mb-0 text-dark">
                    {activeModal === 'monitor' && 'Monitor Status — Enrollees by Metric'}
                    {activeModal === 'monitor_closely' && 'Monitor Closely — Enrollees by Metric'}
                    {activeModal === 'outdated' && 'Outdated Measurements (> 14 days before today)'}
                    {activeModal === 'view_beneficiaries' &&
                      `Beneficiaries Measured for ${activeMetrics.map((m) => METRIC_LABEL[m]).join(' + ')}`}
                    {activeModal === 'cohort_transitions' &&
                      `${METRIC_LABEL[transitionModalMetric]} — Cohort Status Transitions`}
                  </h3>
                  <div className="small text-body-secondary mt-1 bb-num">
                    {activeModal === 'view_beneficiaries'
                      ? `${qualifyingBeneficiaries.length} enrolled · ${qualifyingOutdatedBeneficiariesCount} with ≥1 outdated metric`
                      : activeModal === 'cohort_transitions'
                      ? `${
                          effectiveMinAttendance === 1
                            ? 'All beneficiaries (1+ sessions attended)'
                            : effectiveMinAttendance === totalSubmittedSessions && totalSubmittedSessions > 1
                            ? `Attended all ${totalSubmittedSessions} submitted sessions`
                            : `Attended at least ${effectiveMinAttendance} of ${totalSubmittedSessions} submitted sessions`
                        } • ${modalCohortRows.length} ${
                          modalCohortRows.length === 1 ? 'beneficiary' : 'beneficiaries'
                        }`
                      : `Calculated from latest submitted rows against ${formatDate(today)}`}
                  </div>
                </div>
                <button
                  type="button"
                  className="btn-close"
                  aria-label="Close modal"
                  onClick={() => setActiveModal(null)}
                />
              </div>

              <div className="card-body p-3 overflow-y-auto" style={{ maxHeight: '72vh' }}>
                {/* Per-metric Subtabs for Monitor, Monitor Closely, and Outdated */}
                {(activeModal === 'monitor' ||
                  activeModal === 'monitor_closely' ||
                  activeModal === 'outdated') && (
                  <ul className="nav nav-tabs mb-3">
                    {activeModal === 'outdated' && (
                      <li className="nav-item">
                        <button
                          type="button"
                          className={`nav-link small ${modalMetricTab === 'all' ? 'active fw-semibold' : ''}`}
                          onClick={() => setModalMetricTab('all')}
                        >
                          All metrics ({nutritionalStatus.outdated_rows.filter((r) => availableMetrics.includes(r.metric)).length})
                        </button>
                      </li>
                    )}
                    {availableMetrics.map((m) => {
                      const cnt =
                        activeModal === 'monitor'
                          ? nutritionalStatus.monitor_rows[m].length
                          : activeModal === 'monitor_closely'
                          ? nutritionalStatus.monitor_closely_rows[m].length
                          : nutritionalStatus.outdated_rows.filter((r) => r.metric === m).length;
                      return (
                        <li key={m} className="nav-item">
                          <button
                            type="button"
                            className={`nav-link small ${modalMetricTab === m ? 'active fw-semibold' : ''}`}
                            onClick={() => setModalMetricTab(m)}
                          >
                            {METRIC_LABEL[m]} ({cnt})
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                )}

                {/* Modal Content: Monitor / Monitor Closely */}
                {(activeModal === 'monitor' || activeModal === 'monitor_closely') && (
                  <div className="table-responsive">
                    <table className="table table-sm table-hover align-middle mb-0 small border">
                      <thead className="table-light">
                        <tr>
                          <th>Code</th>
                          <th>Name / Alias</th>
                          <th>Latest Value</th>
                          <th>Status Date</th>
                          <th>Freshness</th>
                        </tr>
                      </thead>
                      <tbody>
                        {currentStatusModalRows.length === 0 ? (
                          <tr>
                            <td colSpan={5} className="text-center py-4 text-body-secondary">
                              No enrollees currently at this status for {modalMetricTab === 'all' ? 'this metric' : METRIC_LABEL[modalMetricTab]}.
                            </td>
                          </tr>
                        ) : (
                          currentStatusModalRows.map((row) => (
                            <tr key={`${row.metric}_${row.beneficiary_code}`}>
                              <td className="bb-num fw-semibold">{row.beneficiary_code}</td>
                              <td>{row.display_name}</td>
                              <td className="bb-num fw-semibold">{row.latest_value_display}</td>
                              <td className="bb-num">{formatDate(row.session_date)}</td>
                              <td>
                                {row.is_outdated ? (
                                  <span className="badge badge-pale-warning bb-num">
                                    Outdated · {row.days_old}d ago
                                  </span>
                                ) : (
                                  <span className="badge badge-pale-success bb-num">
                                    Current · {row.days_old}d ago
                                  </span>
                                )}
                              </td>
                            </tr>
                          ))
                        )}
                      </tbody>
                    </table>
                  </div>
                )}

                {/* Modal Content: Outdated */}
                {activeModal === 'outdated' && (
                  <div className="table-responsive">
                    <table className="table table-sm table-hover align-middle mb-0 small border">
                      <thead className="table-light">
                        <tr>
                          <th>Code</th>
                          <th>Name / Alias</th>
                          <th>Metric Key</th>
                          <th>Status</th>
                          <th>Status Date</th>
                          <th className="text-end">Days Old</th>
                        </tr>
                      </thead>
                      <tbody>
                        {filteredOutdatedRows.length === 0 ? (
                          <tr>
                            <td colSpan={6} className="text-center py-4 text-body-secondary">
                              No outdated measurements found for this selection.
                            </td>
                          </tr>
                        ) : (
                          filteredOutdatedRows.map((row) => (
                            <tr key={`${row.metric}_${row.beneficiary_code}`}>
                              <td className="bb-num fw-semibold">{row.beneficiary_code}</td>
                              <td>{row.display_name}</td>
                              <td>
                                <code>{row.metric}</code> ({METRIC_LABEL[row.metric]})
                              </td>
                              <td>
                                <span className={`badge ${STATUS_BADGE_CLASS[row.status_key]}`}>
                                  {STATUS_LABEL[row.status_key]}
                                </span>
                              </td>
                              <td className="bb-num">{formatDate(row.session_date)}</td>
                              <td className="text-end bb-num fw-semibold text-warning-emphasis">
                                {row.days_old}d
                              </td>
                            </tr>
                          ))
                        )}
                      </tbody>
                    </table>
                  </div>
                )}

                {/* Modal Content: View Beneficiaries */}
                {activeModal === 'view_beneficiaries' && (
                  <div>
                    <div className="alert alert-light border small d-flex justify-content-between align-items-center mb-3 py-2">
                      <span>
                        Showing enrollees with latest status rows for all of:{' '}
                        <strong>{activeMetrics.map((m) => METRIC_LABEL[m]).join(', ')}</strong>
                      </span>
                      <span className="badge badge-pale-warning bb-num">
                        {qualifyingOutdatedBeneficiariesCount} outdated among selection
                      </span>
                    </div>
                    <div className="table-responsive">
                      <table className="table table-sm table-hover align-middle mb-0 small border">
                        <thead className="table-light">
                          <tr>
                            <th>Code</th>
                            <th>Name / Alias</th>
                            {activeMetrics.map((m) => (
                              <th key={m}>{METRIC_LABEL[m]}</th>
                            ))}
                            <th>Last Measured</th>
                          </tr>
                        </thead>
                        <tbody>
                          {qualifyingBeneficiaries.length === 0 ? (
                            <tr>
                              <td
                                colSpan={3 + activeMetrics.length}
                                className="text-center py-4 text-body-secondary"
                              >
                                No enrollees have status rows for all selected metrics simultaneously.
                              </td>
                            </tr>
                          ) : (
                            qualifyingBeneficiaries.map(({ beneficiary: b }) => (
                              <tr key={b.beneficiary_code}>
                                <td className="bb-num fw-semibold">{b.beneficiary_code}</td>
                                <td>{b.displayName}</td>
                                {activeMetrics.map((m) => {
                                  const st = b.latest_statuses[m]!;
                                  return (
                                    <td key={m}>
                                      <div className="d-flex flex-column gap-1">
                                        <span className={`badge ${STATUS_BADGE_CLASS[st.status_key]}`}>
                                          {STATUS_LABEL[st.status_key]}
                                        </span>
                                        <span className="bb-num text-body-secondary" style={{ fontSize: '0.7rem' }}>
                                          {formatDate(st.session_date)}
                                          {st.is_outdated && (
                                            <span className="text-warning-emphasis ms-1">(outdated)</span>
                                          )}
                                        </span>
                                      </div>
                                    </td>
                                  );
                                })}
                                <td className="bb-num">
                                  {b.last_measured_sessions_ago == null
                                    ? '—'
                                    : b.last_measured_sessions_ago === 0
                                    ? 'Latest session'
                                    : `${b.last_measured_sessions_ago} session${b.last_measured_sessions_ago === 1 ? '' : 's'} ago`}
                                </td>
                              </tr>
                            ))
                          )}
                        </tbody>
                      </table>
                    </div>
                  </div>
                )}

                {/* Modal Content: Cohort Status Transitions (List N) */}
                {activeModal === 'cohort_transitions' && (
                  <div className="table-responsive">
                    <table className="bb-ns-table">
                      <thead>
                        <tr>
                          <th>Code</th>
                          <th>Beneficiary</th>
                          <th>First Session &amp; Status</th>
                          <th>Latest Session &amp; Status</th>
                          <th className="text-end">Net Change</th>
                          <th>Tag</th>
                        </tr>
                      </thead>
                      <tbody>
                        {modalCohortRows.length === 0 ? (
                          <tr>
                            <td colSpan={6} className="text-center py-4 text-body-secondary">
                              No beneficiaries match the selected attendance filter.
                            </td>
                          </tr>
                        ) : (
                          modalCohortRows.map((row) => {
                            const tagMeta = COHORT_TRANSITION_TAG_META[row.transition_tag];
                            const changeStr = formatCohortNetChange(
                              row.metric,
                              row.net_change,
                              row.measurement_count
                            );
                            const changeColor =
                              changeStr === '—'
                                ? '#6b7280'
                                : row.transition_tag === 'improved'
                                ? '#24582a'
                                : row.transition_tag === 'declined'
                                ? '#9f2f2d'
                                : '#475569';

                            return (
                              <tr key={`${row.metric}_${row.beneficiary_code}`}>
                                <td className="bb-num fw-semibold text-dark">
                                  #{row.beneficiary_code}
                                </td>
                                <td className="fw-medium text-dark">{row.display_name}</td>
                                <td>
                                  <div className="d-flex flex-column align-items-start gap-1">
                                    <span className={`bb-status-chip ${STATUS_BADGE_CLASS[row.first_status]}`}>
                                      {STATUS_LABEL[row.first_status]}
                                    </span>
                                    <span className="text-body-secondary bb-num" style={{ fontSize: '0.73rem' }}>
                                      S{row.first_session_number} · {formatDate(row.first_session_date)} ·{' '}
                                      {row.first_value_display}
                                    </span>
                                  </div>
                                </td>
                                <td>
                                  <div className="d-flex flex-column align-items-start gap-1">
                                    <span className={`bb-status-chip ${STATUS_BADGE_CLASS[row.latest_status]}`}>
                                      {STATUS_LABEL[row.latest_status]}
                                    </span>
                                    <span className="text-body-secondary bb-num" style={{ fontSize: '0.73rem' }}>
                                      S{row.latest_session_number} · {formatDate(row.latest_session_date)} ·{' '}
                                      {row.latest_value_display}
                                    </span>
                                  </div>
                                </td>
                                <td
                                  className="text-end bb-num fw-medium"
                                  style={{ color: changeColor }}
                                >
                                  {changeStr}
                                </td>
                                <td>
                                  <span className={`bb-status-chip ${tagMeta.badgeClass}`}>
                                    {tagMeta.label}
                                  </span>
                                </td>
                              </tr>
                            );
                          })
                        )}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>

              <div className="card-footer bg-white border-top p-3 text-end">
                <button
                  type="button"
                  className="btn btn-sm btn-secondary"
                  onClick={() => setActiveModal(null)}
                >
                  Close
                </button>
              </div>
            </div>
          </div>,
          document.body
        )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Inline First-vs-Latest Cohort Sankey Flow Diagram
// ---------------------------------------------------------------------------

const SANKEY_STATUS_ORDER: StatusKey[] = ['baseline', 'monitor', 'monitor_closely'];

const SANKEY_STATUS_COLOR: Record<StatusKey, string> = {
  baseline: '#24582a',
  monitor: '#956400',
  monitor_closely: '#9f2f2d',
};

function MetricCohortSankey({
  rows,
  improvedCount,
  unchangedCount,
  declinedCount,
}: {
  rows: BeneficiaryCohortRow[];
  improvedCount: number;
  unchangedCount: number;
  declinedCount: number;
}) {
  const multiRows = rows.filter((r) => r.measurement_count >= 2);
  if (multiRows.length === 0) {
    return (
      <div className="bb-sankey-empty">
        {rows.length === 0
          ? 'No beneficiaries match this attendance filter.'
          : 'No multi-session transitions in this cohort yet.'}
      </div>
    );
  }

  const total = multiRows.length;
  const firstCounts: Record<StatusKey, number> = {
    baseline: 0,
    monitor: 0,
    monitor_closely: 0,
  };
  const latestCounts: Record<StatusKey, number> = {
    baseline: 0,
    monitor: 0,
    monitor_closely: 0,
  };
  const pairCounts = new Map<string, number>();

  for (const r of multiRows) {
    firstCounts[r.first_status]++;
    latestCounts[r.latest_status]++;
    const key = `${r.first_status}__${r.latest_status}`;
    pairCounts.set(key, (pairCounts.get(key) ?? 0) + 1);
  }

  const SVG_H = 112;
  const GAP = 9;
  const MIN_SLOT_H = 18;
  const flowScale = 54 / total;
  const leftBarX = 128;
  const rightBarX = 364;
  const barW = 8;
  const x0 = leftBarX + barW;
  const x1 = rightBarX;
  const cx = (x0 + x1) / 2;

  const buildColumn = (counts: Record<StatusKey, number>) => {
    const slots = SANKEY_STATUS_ORDER.map((status) => {
      const count = counts[status];
      const flowH = count * flowScale;
      const visualH = Math.max(MIN_SLOT_H, flowH);
      return { status, count, flowH, visualH };
    });
    const totalH = slots.reduce((sum, s) => sum + s.visualH, 0) + GAP * (slots.length - 1);
    let y = (SVG_H - totalH) / 2;
    const byStatus = {} as Record<
      StatusKey,
      { status: StatusKey; count: number; slotY: number; visualH: number; flowY: number; flowH: number }
    >;
    for (const s of slots) {
      const flowY = y + (s.visualH - s.flowH) / 2;
      byStatus[s.status] = { ...s, slotY: y, flowY };
      y += s.visualH + GAP;
    }
    return byStatus;
  };

  const leftCol = buildColumn(firstCounts);
  const rightCol = buildColumn(latestCounts);

  const leftCursor: Record<StatusKey, number> = {
    baseline: leftCol.baseline.flowY,
    monitor: leftCol.monitor.flowY,
    monitor_closely: leftCol.monitor_closely.flowY,
  };
  const rightCursor: Record<StatusKey, number> = {
    baseline: rightCol.baseline.flowY,
    monitor: rightCol.monitor.flowY,
    monitor_closely: rightCol.monitor_closely.flowY,
  };

  const links: {
    key: string;
    d: string;
    fill: string;
    fillOpacity: number;
    title: string;
  }[] = [];

  for (const fromStatus of SANKEY_STATUS_ORDER) {
    for (const toStatus of SANKEY_STATUS_ORDER) {
      const count = pairCounts.get(`${fromStatus}__${toStatus}`) ?? 0;
      if (count === 0) continue;

      const sliceH = count * flowScale;
      const y0Top = leftCursor[fromStatus];
      const y0Bot = y0Top + sliceH;
      leftCursor[fromStatus] = y0Bot;

      const y1Top = rightCursor[toStatus];
      const y1Bot = y1Top + sliceH;
      rightCursor[toStatus] = y1Bot;

      const halfDraw = Math.max(1, sliceH / 2);
      const y0Mid = (y0Top + y0Bot) / 2;
      const y1Mid = (y1Top + y1Bot) / 2;
      const r0Top = sliceH < 2 ? y0Mid - halfDraw : y0Top;
      const r0Bot = sliceH < 2 ? y0Mid + halfDraw : y0Bot;
      const r1Top = sliceH < 2 ? y1Mid - halfDraw : y1Top;
      const r1Bot = sliceH < 2 ? y1Mid + halfDraw : y1Bot;

      const sevDelta = STATUS_SEVERITY[toStatus] - STATUS_SEVERITY[fromStatus];
      const fill = sevDelta < 0 ? '#1f9d55' : sevDelta > 0 ? '#dc2626' : '#64748b';
      const fillOpacity = sevDelta === 0 ? 0.28 : 0.42;

      const d = `M ${x0} ${r0Top.toFixed(2)} C ${cx} ${r0Top.toFixed(2)}, ${cx} ${r1Top.toFixed(
        2
      )}, ${x1} ${r1Top.toFixed(2)} L ${x1} ${r1Bot.toFixed(2)} C ${cx} ${r1Bot.toFixed(
        2
      )}, ${cx} ${r0Bot.toFixed(2)}, ${x0} ${r0Bot.toFixed(2)} Z`;

      links.push({
        key: `${fromStatus}_${toStatus}`,
        d,
        fill,
        fillOpacity,
        title: `${STATUS_LABEL[fromStatus]} → ${STATUS_LABEL[toStatus]}: ${count}`,
      });
    }
  }

  return (
    <div className="bb-sankey-wrap">
      <svg
        viewBox={`0 0 500 ${SVG_H}`}
        className="bb-sankey-svg"
        role="img"
        aria-label="First status to latest status cohort flow"
      >
        {/* Transition ribbons */}
        {links.map((lnk) => (
          <path key={lnk.key} d={lnk.d} fill={lnk.fill} fillOpacity={lnk.fillOpacity}>
            <title>{lnk.title}</title>
          </path>
        ))}

        {/* Left column nodes (First Status) */}
        {SANKEY_STATUS_ORDER.map((status) => {
          const slot = leftCol[status];
          const active = slot.count > 0;
          const barH = active ? Math.max(4, slot.flowH) : 8;
          const barY = active
            ? slot.flowY + (slot.flowH - barH) / 2
            : slot.slotY + (slot.visualH - barH) / 2;
          const labelY = slot.slotY + slot.visualH / 2;
          return (
            <g key={`left_${status}`}>
              <rect
                x={leftBarX}
                y={barY}
                width={barW}
                height={barH}
                rx={2.5}
                fill={active ? SANKEY_STATUS_COLOR[status] : '#e5e7eb'}
              />
              <text
                x={leftBarX - 8}
                y={labelY}
                textAnchor="end"
                dominantBaseline="central"
                fontSize="10.5"
                fontWeight={active ? 600 : 400}
                fill={active ? '#1a1e1b' : '#9ca3af'}
              >
                {STATUS_LABEL[status]} ({slot.count})
              </text>
            </g>
          );
        })}

        {/* Right column nodes (Latest Status) */}
        {SANKEY_STATUS_ORDER.map((status) => {
          const slot = rightCol[status];
          const active = slot.count > 0;
          const barH = active ? Math.max(4, slot.flowH) : 8;
          const barY = active
            ? slot.flowY + (slot.flowH - barH) / 2
            : slot.slotY + (slot.visualH - barH) / 2;
          const labelY = slot.slotY + slot.visualH / 2;
          return (
            <g key={`right_${status}`}>
              <rect
                x={rightBarX}
                y={barY}
                width={barW}
                height={barH}
                rx={2.5}
                fill={active ? SANKEY_STATUS_COLOR[status] : '#e5e7eb'}
              />
              <text
                x={rightBarX + barW + 8}
                y={labelY}
                textAnchor="start"
                dominantBaseline="central"
                fontSize="10.5"
                fontWeight={active ? 600 : 400}
                fill={active ? '#1a1e1b' : '#9ca3af'}
              >
                {STATUS_LABEL[status]} ({slot.count})
              </text>
            </g>
          );
        })}
      </svg>

      <div className="bb-sankey-legend bb-num">
        <span className="d-inline-flex align-items-center gap-1">
          <span className="bb-status-dot me-0" style={{ backgroundColor: '#1f9d55' }} />
          <span>{improvedCount} improved</span>
        </span>
        <span className="d-inline-flex align-items-center gap-1">
          <span className="bb-status-dot me-0" style={{ backgroundColor: '#64748b' }} />
          <span>{unchangedCount} unchanged</span>
        </span>
        <span className="d-inline-flex align-items-center gap-1">
          <span className="bb-status-dot me-0" style={{ backgroundColor: '#dc2626' }} />
          <span>{declinedCount} declined</span>
        </span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Expandable Beneficiary Row + Full Insert-Only History Subpanel
// ---------------------------------------------------------------------------

function FragmentRow({
  beneficiary: b,
  availableMetrics,
  isExpanded,
  onToggle,
}: {
  beneficiary: BeneficiaryData;
  availableMetrics: MetricKey[];
  isExpanded: boolean;
  onToggle: () => void;
}) {
  const sessAgo = b.last_measured_sessions_ago;

  return (
    <>
      <tr
        onClick={onToggle}
        className={`bb-history-row ${isExpanded ? 'is-expanded' : ''}`}
        aria-expanded={isExpanded}
      >
        <td className="text-center text-body-secondary">
          <svg
            width="12"
            height="12"
            viewBox="0 0 12 12"
            fill="none"
            aria-hidden="true"
            style={{
              transform: isExpanded ? 'rotate(90deg)' : 'rotate(0deg)',
              transition: 'transform 0.15s ease',
            }}
          >
            <path
              d="M4.25 2.5L7.75 6L4.25 9.5"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </td>
        <td>
          <div className="fw-semibold text-dark">{b.displayName}</div>
          <div className="text-body-secondary bb-num" style={{ fontSize: '0.73rem' }}>
            #{b.beneficiary_code} · {b.age}y · {b.sex === 'female' ? 'F' : 'M'}
          </div>
        </td>
        {availableMetrics.map((m) => {
          const st = b.latest_statuses[m];
          if (!st) {
            return (
              <td key={m} className="text-body-secondary">
                —
              </td>
            );
          }
          return (
            <td key={m}>
              <div className="d-flex flex-column align-items-start gap-1">
                <span className={`bb-status-chip ${STATUS_BADGE_CLASS[st.status_key]}`}>
                  {STATUS_LABEL[st.status_key]}
                </span>
                <div className="text-body-secondary bb-num" style={{ fontSize: '0.72rem' }}>
                  <span>{st.latest_value_display}</span>
                  {st.is_outdated && (
                    <span className="ms-1" style={{ color: '#855b00' }}>
                      · &gt;14d
                    </span>
                  )}
                </div>
              </div>
            </td>
          );
        })}
        <td className="text-end bb-num">
          {sessAgo == null ? (
            <span className="text-body-secondary">Pending</span>
          ) : sessAgo === 0 ? (
            <span className="fw-medium" style={{ color: '#24582a' }}>
              Latest session
            </span>
          ) : (
            <span className="fw-medium" style={{ color: '#855b00' }}>
              {sessAgo} session{sessAgo === 1 ? '' : 's'} ago
            </span>
          )}
        </td>
      </tr>

      {isExpanded && (
        <tr>
          <td colSpan={3 + availableMetrics.length} className="bb-history-drawer p-3 p-md-4">
            {/* Header & Compact Status/Skipped-Week Legend */}
            <div
              className="d-flex flex-wrap justify-content-between align-items-center gap-2 pb-3 mb-2 border-bottom"
              style={{ borderColor: 'rgba(0,0,0,0.06)' }}
            >
              <div className="small fw-semibold text-dark">
                Session history · {b.displayName}{' '}
                <span className="text-body-secondary fw-normal bb-num">#{b.beneficiary_code}</span>
              </div>
              <div
                className="d-flex flex-wrap align-items-center gap-3 text-body-secondary"
                style={{ fontSize: '0.73rem' }}
              >
                <span className="d-inline-flex align-items-center gap-1">
                  <span className="bb-status-dot me-0" style={{ backgroundColor: '#15803d' }} />
                  <span>Baseline</span>
                </span>
                <span className="d-inline-flex align-items-center gap-1">
                  <span className="bb-status-dot me-0" style={{ backgroundColor: '#d97706' }} />
                  <span>Monitor</span>
                </span>
                <span className="d-inline-flex align-items-center gap-1">
                  <span className="bb-status-dot me-0" style={{ backgroundColor: '#dc2626' }} />
                  <span>Monitor closely</span>
                </span>
                <span className="d-inline-flex align-items-center gap-1">
                  <span className="bb-serpentine-bead" aria-hidden="true" />
                  <span>Skipped week</span>
                </span>
              </div>
            </div>

            {/* Per-Metric Rows: Left Summary + Right Serpentine Week Rail */}
            <div>
              {availableMetrics.map((m) => {
                const points: MetricStatusHistoryPoint[] = b.metric_history[m] ?? [];
                const latestPt = points.length > 0 ? points[points.length - 1] : null;
                const rawNetChange = points.reduce((sum, pt) => sum + (pt.change_value ?? 0), 0);
                const netChange = Math.round(rawNetChange * 1000) / 1000;

                const measurementWeekBySession = new Map<string, number | null>(
                  b.measurements.map((mm) => [mm.session_id, mm.week_number])
                );
                const nodes: SerpentineNode[] = points.map((pt, idx) => ({
                  session_id: pt.session_id,
                  session_date: pt.session_date,
                  status_key: pt.status_key,
                  change_value: pt.change_value,
                  weekNum: pt.week_number ?? measurementWeekBySession.get(pt.session_id) ?? idx + 1,
                  globalIdx: idx,
                }));

                return (
                  <div key={m} className="bb-serpentine-metric-row">
                    {/* Left Fixed Summary Column */}
                    <div className="bb-serpentine-summary">
                      <div className="d-flex align-items-baseline gap-1">
                        <span className="fw-semibold text-dark small">{METRIC_LABEL[m]}</span>
                        <span className="text-body-secondary bb-num" style={{ fontSize: '0.73rem' }}>
                          ({points.length} recorded)
                        </span>
                      </div>
                      <div
                        className="d-flex flex-wrap align-items-center gap-1 mt-1"
                        style={{ fontSize: '0.76rem' }}
                      >
                        {!latestPt ? (
                          <span className="text-body-secondary">Not measured</span>
                        ) : (
                          <>
                            <span
                              className="bb-status-dot me-0"
                              style={{ backgroundColor: HISTORY_STATUS_DOT_COLOR[latestPt.status_key] }}
                            />
                            <span className="fw-medium text-dark">
                              {STATUS_LABEL[latestPt.status_key]}
                            </span>
                            <span className="text-body-secondary">·</span>
                            {m === 'edema' ? (
                              <span
                                className="fw-semibold"
                                style={{
                                  color:
                                    latestPt.status_key === 'monitor_closely' ? '#9f2f2d' : '#24582a',
                                }}
                              >
                                {latestPt.status_key === 'monitor_closely' ? 'Present' : 'Absent'}
                              </span>
                            ) : points.length === 1 ? (
                              <span className="text-body-secondary">Initial only</span>
                            ) : (
                              <span
                                className="bb-num fw-semibold"
                                style={{
                                  color:
                                    netChange > 0
                                      ? '#24582a'
                                      : netChange < 0
                                      ? '#9f2f2d'
                                      : '#6b7280',
                                }}
                              >
                                Net {netChange > 0 ? '+' : ''}
                                {netChange.toFixed(3)}
                              </span>
                            )}
                          </>
                        )}
                      </div>
                    </div>

                    {/* Right Serpentine Week Rail */}
                    <div className="bb-serpentine-rail-col">
                      <MetricSerpentineRail metric={m} nodes={nodes} />
                    </div>
                  </div>
                );
              })}
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Serpentine Week Rail (5 nodes/row, L->R then U-turn R->L, with skipped beads)
// ---------------------------------------------------------------------------

type SerpentineNode = {
  session_id: string;
  session_date: string;
  status_key: StatusKey;
  change_value: number | null;
  weekNum: number;
  globalIdx: number;
};

function skippedWeeksLabel(fromWeek: number, toWeek: number): { count: number; title: string } {
  const count = Math.max(0, toWeek - fromWeek - 1);
  if (count === 0) return { count: 0, title: '' };
  const range = count === 1 ? `W${fromWeek + 1}` : `W${fromWeek + 1}–W${toWeek - 1}`;
  return {
    count,
    title: `Skipped ${count} week${count === 1 ? '' : 's'} (${range})`,
  };
}

function MetricSerpentineRail({
  metric,
  nodes,
}: {
  metric: MetricKey;
  nodes: SerpentineNode[];
}) {
  if (nodes.length === 0) {
    return (
      <div className="text-body-secondary py-1" style={{ fontSize: '0.76rem' }}>
        No recorded measurements for this metric.
      </div>
    );
  }

  const CHUNK_SIZE = 5;
  const rows: SerpentineNode[][] = [];
  for (let i = 0; i < nodes.length; i += CHUNK_SIZE) {
    rows.push(nodes.slice(i, i + CHUNK_SIZE));
  }

  return (
    <div className="bb-serpentine-grid-wrap">
      {rows.map((rowNodes, rowIdx) => {
        const isReversed = rowIdx % 2 === 1;
        const hasNextRow = rowIdx < rows.length - 1;
        const wrapGap = hasNextRow
          ? skippedWeeksLabel(
              rowNodes[rowNodes.length - 1].weekNum,
              rows[rowIdx + 1][0].weekNum
            )
          : { count: 0, title: '' };

        return (
          <div key={`row_${rowIdx}`} className="bb-serpentine-row-block">
            {/* Horizontal connecting rail segments + skipped-week slate beads */}
            {rowNodes.slice(0, -1).map((currNode, pos) => {
              const nextNode = rowNodes[pos + 1];
              const slotA = isReversed ? CHUNK_SIZE - 1 - pos : pos;
              const slotB = isReversed ? CHUNK_SIZE - 1 - (pos + 1) : pos + 1;
              const leftSlot = Math.min(slotA, slotB);
              const gap = skippedWeeksLabel(currNode.weekNum, nextNode.weekNum);

              return (
                <div
                  key={`seg_${currNode.session_id}_${nextNode.session_id}`}
                  className="bb-serpentine-seg"
                  style={{
                    left: `${(leftSlot * 2 + 1) * 10}%`,
                    width: '20%',
                  }}
                >
                  {gap.count > 0 && (
                    <span className="bb-serpentine-bead-group" title={gap.title}>
                      {Array.from({ length: Math.min(gap.count, 5) }, (_, k) => (
                        <span key={k} className="bb-serpentine-bead" />
                      ))}
                    </span>
                  )}
                </div>
              );
            })}

            {/* Serpentine U-turn connector wrapping into next row */}
            {hasNextRow && (
              <div
                className={isReversed ? 'bb-serpentine-uturn-left' : 'bb-serpentine-uturn-right'}
                aria-hidden="true"
              >
                {wrapGap.count > 0 && (
                  <span className="bb-serpentine-bead-group is-vertical" title={wrapGap.title}>
                    {Array.from({ length: Math.min(wrapGap.count, 5) }, (_, k) => (
                      <span key={k} className="bb-serpentine-bead" />
                    ))}
                  </span>
                )}
              </div>
            )}

            {/* 5-Column Node Cells */}
            <div className="bb-serpentine-grid-row">
              {rowNodes.map((node, pos) => {
                const slot = isReversed ? CHUNK_SIZE - 1 - pos : pos;
                const isEdema = metric === 'edema';
                const edemaPresent = node.status_key === 'monitor_closely';
                const isInitial = node.globalIdx === 0 || node.change_value == null;

                let deltaLabel: string;
                let deltaColor: string;
                if (isEdema) {
                  deltaLabel = edemaPresent ? 'Edema' : 'No edema';
                  deltaColor = edemaPresent ? '#9f2f2d' : '#24582a';
                } else if (isInitial) {
                  deltaLabel = 'Init';
                  deltaColor = '#6b7280';
                } else {
                  const val = node.change_value!;
                  deltaLabel = `${val > 0 ? '+' : ''}${val.toFixed(3)}`;
                  deltaColor = val > 0 ? '#24582a' : val < 0 ? '#9f2f2d' : '#6b7280';
                }

                return (
                  <div
                    key={`${metric}_${node.session_id}_${node.globalIdx}`}
                    className="bb-serpentine-cell"
                    style={{ gridColumn: slot + 1, gridRow: 1 }}
                  >
                    <div
                      className={`bb-serpentine-node bb-num is-${node.status_key}`}
                      title={`Week ${node.weekNum} · ${formatDate(node.session_date)} · ${STATUS_LABEL[node.status_key]}`}
                    >
                      W{node.weekNum}
                    </div>
                    <div className="bb-serpentine-delta bb-num" style={{ color: deltaColor }}>
                      {deltaLabel}
                    </div>
                    <div className="bb-serpentine-date bb-num">
                      {formatShortMonthDay(node.session_date)}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}
