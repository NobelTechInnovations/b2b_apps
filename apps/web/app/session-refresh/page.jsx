 'use client';
import { useEffect, useState } from 'react';
import { refreshSession } from '@/lib/api';

export default function SessionRefresh() {
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let live = true;
    const next = new URL(window.location.href).searchParams.get('next') ?? '/dashboard';
    const target = next.startsWith('/') && !next.startsWith('//') && !next.includes('\\') && !next.startsWith('/session-refresh') ? next : '/dashboard';
    refreshSession().then((ok) => {
      if (!live) return;
      if (ok) window.location.replace(target);
      else { setFailed(true); window.location.replace(`/login?next=${encodeURIComponent(target)}`); }
    });
    return () => { live = false; };
  }, []);
  return <main className="grid min-h-screen place-items-center"><p>{failed ? 'Please sign in again.' : 'Restoring your session…'}</p></main>;
}
