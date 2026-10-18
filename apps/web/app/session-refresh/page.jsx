 'use client';
import { useEffect, useState } from 'react';
import { refreshSession } from '@/lib/api';

export default function SessionRefresh() {
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let live = true;
    const next = new URL(window.location.href).searchParams.get('next') ?? '/dashboard';
    const target = next.startsWith('/') && !next.startsWith('//') && !next.includes('\\') && !next.startsWith('/session-refresh') ? next : '/dashboard';
    // A renewal that "works" but brings us straight back here means the new
    // sign-in never reached the page (a cookie the browser refused). Retrying
    // would loop for ever and flood the API, so the second time within a
    // minute goes to the sign-in page instead.
    let recent = [];
    try { recent = JSON.parse(sessionStorage.getItem('nexus-refreshes') ?? '[]').filter((t) => Date.now() - t < 60_000); } catch { /* storage unavailable */ }
    const looping = recent.length >= 2;
    const toLogin = () => { setFailed(true); window.location.replace(`/login?next=${encodeURIComponent(target)}&expired=1`); };
    if (looping) {
      toLogin();
      return () => { live = false; };
    }
    refreshSession().then((ok) => {
      if (!live) return;
      if (ok) {
        try { sessionStorage.setItem('nexus-refreshes', JSON.stringify([...recent, Date.now()])); } catch { /* storage unavailable */ }
        window.location.replace(target);
      } else toLogin();
    });
    return () => { live = false; };
  }, []);
  return <main className="grid min-h-screen place-items-center"><p>{failed ? 'Please sign in again.' : 'Restoring your session…'}</p></main>;
}
