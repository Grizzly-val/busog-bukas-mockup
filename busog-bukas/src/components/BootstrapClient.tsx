'use client';

import { useEffect } from 'react';

/**
 * Loads Bootstrap's JS bundle once in the browser so the data-bs-* attributes
 * in server-rendered markup (dropdowns, offcanvas, modals) work.
 */
export default function BootstrapClient() {
  useEffect(() => {
    import('bootstrap/dist/js/bootstrap.bundle.min.js');
  }, []);
  return null;
}
