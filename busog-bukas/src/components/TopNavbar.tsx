import Link from 'next/link';
import { Suspense } from 'react';
import { getOrgContext } from '@/lib/orgContext';
import { initials } from '@/lib/format';
import { switchAccountAction } from '@/app/actions';

/**
 * White pill top navbar. The brand renders in the static shell; the account
 * switcher reads cookies + DB, so it streams in behind <Suspense>.
 */
export default function TopNavbar() {
  return (
    <header className="container pt-3 pt-md-4">
      <nav className="navbar bb-navbar bg-white px-3 px-md-4 py-2">
        <Link href="/" className="navbar-brand d-flex align-items-center gap-2 fw-semibold text-success-emphasis">
          <span className="bb-brand-mark" aria-hidden="true">B</span>
          <span>
            Busog Bukas
            <small className="d-none d-sm-inline text-body-secondary fw-normal ms-2 fs-6">Feeding Program Manager</small>
          </span>
        </Link>

        <Suspense fallback={<AccountSwitcherSkeleton />}>
          <AccountSwitcher />
        </Suspense>
      </nav>
    </header>
  );
}

async function AccountSwitcher() {
  let ctx;
  try {
    ctx = await getOrgContext();
  } catch {
    return <span className="badge rounded-pill text-bg-danger">Database offline</span>;
  }

  const { organizations, selected } = ctx;
  if (!selected) return <span className="text-body-secondary small">No organizations</span>;

  return (
    <div className="dropdown">
      <button
        className="btn btn-light rounded-pill d-flex align-items-center gap-2 border"
        type="button"
        data-bs-toggle="dropdown"
        aria-expanded="false"
      >
        <span className="bb-avatar">{initials(selected.name)}</span>
        <span className="d-none d-md-inline text-truncate" style={{ maxWidth: 240 }}>
          {selected.name}
        </span>
        <span className="dropdown-toggle" />
      </button>

      <ul className="dropdown-menu dropdown-menu-end shadow border-0 rounded-4 p-2" style={{ minWidth: 300 }}>
        <li>
          <h6 className="dropdown-header text-uppercase small">Switch Account</h6>
        </li>
        {organizations.map((org) => {
          const active = org.org_id === selected.org_id;
          return (
            <li key={org.org_id}>
              <form action={switchAccountAction.bind(null, org.org_id)}>
                <button
                  type="submit"
                  className={`dropdown-item rounded-3 d-flex align-items-center gap-2 py-2 ${active ? 'active' : ''}`}
                  aria-current={active ? 'true' : undefined}
                  disabled={active}
                >
                  <span className="bb-avatar">{initials(org.name)}</span>
                  <span className="text-wrap">{org.name}</span>
                  {active && <span className="ms-auto small">✓</span>}
                </button>
              </form>
            </li>
          );
        })}
        <li>
          <hr className="dropdown-divider" />
        </li>
        <li className="px-3 pb-1 small text-body-secondary">Mockup only: no login, switching just changes the cookie.</li>
      </ul>
    </div>
  );
}

function AccountSwitcherSkeleton() {
  return <span className="placeholder-glow"><span className="placeholder rounded-pill" style={{ width: 180, height: 38 }} /></span>;
}
