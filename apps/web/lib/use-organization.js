'use client';

import { useEffect, useState } from 'react';
import { api } from './api';

let cached = null;

/**
 * The current workspace's own record — name, slug (its address) and logo.
 * The workspace context only carries the id, and the address rarely changes,
 * so one request per page load is plenty.
 */
export function useOrganization() {
  const [organization, setOrganization] = useState(cached);

  useEffect(() => {
    if (cached) return undefined;
    let live = true;
    cached = api.get('/organizations/current').then((r) => r.data).catch(() => null);
    cached.then((org) => {
      cached = org;
      if (live) setOrganization(org);
    });
    return () => { live = false; };
  }, []);

  return organization && typeof organization.then !== 'function' ? organization : null;
}
