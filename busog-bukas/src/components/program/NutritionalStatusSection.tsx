'use client';

import { useState, useMemo, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import type {
  BeneficiaryData,
  NutritionalStatusModalRow,
  NutritionalStatusProgramData,
} from '@/lib/programData';
import {
  ALL_METRICS,
  METRIC_LABEL,
  STATUS_BADGE_CLASS,
  STATUS_LABEL,
  TRANSITION_DIRECTION_META,
  computePerMetricTransitions,
  type MetricKey,
  type StatusKey,
  type TransitionDirection,
} from '@/lib/statusRule';
import { addDays } from '@/lib/timelineRules';
import { formatDate } from '@/lib/format';

type Props = {
  nutritionalStatus: NutritionalStatusProgramData;
  beneficiaries: BeneficiaryData[];
  today: string;
};

type ActiveModal = 'monitor' | 'monitor_closely' | 'outdated' | 'view_beneficiaries' | null;
type CardTab = 'history' | 'transitions';

const PAGE_SIZE = 10;

function formatSignedChange(metric: MetricKey, val: number | null): string {
  if (metric === 'edema') return 'Yes/No check';
  if (val == null) return 'Initial row';
  if (val === 0) return '0.000 (unchanged)';
  return `${val > 0 ? '+' : ''}${val.toFixed(3)}`;
}

function getTransitionGroupCounts(
  entries: ReturnType<typeof computePerMetricTransitions>['entries']
) {
  const map = new Map<
    string,
    { fromStatus: StatusKey | null; toStatus: StatusKey; direction: TransitionDirection; count: number }
  >();

  for (const e of entries) {
    const key = `${e.fromStatus ?? 'NEW'}__${e.toStatus}`;
    const existing = map.get(key);
    if (existing) {
      existing.count++;
    } else {
      map.set(key, {
        fromStatus: e.fromStatus,
        toStatus: e.toStatus,
        direction: e.direction,
        count: 1,
      });
    }
  }

  return Array.from(map.values()).sort((a, b) => b.count - a.count);
}

export default function NutritionalStatusSection({
  nutritionalStatus,
  beneficiaries,
  today,
}: Props) {
  const { has_nutritionist: hasNutritionist } = nutritionalStatus;

  // Checkboxes for optional metrics (BMI is always on, never a checkbox)
  const [checkedOptional, setCheckedOptional] = useState<Record<'whtr' | 'muac' | 'edema', boolean>>({
    whtr: true,
    muac: hasNutritionist,
    edema: hasNutritionist,
  });

  // In-card view tabs (Per-Beneficiary History & Past-#-Days Transitions)
  const [activeTab, setActiveTab] = useState<CardTab>('history');

  // History view state
  const [historySearch, setHistorySearch] = useState('');
  const [historyPage, setHistoryPage] = useState(1);
  const [expandedCodes, setExpandedCodes] = useState<Record<string, boolean>>({});

  // Transitions report state ("Past # days", default 14)
  const [lookbackDaysInput, setLookbackDaysInput] = useState<string>('14');
  const [expandedTransitionMetric, setExpandedTransitionMetric] = useState<MetricKey | null>('bmi');

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

  // Available metrics in this program (MUAC and Edema disappear when no nutritionist)
  const availableMetrics: MetricKey[] = useMemo(
    () =>
      hasNutritionist
        ? ['bmi', 'whtr', 'muac', 'edema']
        : ['bmi', 'whtr'],
    [hasNutritionist]
  );

  // Active metrics for base table & "View beneficiaries" (BMI always on + ticked boxes)
  const activeMetrics: MetricKey[] = useMemo(() => {
    const list: MetricKey[] = ['bmi'];
    if (checkedOptional.whtr) list.push('whtr');
    if (hasNutritionist && checkedOptional.muac) list.push('muac');
    if (hasNutritionist && checkedOptional.edema) list.push('edema');
    return list;
  }, [checkedOptional, hasNutritionist]);

  const toggleOptionalMetric = (key: 'whtr' | 'muac' | 'edema') => {
    setCheckedOptional((prev) => ({ ...prev, [key]: !prev[key] }));
  };

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

  // "Past # days" Status Transitions calculations
  const parsedLookbackDays = useMemo(() => {
    const n = Number.parseInt(lookbackDaysInput, 10);
    if (!Number.isFinite(n) || n < 0) return 14;
    return Math.min(365, n);
  }, [lookbackDaysInput]);

  const transitionWindowStart = useMemo(
    () => addDays(today, -parsedLookbackDays),
    [today, parsedLookbackDays]
  );

  const transitionReports = useMemo(() => {
    return activeMetrics.map((metric) =>
      computePerMetricTransitions({
        metric,
        windowStart: transitionWindowStart,
        windowEnd: today,
        beneficiaries: beneficiaries.map((b) => ({
          beneficiary_code: b.beneficiary_code,
          display_name: b.displayName,
          registration_date: b.registered_session_date,
          history: b.metric_history[metric] ?? [],
        })),
      })
    );
  }, [activeMetrics, transitionWindowStart, today, beneficiaries]);

  const openModal = (modal: Exclude<ActiveModal, null>) => {
    setModalMetricTab(modal === 'outdated' ? 'all' : 'bmi');
    setActiveModal(modal);
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
      <div className="card-header bg-white border-bottom p-3 p-md-4">
        <div className="d-flex flex-wrap justify-content-between align-items-start gap-3">
          <div>
            <div className="d-flex align-items-center gap-2 mb-1">
              <h2 className="h5 fw-bold mb-0 text-dark">Program Nutritional Status</h2>
              <span className="badge rounded-pill badge-pale-neutral small bb-num">
                {nutritionalStatus.enrolled_count} enrolled
              </span>
            </div>
            <p className="text-body-secondary small mb-0">
              Latest submitted per-metric statuses from <code>v_latest_*</code> views. Outdated (&gt; 14 days before {formatDate(today)}) is a subset overlay of active status rows.
            </p>
          </div>

          {/* Metric Checkboxes (BMI always on; MUAC & Edema hidden when no nutritionist) */}
          <div className="d-flex flex-wrap align-items-center gap-2 bg-light px-3 py-2 rounded-3 border">
            <span className="small fw-semibold text-body-secondary me-1">Metrics:</span>
            <span className="badge rounded-pill bg-primary text-white">BMI (always on)</span>

            <label className="form-check form-check-inline mb-0 small d-inline-flex align-items-center gap-1 cursor-pointer">
              <input
                type="checkbox"
                className="form-check-input mt-0"
                checked={checkedOptional.whtr}
                onChange={() => toggleOptionalMetric('whtr')}
              />
              <span>WHtR</span>
            </label>

            {hasNutritionist ? (
              <>
                <label className="form-check form-check-inline mb-0 small d-inline-flex align-items-center gap-1 cursor-pointer">
                  <input
                    type="checkbox"
                    className="form-check-input mt-0"
                    checked={checkedOptional.muac}
                    onChange={() => toggleOptionalMetric('muac')}
                  />
                  <span>MUAC</span>
                </label>

                <label className="form-check form-check-inline mb-0 small d-inline-flex align-items-center gap-1 cursor-pointer">
                  <input
                    type="checkbox"
                    className="form-check-input mt-0"
                    checked={checkedOptional.edema}
                    onChange={() => toggleOptionalMetric('edema')}
                  />
                  <span>Edema</span>
                </label>
              </>
            ) : (
              <span className="small text-body-secondary fst-italic ms-1">
                (MUAC &amp; Edema unavailable — no nutritionist assigned)
              </span>
            )}
          </div>
        </div>
      </div>

      <div className="card-body p-3 p-md-4">
        {/* Base Per-Metric Summary Table */}
        <div className="table-responsive mb-3">
          <table className="table table-hover align-middle mb-0 small border rounded overflow-hidden">
            <thead className="table-light">
              <tr>
                <th>Metric</th>
                <th className="text-center">Baseline</th>
                <th className="text-center">Monitor</th>
                <th className="text-center">Monitor closely</th>
                <th className="text-center">Of which outdated (&gt;14d)</th>
                <th className="text-center">No status</th>
              </tr>
            </thead>
            <tbody>
              {activeMetrics.map((m) => {
                const row = nutritionalStatus.metrics[m];
                return (
                  <tr key={m}>
                    <td className="fw-bold text-dark">
                      {row.label}
                      {m === 'bmi' && (
                        <span className="badge badge-pale-info ms-2 fw-normal" style={{ fontSize: '0.68rem' }}>
                          Core
                        </span>
                      )}
                    </td>
                    <td className="text-center bb-num">
                      <span className="badge rounded-pill badge-pale-success px-3">
                        {row.baseline_count}
                      </span>
                    </td>
                    <td className="text-center bb-num">
                      <span className="badge rounded-pill badge-pale-warning px-3">
                        {row.monitor_count}
                      </span>
                    </td>
                    <td className="text-center bb-num">
                      <span className="badge rounded-pill badge-pale-danger px-3">
                        {row.monitor_closely_count}
                      </span>
                    </td>
                    <td className="text-center bb-num">
                      <span
                        className={`badge rounded-pill px-3 ${
                          row.outdated_count > 0 ? 'badge-pale-warning' : 'badge-pale-neutral text-muted'
                        }`}
                        title="Subset overlay across Baseline, Monitor, and Monitor closely rows older than 14 days"
                      >
                        of which {row.outdated_count} outdated
                      </span>
                    </td>
                    <td className="text-center bb-num">
                      <span className="badge rounded-pill badge-pale-neutral text-muted px-3">
                        {row.no_status_count}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {/* Drilldown Action Buttons */}
        <div className="d-flex flex-wrap align-items-center justify-content-between gap-2 pb-4 mb-4 border-bottom">
          <div className="d-flex flex-wrap gap-2">
            <button
              type="button"
              className="btn btn-sm btn-outline-warning text-dark fw-semibold"
              onClick={() => openModal('monitor')}
            >
              Monitor ({totalMonitorAcrossActive})
            </button>
            <button
              type="button"
              className="btn btn-sm btn-outline-danger fw-semibold"
              onClick={() => openModal('monitor_closely')}
            >
              Monitor closely ({totalCloselyAcrossActive})
            </button>
            <button
              type="button"
              className="btn btn-sm btn-outline-secondary fw-semibold"
              onClick={() => openModal('outdated')}
            >
              Outdated ({nutritionalStatus.outdated_rows.filter((r) => availableMetrics.includes(r.metric)).length})
            </button>
            <button
              type="button"
              className="btn btn-sm btn-primary fw-semibold"
              onClick={() => openModal('view_beneficiaries')}
            >
              View beneficiaries ({qualifyingBeneficiaries.length})
            </button>
          </div>
          <div className="small text-body-secondary">
            “View beneficiaries” shows enrollees measured for <strong>all</strong> selected metrics ({activeMetrics.map((m) => METRIC_LABEL[m]).join(' + ')}).
          </div>
        </div>

        {/* Sub-view Switcher: Per-Beneficiary History vs. Status Transitions */}
        <ul className="nav nav-pills gap-2 mb-3">
          <li className="nav-item">
            <button
              type="button"
              className={`nav-link btn-sm py-1 px-3 ${activeTab === 'history' ? 'active' : 'bg-light text-dark border'}`}
              onClick={() => setActiveTab('history')}
            >
              Per-Beneficiary History ({beneficiaries.length})
            </button>
          </li>
          <li className="nav-item">
            <button
              type="button"
              className={`nav-link btn-sm py-1 px-3 ${activeTab === 'transitions' ? 'active' : 'bg-light text-dark border'}`}
              onClick={() => setActiveTab('transitions')}
            >
              Status Transitions (Past {parsedLookbackDays} days)
            </button>
          </li>
        </ul>

        {/* Panel A: Expandable Per-Beneficiary History View */}
        {activeTab === 'history' && (
          <div>
            <div className="d-flex flex-wrap justify-content-between align-items-center gap-2 mb-3">
              <div className="input-group input-group-sm" style={{ maxWidth: '300px' }}>
                <span className="input-group-text bg-white">Search</span>
                <input
                  type="text"
                  className="form-control"
                  placeholder="Code or name / alias..."
                  value={historySearch}
                  onChange={(e) => {
                    setHistorySearch(e.target.value);
                    setHistoryPage(1);
                  }}
                />
              </div>
              <div className="small text-body-secondary">
                Click any row to inspect insert-only per-metric history and signed changes.
              </div>
            </div>

            <div className="table-responsive">
              <table className="table table-hover align-middle mb-0 small border rounded">
                <thead className="table-light">
                  <tr>
                    <th style={{ width: 32 }}></th>
                    <th>Beneficiary</th>
                    <th>Latest Per-Metric Statuses</th>
                    <th className="text-end">Measurement Recency</th>
                  </tr>
                </thead>
                <tbody>
                  {pagedBeneficiaries.length === 0 ? (
                    <tr>
                      <td colSpan={4} className="text-center py-4 text-body-secondary">
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
              <div className="d-flex justify-content-between align-items-center mt-3 small">
                <span className="text-body-secondary bb-num">
                  Page {safeHistoryPage} of {totalHistoryPages} ({filteredBeneficiaries.length} beneficiaries)
                </span>
                <div className="btn-group btn-group-sm">
                  <button
                    type="button"
                    className="btn btn-outline-secondary"
                    disabled={safeHistoryPage === 1}
                    onClick={() => setHistoryPage((p) => Math.max(1, p - 1))}
                  >
                    Previous
                  </button>
                  <button
                    type="button"
                    className="btn btn-outline-secondary"
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

        {/* Panel B: Past # Days Status Transitions Report */}
        {activeTab === 'transitions' && (
          <div>
            <div className="d-flex flex-wrap justify-content-between align-items-center gap-3 p-3 rounded bg-light border mb-3">
              <div className="d-flex flex-wrap align-items-center gap-2">
                <label htmlFor="bb-lookback-days" className="small fw-semibold mb-0 text-dark">
                  Past
                </label>
                <input
                  id="bb-lookback-days"
                  type="number"
                  min={0}
                  max={365}
                  value={lookbackDaysInput}
                  onChange={(e) => setLookbackDaysInput(e.target.value)}
                  className="form-control form-control-sm bb-num text-center"
                  style={{ width: '76px' }}
                />
                <span className="small fw-semibold text-dark">days</span>
                <div className="btn-group btn-group-sm ms-2">
                  {[7, 14, 30, 60].map((d) => (
                    <button
                      key={d}
                      type="button"
                      className={`btn ${parsedLookbackDays === d ? 'btn-primary' : 'btn-outline-secondary'}`}
                      onClick={() => setLookbackDaysInput(String(d))}
                    >
                      {d}d
                    </button>
                  ))}
                </div>
              </div>

              <div className="small text-body-secondary bb-num">
                Window: <strong>{formatDate(transitionWindowStart)}</strong> – <strong>{formatDate(today)}</strong>
              </div>
            </div>

            <div className="table-responsive mb-3">
              <table className="table table-hover align-middle mb-0 small border rounded">
                <thead className="table-light">
                  <tr>
                    <th>Metric</th>
                    <th>From → To Transitions (Beneficiaries with New Row in Window)</th>
                    <th className="text-center">No New Measurement</th>
                    <th className="text-end">Details</th>
                  </tr>
                </thead>
                <tbody>
                  {transitionReports.map((rep) => {
                    const groups = getTransitionGroupCounts(rep.entries);
                    const isOpen = expandedTransitionMetric === rep.metric;
                    return (
                      <tr key={rep.metric}>
                        <td className="fw-bold text-dark align-top pt-3">{METRIC_LABEL[rep.metric]}</td>
                        <td>
                          {groups.length === 0 ? (
                            <span className="text-body-secondary">No new status rows recorded in window.</span>
                          ) : (
                            <div className="d-flex flex-wrap gap-2 py-1">
                              {groups.map((g) => {
                                const dm = TRANSITION_DIRECTION_META[g.direction];
                                return (
                                  <div
                                    key={`${g.fromStatus ?? 'NEW'}_${g.toStatus}`}
                                    className="d-inline-flex align-items-center gap-1 bg-white border rounded px-2 py-1"
                                  >
                                    <span className="text-body-secondary">
                                      {g.fromStatus ? STATUS_LABEL[g.fromStatus] : 'First'} →{' '}
                                      <strong>{STATUS_LABEL[g.toStatus]}</strong>
                                    </span>
                                    <span className="badge bg-light text-dark border bb-num">{g.count}</span>
                                    <span className={`badge ${dm.badgeClass}`}>{dm.label}</span>
                                  </div>
                                );
                              })}
                            </div>
                          )}
                        </td>
                        <td className="text-center align-top pt-3 bb-num">
                          <span className="badge rounded-pill badge-pale-neutral text-muted">
                            {rep.noNewMeasurementCount} no new measurement
                          </span>
                        </td>
                        <td className="text-end align-top pt-2">
                          <button
                            type="button"
                            className="btn btn-sm btn-outline-secondary"
                            onClick={() =>
                              setExpandedTransitionMetric(isOpen ? null : rep.metric)
                            }
                            disabled={rep.entries.length === 0}
                          >
                            {isOpen ? 'Hide' : `List (${rep.entries.length})`}
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {expandedTransitionMetric &&
              (() => {
                const rep = transitionReports.find((r) => r.metric === expandedTransitionMetric);
                if (!rep || rep.entries.length === 0) return null;
                return (
                  <div className="p-3 rounded bg-light border">
                    <div className="d-flex justify-content-between align-items-center mb-2">
                      <h4 className="h6 fw-bold mb-0">
                        {METRIC_LABEL[rep.metric]} Transitions ({rep.entries.length} measured in window)
                      </h4>
                      <span className="small text-body-secondary bb-num">
                        {rep.improvedCount} improved · {rep.declinedCount} declined · {rep.newCount} new ·{' '}
                        {rep.unchangedCount} unchanged
                      </span>
                    </div>
                    <div className="table-responsive">
                      <table className="table table-sm bg-white mb-0 small border">
                        <thead className="table-light">
                          <tr>
                            <th>Code</th>
                            <th>Beneficiary</th>
                            <th>Transition</th>
                            <th>Latest Date</th>
                            <th>Change</th>
                            <th>Tag</th>
                          </tr>
                        </thead>
                        <tbody>
                          {rep.entries.map((entry) => {
                            const dm = TRANSITION_DIRECTION_META[entry.direction];
                            return (
                              <tr key={`${rep.metric}_${entry.beneficiary_code}`}>
                                <td className="bb-num fw-semibold">{entry.beneficiary_code}</td>
                                <td>{entry.display_name}</td>
                                <td>
                                  {entry.fromStatus ? (
                                    <span className={`badge ${STATUS_BADGE_CLASS[entry.fromStatus]} me-1`}>
                                      {STATUS_LABEL[entry.fromStatus]}
                                    </span>
                                  ) : (
                                    <span className="text-body-secondary me-1">None</span>
                                  )}
                                  →{' '}
                                  <span className={`badge ${STATUS_BADGE_CLASS[entry.toStatus]} ms-1`}>
                                    {STATUS_LABEL[entry.toStatus]}
                                  </span>
                                </td>
                                <td className="bb-num">{formatDate(entry.toDate)}</td>
                                <td className="bb-num">
                                  {formatSignedChange(rep.metric, entry.changeValue)}
                                </td>
                                <td>
                                  <span className={`badge ${dm.badgeClass}`}>{dm.label}</span>
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  </div>
                );
              })()}
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
                  </h3>
                  <div className="small text-body-secondary mt-1">
                    {activeModal === 'view_beneficiaries'
                      ? `${qualifyingBeneficiaries.length} enrolled · ${qualifyingOutdatedBeneficiariesCount} with ≥1 outdated metric`
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
        style={{ cursor: 'pointer' }}
        className={isExpanded ? 'table-active' : undefined}
      >
        <td className="text-center text-body-secondary fw-bold">
          {isExpanded ? '▾' : '▸'}
        </td>
        <td>
          <div className="fw-semibold text-dark">{b.displayName}</div>
          <div className="text-body-secondary bb-num" style={{ fontSize: '0.75rem' }}>
            #{b.beneficiary_code} · {b.age}y {b.sex === 'female' ? 'F' : 'M'}
          </div>
        </td>
        <td>
          <div className="d-flex flex-wrap gap-2">
            {availableMetrics.map((m) => {
              const st = b.latest_statuses[m];
              if (!st) return null;
              return (
                <span
                  key={m}
                  className="d-inline-flex align-items-center gap-1 border rounded px-2 py-1 bg-white"
                >
                  <strong className="text-dark">{METRIC_LABEL[m]}:</strong>
                  <span className={`badge ${STATUS_BADGE_CLASS[st.status_key]}`}>
                    {STATUS_LABEL[st.status_key]}
                  </span>
                  <span className="text-body-secondary bb-num" style={{ fontSize: '0.72rem' }}>
                    {formatDate(st.session_date)}
                  </span>
                  {st.is_outdated && (
                    <span className="badge badge-pale-warning" style={{ fontSize: '0.68rem' }}>
                      Outdated
                    </span>
                  )}
                </span>
              );
            })}
            {ALL_METRICS.every((m) => !b.latest_statuses[m]) && (
              <span className="text-body-secondary fst-italic">No submitted status rows yet</span>
            )}
          </div>
        </td>
        <td className="text-end">
          {sessAgo == null ? (
            <span className="badge badge-pale-neutral text-muted">Pending 1st session</span>
          ) : sessAgo === 0 ? (
            <span className="badge badge-pale-success bb-num">Last measured 0 sessions ago</span>
          ) : (
            <span className="badge badge-pale-warning bb-num">
              Last measured {sessAgo} session{sessAgo === 1 ? '' : 's'} ago
            </span>
          )}
        </td>
      </tr>

      {isExpanded && (
        <tr>
          <td colSpan={4} className="bg-light p-3">
            <div className="small fw-bold text-dark mb-2">
              Insert-Only Per-Metric Status History — {b.displayName} (#{b.beneficiary_code})
            </div>
            <div className="row g-2">
              {availableMetrics.map((m) => {
                const points = b.metric_history[m] ?? [];
                return (
                  <div key={m} className="col-12 col-md-6">
                    <div className="bg-white border rounded p-2 h-100">
                      <div className="d-flex justify-content-between align-items-center border-bottom pb-1 mb-2">
                        <span className="fw-semibold text-dark">{METRIC_LABEL[m]}</span>
                        <span className="text-body-secondary bb-num" style={{ fontSize: '0.72rem' }}>
                          {points.length} row{points.length === 1 ? '' : 's'}
                        </span>
                      </div>
                      {points.length === 0 ? (
                        <div className="text-body-secondary fst-italic" style={{ fontSize: '0.75rem' }}>
                          Not measured
                        </div>
                      ) : (
                        <div className="d-flex flex-column gap-1">
                          {points.map((pt) => (
                            <div
                              key={`${m}_${pt.session_id}`}
                              className="d-flex justify-content-between align-items-center"
                              style={{ fontSize: '0.78rem' }}
                            >
                              <div className="d-flex align-items-center gap-2">
                                <span className="bb-num text-body-secondary">
                                  {formatDate(pt.session_date)}
                                </span>
                                <span className={`badge ${STATUS_BADGE_CLASS[pt.status_key]}`}>
                                  {STATUS_LABEL[pt.status_key]}
                                </span>
                              </div>
                              <span
                                className={`bb-num ${
                                  pt.change_value == null
                                    ? 'text-body-secondary'
                                    : pt.change_value > 0
                                    ? 'text-success fw-semibold'
                                    : pt.change_value < 0
                                    ? 'text-danger fw-semibold'
                                    : 'text-body-secondary'
                                }`}
                              >
                                {formatSignedChange(m, pt.change_value)}
                              </span>
                            </div>
                          ))}
                        </div>
                      )}
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
