import Link from 'next/link';
import { Suspense, type ReactNode } from 'react';
import { getOrgContext } from '@/lib/orgContext';
import { PHASE_BADGE, formatDate, programPhase } from '@/lib/format';
import { getProgramPageData } from '@/lib/programData';
import SessionCalendar from '@/components/program/SessionCalendar';
import TimelinesSection from '@/components/program/TimelinesSection';
import BeneficiariesTable from '@/components/program/BeneficiariesTable';

type PageProps = {
  params: Promise<{ programId: string }>;
  searchParams?: Promise<{ sessionId?: string }>;
};

export default function ProgramPage({ params, searchParams }: PageProps) {
  return (
    <Suspense fallback={<ProgramSkeleton />}>
      <ProgramDataLoader params={params} searchParams={searchParams} />
    </Suspense>
  );
}

async function ProgramDataLoader({ params, searchParams }: PageProps) {
  const { programId } = await params;
  const sp = searchParams ? await searchParams : undefined;
  return <ProgramContent programId={programId} initialSessionId={sp?.sessionId} />;
}

async function ProgramContent({
  programId,
  initialSessionId,
}: {
  programId: string;
  initialSessionId?: string;
}) {
  let selectedOrgId: string | undefined;
  let selectedOrgName: string | undefined;
  let data: Awaited<ReturnType<typeof getProgramPageData>>;

  try {
    const { selected } = await getOrgContext();
    selectedOrgId = selected?.org_id;
    selectedOrgName = selected?.name;
    data = await getProgramPageData(programId);
  } catch (err) {
    return (
      <Notice title="Can't reach the database">
        Start MySQL in XAMPP, then reload.{' '}
        <code className="d-block mt-2 small">{err instanceof Error ? err.message : String(err)}</code>
      </Notice>
    );
  }

  // 1. Access Check: program must belong to selected_org_id from the cookie
  if (!data || data.program.org_id !== selectedOrgId) {
    return (
      <Notice title="This program isn't available for your account">
        It may belong to a different organization, or it doesn&apos;t exist. You&apos;re signed in as{' '}
        <strong>{selectedOrgName ?? 'an unknown organization'}</strong>. Use <em>Switch Account</em> in the top bar if
        you meant to view another organization&apos;s program.
      </Notice>
    );
  }

  const {
    program,
    sessions,
    timelines,
    beneficiaries,
    availableAllergies,
    assignedNutritionists,
    surveyQuestions,
    today,
    openTimelineWarning,
  } = data;
  const phase = programPhase(program.start_date, program.end_date, today);
  const badge = PHASE_BADGE[phase];
  const submittedCount = sessions.filter((s) => s.submitted_at != null).length;
  const closedTimelinesCount = timelines.filter((t) => t.state === 'closed').length;
  const openTimelinesCount = timelines.filter((t) => t.state === 'open').length;

  return (
    <>
      {/* Breadcrumb Navigation */}
      <nav aria-label="breadcrumb" className="mb-3">
        <ol className="breadcrumb mb-0">
          <li className="breadcrumb-item">
            <Link href="/" className="link-light text-decoration-none">
              ← Programs Overview
            </Link>
          </li>
          <li className="breadcrumb-item active text-white-50" aria-current="page">
            {program.title}
          </li>
        </ol>
      </nav>

      {/* Program Summary Header Card */}
      <div className="card bb-card p-4 p-md-5 mb-4">
        <div className="d-flex flex-wrap justify-content-between align-items-start gap-3 mb-3">
          <div>
            <div className="d-flex align-items-center gap-2 mb-2 flex-wrap">
              <h1 className="h3 fw-bold mb-0 text-dark">{program.title}</h1>
              <span className={`badge rounded-pill ${badge.className}`}>{badge.label}</span>
              <span
                className={`badge rounded-pill ${
                  program.nutritionist_count > 0 ? 'badge-pale-info' : 'badge-pale-neutral'
                }`}
              >
                {program.nutritionist_count > 0
                  ? `${program.nutritionist_count} Nutritionist${program.nutritionist_count > 1 ? 's' : ''} assigned`
                  : 'Standard feeding tier'}
              </span>
            </div>
            <p className="text-body-secondary mb-0 small">📍 {program.location}</p>
          </div>
        </div>

        <p className="mb-4 text-body-secondary lead fs-6" style={{ maxWidth: '75ch' }}>{program.description}</p>

        {/* Quick Stats Grid */}
        <div className="row g-3">
          <Stat
            label="Program Duration"
            value={`${formatDate(program.start_date)} – ${formatDate(program.end_date)}`}
            subtitle="Full feeding duration"
          />
          <Stat
            label="Beneficiaries"
            value={`${program.enrolled} / ${program.max_beneficiaries}`}
            subtitle={`${Math.round((program.enrolled / program.max_beneficiaries) * 100)}% capacity filled`}
          />
          <Stat
            label="Sessions Progress"
            value={`${submittedCount} / ${program.session_total}`}
            subtitle="Sessions submitted"
          />
          <Stat
            label="Timelines"
            value={`${program.timeline_total} Timelines`}
            subtitle={`${closedTimelinesCount} closed, ${openTimelinesCount} open`}
          />
        </div>
      </div>

      {/* 2. Session Calendar Section (with Large Session Card & Data Entry) */}
      <section className="mb-4">
        <SessionCalendar
          sessions={sessions}
          timelines={timelines}
          startDate={program.start_date}
          endDate={program.end_date}
          today={today}
          initialSessionId={initialSessionId}
          programId={program.program_id}
          beneficiaries={beneficiaries}
          availableAllergies={availableAllergies}
          assignedNutritionists={assignedNutritionists}
          surveyQuestions={surveyQuestions}
        />
      </section>

      {/* 3. Timelines Section */}
      <section className="mb-4">
        <TimelinesSection timelines={timelines} beneficiaries={beneficiaries} today={today} />
      </section>

      {/* 4. Beneficiaries Table Section */}
      <section className="mb-5">
        <BeneficiariesTable
          beneficiaries={beneficiaries}
          today={today}
          openTimelineWarning={openTimelineWarning}
          sessions={sessions}
          timelines={timelines}
        />
      </section>
    </>
  );
}

function Stat({ label, value, subtitle }: { label: string; value: string; subtitle?: string }) {
  return (
    <div className="col-6 col-lg-3">
      <div className="bb-shell h-100 p-3">
        <span className="small text-body-secondary d-block">{label}</span>
        <div className="fw-bold fs-5 text-dark my-1 bb-num">{value}</div>
        {subtitle && <span className="small text-body-secondary" style={{ fontSize: '0.72rem' }}>{subtitle}</span>}
      </div>
    </div>
  );
}

function Notice({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="card bb-card p-4 p-md-5 text-center mx-auto" style={{ maxWidth: 640 }}>
      <div className="display-6 mb-2" aria-hidden="true">
        🍽️
      </div>
      <h1 className="h4 fw-semibold">{title}</h1>
      <div className="text-body-secondary mb-4">{children}</div>
      <div>
        <Link href="/" className="btn btn-success rounded-pill px-4">
          Back to home
        </Link>
      </div>
    </div>
  );
}

function ProgramSkeleton() {
  return (
    <div aria-busy="true" aria-label="Loading program">
      <div className="bb-skeleton mb-3" style={{ height: 32, width: 220 }} />
      <div className="card bb-card p-4 p-md-5 mb-4">
        <div className="bb-skeleton mb-3" style={{ height: 40, width: '50%' }} />
        <div className="bb-skeleton mb-4" style={{ height: 20, width: '80%' }} />
        <div className="row g-3">
          {[0, 1, 2, 3].map((i) => (
            <div className="col-6 col-lg-3" key={i}>
              <div className="bb-skeleton" style={{ height: 90 }} />
            </div>
          ))}
        </div>
      </div>
      <div className="bb-skeleton mb-4" style={{ height: 450 }} />
      <div className="bb-skeleton mb-4" style={{ height: 320 }} />
      <div className="bb-skeleton" style={{ height: 500 }} />
    </div>
  );
}
