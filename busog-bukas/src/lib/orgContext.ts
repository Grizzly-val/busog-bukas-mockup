import { cache } from 'react';
import { cookies } from 'next/headers';
import { query } from './db';

export const ORG_COOKIE = 'selected_org_id';

export type Organization = {
  org_id: string;
  name: string;
  photo: string | null;
  description: string;
};

export type OrgContext = {
  /** Every organization, ordered by name ASC (powers the Switch Account dropdown). */
  organizations: Organization[];
  /** The active organization, or null only when the `organization` table is empty. */
  selected: Organization | null;
};

/**
 * Resolves the "logged in" organization for this mockup (there is no auth).
 *
 * Reads the `selected_org_id` cookie and checks it against the `organization`
 * table. A missing or unknown id falls back to the first organization by `name ASC`.
 *
 * Reads cookies, so with Cache Components the caller must render inside <Suspense>.
 * Wrapped in React `cache` so the navbar and the page share one DB round trip per request.
 */
export const getOrgContext = cache(async (): Promise<OrgContext> => {
  const cookieStore = await cookies();
  const cookieOrgId = cookieStore.get(ORG_COOKIE)?.value ?? null;

  const organizations = await query<Organization>(
    'SELECT org_id, name, photo, description FROM organization ORDER BY name ASC',
  );

  const selected =
    (cookieOrgId && organizations.find((o) => o.org_id === cookieOrgId)) || organizations[0] || null;

  return { organizations, selected };
});

/** Returns true when `orgId` exists in the `organization` table. */
export async function isValidOrgId(orgId: string): Promise<boolean> {
  const rows = await query<{ org_id: string }>(
    'SELECT org_id FROM organization WHERE org_id = ? LIMIT 1',
    [orgId],
  );
  return rows.length > 0;
}
