import Link from 'next/link';
import { Suspense } from 'react';
import { query } from '@/lib/db';
import { getOrgContext, type Organization } from '@/lib/orgContext';
import { getMockToday } from '@/lib/mockToday';
import { isAdultAt } from '@/lib/statusRule';
import { PHASE_BADGE, daysBetween, formatDate, initials, programPhase } from '@/lib/format';

// ---------------------------------------------------------------------------
// Data
// ---------------------------------------------------------------------------

type ProgramRow = {
  program_id: string;
  title: string;
  location: string;
  description: string;
  start_date: string;
  end_date: string;
  max_beneficiaries: number;
  enrolled: number;
  session_total: number;
  session_submitted: number;
  session_draft: number;
  next_session: string | null;
  nutritionist_count: number;
};

type BeneficiaryRow = {
  program_id: string;
  sex: 'female' | 'male';
  birth_month: number;
  birth_year: number;
  has_name: number;
  has_allergy: number;
};

type ProgramBreakdown = {
  program_id: string;
  title: string;
  max: number;
  total: number;
  female: number;
  male: number;
  minors: number;
  adults: number;
  named: number;
  aliasOnly: number;
  withAllergy: number;
};

async function getPrograms(orgId: string, today: string): Promise<ProgramRow[]> {
  return query<ProgramRow>(
    `SELECT p.program_id, p.title, p.location, p.description, p.start_date, p.end_date, p.max_beneficiaries,
            (SELECT COUNT(*) FROM beneficiary b WHERE b.program_id = p.program_id) AS enrolled,
            (SELECT COUNT(*) FROM program_session s WHERE s.program_id = p.program_id) AS session_total,
            (SELECT COUNT(*) FROM program_session s
               WHERE s.program_id = p.program_id AND s.submitted_at IS NOT NULL) AS session_submitted,
            (SELECT COUNT(*) FROM program_session s
               WHERE s.program_id = p.program_id AND s.submitted_at IS NULL AND s.session_date <= ?) AS session_draft,
            (SELECT MIN(s.session_date) FROM program_session s
               WHERE s.program_id = p.program_id AND s.submitted_at IS NULL AND s.session_date >= ?) AS next_session,
            (SELECT COUNT(*) FROM program_nutritionist pn WHERE pn.program_id = p.program_id) AS nutritionist_count
       FROM program p
      WHERE p.org_id = ?
      ORDER BY p.start_date DESC, p.title ASC`,
    [today, today, orgId],
  );
}

/** Per-program beneficiary counts. Only counts are shown; names never leave the server. */
async function getBeneficiaryBreakdown(orgId: string, programs: ProgramRow[], today: string): Promise<ProgramBreakdown[]> {
  const rows = await query<BeneficiaryRow>(
    `SELECT b.program_id, b.sex, b.birth_month, b.birth_year,
            (b.name IS NOT NULL) AS has_name,
            EXISTS (SELECT 1 FROM beneficiary_allergy ba
                     WHERE ba.program_id = b.program_id AND ba.beneficiary_code = b.beneficiary_code) AS has_allergy
       FROM beneficiary b
       JOIN program p ON p.program_id = b.program_id
      WHERE p.org_id = ?`,
    [orgId],
  );

  const byProgram = new Map<string, ProgramBreakdown>(
    programs.map((p) => [
      p.program_id,
      { program_id: p.program_id, title: p.title, max: p.max_beneficiaries, total: 0, female: 0, male: 0, minors: 0, adults: 0, named: 0, aliasOnly: 0, withAllergy: 0 },
    ]),
  );

  for (const r of rows) {
    const b = byProgram.get(r.program_id);
    if (!b) continue;
    b.total++;
    if (r.sex === 'female') b.female++;
    else b.male++;
    if (isAdultAt(r.birth_month, r.birth_year, today)) b.adults++;
    else b.minors++;
    if (r.has_name) b.named++;
    else b.aliasOnly++;
    if (r.has_allergy) b.withAllergy++;
  }

  return [...byProgram.values()];
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function HomePage() {
  return (
    <Suspense fallback={<HomeSkeleton />}>
      <HomeContent />
    </Suspense>
  );
}

async function HomeContent() {
  const today = getMockToday();

  let org: Organization | null;
  let programs: ProgramRow[];
  let breakdown: ProgramBreakdown[];
  try {
    org = (await getOrgContext()).selected;
    programs = org ? await getPrograms(org.org_id, today) : [];
    breakdown = org ? await getBeneficiaryBreakdown(org.org_id, programs, today) : [];
  } catch (err) {
    return <DbErrorNotice message={err instanceof Error ? err.message : String(err)} />;
  }

  if (!org) {
    return (
      <div className="card bb-card p-5 text-center">
        <h1 className="h4">No organizations found</h1>
        <p className="text-body-secondary mb-0">Import 02_seed_data.sql into the busog_bukas database.</p>
      </div>
    );
  }

  const totalBeneficiaries = breakdown.reduce((s, b) => s + b.total, 0);
  const totalCapacity = programs.reduce((s, p) => s + p.max_beneficiaries, 0);
  const submitted = programs.reduce((s, p) => s + p.session_submitted, 0);
  const sessionTotal = programs.reduce((s, p) => s + p.session_total, 0);
  const ongoing = programs.filter((p) => programPhase(p.start_date, p.end_date, today) === 'ongoing').length;

  return (
    <>
      {/* Organization header */}
      <section className="d-flex align-items-center gap-3 mb-4 bb-text-hero">
        <span className="bb-avatar bb-avatar-lg shadow-sm">{initials(org.name)}</span>
        <div>
          <p className="mb-1 small text-white-50 text-uppercase">Welcome back</p>
          <h1 className="h3 fw-bold mb-1">{org.name}</h1>
          <p className="mb-0 text-white-50">{org.description}</p>
        </div>
      </section>

      {/* Summary stats */}
      <section className="row g-3 mb-4">
        <div className="col-6 col-lg-3">
          <div className="card bb-card bb-stat h-100 p-3">
            <span className="text-body-secondary small">Programs</span>
            <span className="bb-stat-value">{programs.length}</span>
            <span className="small text-body-secondary">{ongoing} ongoing</span>
          </div>
        </div>
        <div className="col-6 col-lg-3">
          <button
            type="button"
            className="card bb-card bb-stat h-100 p-3 text-start w-100"
            data-bs-toggle="offcanvas"
            data-bs-target="#beneficiariesPanel"
            aria-controls="beneficiariesPanel"
          >
            <span className="text-body-secondary small d-flex justify-content-between w-100">
              Total Beneficiaries <span className="badge rounded-pill badge-pale-success">View</span>
            </span>
            <span className="bb-stat-value">{totalBeneficiaries}</span>
            <span className="small text-body-secondary">of {totalCapacity} slots</span>
          </button>
        </div>
        <div className="col-6 col-lg-3">
          <div className="card bb-card bb-stat h-100 p-3">
            <span className="text-body-secondary small">Sessions submitted</span>
            <span className="bb-stat-value">
              {submitted}
              <span className="fs-6 text-body-secondary fw-normal"> / {sessionTotal}</span>
            </span>
            <div className="progress bb-progress mt-2" role="progressbar" aria-valuenow={submitted} aria-valuemin={0} aria-valuemax={sessionTotal}>
              <div className="progress-bar bg-success" style={{ width: `${sessionTotal ? (submitted / sessionTotal) * 100 : 0}%` }} />
            </div>
          </div>
        </div>
        <div className="col-6 col-lg-3">
          <div className="card bb-card bb-stat h-100 p-3">
            <span className="text-body-secondary small">Today (mock)</span>
            <span className="bb-stat-value fs-4 mt-1">{formatDate(today)}</span>
            <span className="small text-body-secondary">Frozen date for the demo</span>
          </div>
        </div>
      </section>

      {/* Programs */}
      <section>
        <h2 className="h5 bb-text-hero fw-semibold mb-3">Programs</h2>
        {programs.length === 0 ? (
          <div className="card bb-card p-5 text-center text-body-secondary">This organization has no programs yet.</div>
        ) : (
          <div className="row g-3">
            {programs.map((p) => (
              <div className="col-md-6 col-xl-4" key={p.program_id}>
                <ProgramCard program={p} today={today} />
              </div>
            ))}
          </div>
        )}
      </section>

      <BeneficiariesOffcanvas breakdown={breakdown} total={totalBeneficiaries} capacity={totalCapacity} orgName={org.name} />
    </>
  );
}

// ---------------------------------------------------------------------------
// Pieces
// ---------------------------------------------------------------------------

function ProgramCard({ program: p, today }: { program: ProgramRow; today: string }) {
  const phase = programPhase(p.start_date, p.end_date, today);
  const badge = PHASE_BADGE[phase];
  const fill = Math.min(100, (p.enrolled / p.max_beneficiaries) * 100);
  const totalDays = Math.max(1, daysBetween(p.start_date, p.end_date));
  const elapsed = Math.min(totalDays, Math.max(0, daysBetween(p.start_date, today)));
  const timePct = (elapsed / totalDays) * 100;

  return (
    <Link href={`/programs/${p.program_id}`} className="card bb-card bb-program-card h-100 text-decoration-none text-body">
      <div className="card-body d-flex flex-column gap-3 p-3 p-md-4">
        <div className="d-flex justify-content-between align-items-start gap-2">
          <div>
            <h3 className="h5 fw-bold mb-1 text-dark">{p.title}</h3>
            <p className="small text-body-secondary mb-0">📍 {p.location}</p>
          </div>
          <span className={`badge rounded-pill ${badge.className}`}>{badge.label}</span>
        </div>

        <p className="small text-body-secondary mb-0" style={{ maxWidth: '60ch' }}>{p.description}</p>

        <div>
          <div className="d-flex justify-content-between small mb-1">
            <span className="text-body-secondary">Beneficiaries</span>
            <span className="fw-semibold bb-num">{p.enrolled} / {p.max_beneficiaries}</span>
          </div>
          <div className="progress bb-progress" role="progressbar" aria-valuenow={p.enrolled} aria-valuemin={0} aria-valuemax={p.max_beneficiaries}>
            <div className="progress-bar bg-success" style={{ width: `${fill}%` }} />
          </div>
        </div>

        <div>
          <div className="d-flex justify-content-between small mb-1">
            <span className="text-body-secondary">{formatDate(p.start_date)} – {formatDate(p.end_date)}</span>
            <span className="text-body-secondary bb-num">{Math.round(timePct)}%</span>
          </div>
          <div className="progress bb-progress" role="progressbar" aria-valuenow={Math.round(timePct)} aria-valuemin={0} aria-valuemax={100}>
            <div className="progress-bar bg-info" style={{ width: `${timePct}%` }} />
          </div>
        </div>

        <div className="d-flex flex-wrap gap-2 mt-auto pt-2 border-top">
          <span className="badge rounded-pill badge-pale-neutral" style={{ fontSize: '0.72rem' }}>
            {p.session_submitted}/{p.session_total} submitted
          </span>
          {p.session_draft > 0 && (
            <span className="badge rounded-pill badge-pale-warning" style={{ fontSize: '0.72rem' }}>
              {p.session_draft} draft
            </span>
          )}
          {p.next_session && (
            <span className="badge rounded-pill badge-pale-neutral" style={{ fontSize: '0.72rem' }}>
              Next: {formatDate(p.next_session)}
            </span>
          )}
          <span
            className={`badge rounded-pill ${
              p.nutritionist_count > 0 ? 'badge-pale-info' : 'badge-pale-neutral'
            }`}
            style={{ fontSize: '0.72rem' }}
          >
            {p.nutritionist_count > 0
              ? `${p.nutritionist_count} nutritionist${p.nutritionist_count > 1 ? 's' : ''}`
              : 'Standard feeding'}
          </span>
        </div>
      </div>
    </Link>
  );
}

function BeneficiariesOffcanvas({ breakdown, total, capacity, orgName }: { breakdown: ProgramBreakdown[]; total: number; capacity: number; orgName: string }) {
  const sum = (k: keyof Omit<ProgramBreakdown, 'program_id' | 'title'>) => breakdown.reduce((s, b) => s + b[k], 0);
  const pct = (n: number, d: number) => (d ? Math.round((n / d) * 100) : 0);

  return (
    <div className="offcanvas offcanvas-end" tabIndex={-1} id="beneficiariesPanel" aria-labelledby="beneficiariesPanelLabel" style={{ width: 'min(480px, 100vw)' }}>
      <div className="offcanvas-header border-bottom">
        <div>
          <h2 className="offcanvas-title h5 mb-0" id="beneficiariesPanelLabel">Total Beneficiaries</h2>
          <small className="text-body-secondary">{orgName}</small>
        </div>
        <button type="button" className="btn-close" data-bs-dismiss="offcanvas" aria-label="Close" />
      </div>

      <div className="offcanvas-body">
        <div className="d-flex align-items-baseline gap-2 mb-1">
          <span className="display-5 fw-bold text-success-emphasis">{total}</span>
          <span className="text-body-secondary">registered across {breakdown.length} program{breakdown.length === 1 ? '' : 's'}</span>
        </div>
        <div className="progress bb-progress mb-4" role="progressbar" aria-valuenow={total} aria-valuemin={0} aria-valuemax={capacity}>
          <div className="progress-bar bg-success" style={{ width: `${pct(total, capacity)}%` }} />
        </div>

        {total > 0 && (
          <>
            <h3 className="h6 text-uppercase text-body-secondary small">Overall mix</h3>
            <SplitBar leftLabel="Female" left={sum('female')} rightLabel="Male" right={sum('male')} leftClass="bg-danger-subtle text-danger-emphasis" rightClass="bg-primary-subtle text-primary-emphasis" />
            <SplitBar leftLabel="Minors" left={sum('minors')} rightLabel="Adults" right={sum('adults')} leftClass="bg-success-subtle text-success-emphasis" rightClass="bg-warning-subtle text-warning-emphasis" />
            <SplitBar leftLabel="Named (with consent)" left={sum('named')} rightLabel="Alias only" right={sum('aliasOnly')} leftClass="bg-info-subtle text-info-emphasis" rightClass="bg-secondary-subtle text-secondary-emphasis" />
            <p className="small text-body-secondary mb-4">
              {sum('withAllergy')} beneficiar{sum('withAllergy') === 1 ? 'y has' : 'ies have'} at least one recorded allergy.
            </p>
          </>
        )}

        <h3 className="h6 text-uppercase text-body-secondary small">By program</h3>
        <ul className="list-group list-group-flush">
          {breakdown.map((b) => (
            <li className="list-group-item px-0" key={b.program_id}>
              <div className="d-flex justify-content-between align-items-center">
                <Link href={`/programs/${b.program_id}`} className="fw-semibold text-decoration-none">{b.title}</Link>
                <span className="fw-semibold">{b.total} <span className="text-body-secondary fw-normal small">/ {b.max}</span></span>
              </div>
              <div className="progress bb-progress my-2" role="progressbar" aria-valuenow={b.total} aria-valuemin={0} aria-valuemax={b.max}>
                <div className="progress-bar bg-success" style={{ width: `${pct(b.total, b.max)}%` }} />
              </div>
              {b.total === 0 ? (
                <span className="small text-body-secondary">No beneficiaries registered yet.</span>
              ) : (
                <div className="d-flex flex-wrap gap-1">
                  <span className="badge rounded-pill bg-danger-subtle text-danger-emphasis">{b.female} female</span>
                  <span className="badge rounded-pill bg-primary-subtle text-primary-emphasis">{b.male} male</span>
                  <span className="badge rounded-pill bg-success-subtle text-success-emphasis">{b.minors} minors</span>
                  {b.adults > 0 && <span className="badge rounded-pill bg-warning-subtle text-warning-emphasis">{b.adults} adults</span>}
                  <span className="badge rounded-pill bg-secondary-subtle text-secondary-emphasis">{b.aliasOnly} alias only</span>
                  {b.withAllergy > 0 && <span className="badge rounded-pill text-bg-light border">{b.withAllergy} w/ allergy</span>}
                </div>
              )}
            </li>
          ))}
        </ul>

        <p className="small text-body-secondary mt-4 mb-0">
          Counts only. Names are hidden on this overview for privacy. Adult/minor split uses birth month/year against
          mock today ({formatDate(getMockToday())}).
        </p>
      </div>
    </div>
  );
}

function SplitBar({ leftLabel, left, rightLabel, right, leftClass, rightClass }: { leftLabel: string; left: number; rightLabel: string; right: number; leftClass: string; rightClass: string }) {
  const total = left + right;
  const lp = total ? (left / total) * 100 : 0;
  return (
    <div className="mb-3">
      <div className="d-flex justify-content-between small mb-1">
        <span>{leftLabel} · <strong>{left}</strong></span>
        <span><strong>{right}</strong> · {rightLabel}</span>
      </div>
      <div className="progress-stacked" style={{ height: '1.1rem' }}>
        <div className="progress" role="progressbar" style={{ width: `${lp}%` }} aria-valuenow={left} aria-valuemin={0} aria-valuemax={total}>
          <div className={`progress-bar ${leftClass} small`}>{Math.round(lp)}%</div>
        </div>
        <div className="progress" role="progressbar" style={{ width: `${100 - lp}%` }} aria-valuenow={right} aria-valuemin={0} aria-valuemax={total}>
          <div className={`progress-bar ${rightClass} small`}>{Math.round(100 - lp)}%</div>
        </div>
      </div>
    </div>
  );
}

function DbErrorNotice({ message }: { message: string }) {
  return (
    <div className="card bb-card p-4">
      <h1 className="h5 text-danger">Can&apos;t reach the database</h1>
      <p className="mb-2">
        Start <strong>MySQL</strong> in the XAMPP Control Panel and make sure the <code>busog_bukas</code> database has
        both <code>01_init_schema.sql</code> and <code>02_seed_data.sql</code> imported.
      </p>
      <pre className="small bg-body-tertiary p-2 rounded mb-0 text-wrap">{message}</pre>
    </div>
  );
}

function HomeSkeleton() {
  return (
    <div aria-busy="true" aria-label="Loading">
      <div className="d-flex align-items-center gap-3 mb-4">
        <div className="bb-skeleton rounded-circle" style={{ width: 64, height: 64 }} />
        <div className="flex-grow-1">
          <div className="bb-skeleton mb-2" style={{ width: '40%', height: 28 }} />
          <div className="bb-skeleton" style={{ width: '60%', height: 16 }} />
        </div>
      </div>
      <div className="row g-3 mb-4">
        {[0, 1, 2, 3].map((i) => (
          <div className="col-6 col-lg-3" key={i}>
            <div className="bb-skeleton" style={{ height: 110 }} />
          </div>
        ))}
      </div>
      <div className="row g-3">
        {[0, 1, 2].map((i) => (
          <div className="col-md-6 col-xl-4" key={i}>
            <div className="bb-skeleton" style={{ height: 280 }} />
          </div>
        ))}
      </div>
    </div>
  );
}
