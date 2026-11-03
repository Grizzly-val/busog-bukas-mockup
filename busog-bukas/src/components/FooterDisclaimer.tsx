import { getMockToday } from '@/lib/mockToday';
import { formatDate } from '@/lib/format';

/**
 * Mandatory disclaimer shown on every page: the data is fictional, "today" is
 * frozen, and all status cutoffs are MOCK placeholders, not clinical guidance.
 */
export default function FooterDisclaimer() {
  return (
    <footer className="bb-footer container py-4 mt-4">
      <div className="border-top border-light border-opacity-25 pt-3 d-flex flex-column flex-md-row gap-2 justify-content-between">
        <p className="mb-0">
          <strong>Mockup disclaimer:</strong> All data is fictional. Nutrition statuses (Baseline / Monitor / Monitor
          closely) use <strong>mock cutoffs</strong> that are still open. They are not WHO-validated and are{' '}
          <strong>not clinical guidance</strong>. AI interpretations are pre-written sample text; no live AI is called.
        </p>
        <p className="mb-0 text-md-end text-nowrap">
          Mock today: <strong>{formatDate(getMockToday())}</strong>
        </p>
      </div>
    </footer>
  );
}
