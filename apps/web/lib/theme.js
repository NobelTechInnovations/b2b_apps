'use client';

import { useCallback, useEffect, useState } from 'react';

const KEY = 'nexus-theme';

export function useTheme() {
  const [theme, setThemeState] = useState('system');

  useEffect(() => {
    try {
      setThemeState(localStorage.getItem(KEY) ?? 'system');
    } catch {
      setThemeState('system');
    }
  }, []);

  const apply = useCallback((next) => {
    const root = document.documentElement;
    const system = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';

    // Kill transitions for the frame in which the palette changes, so the
    // switch reads as instant rather than as a slow colour smear.
    root.setAttribute('data-theme-switching', '');
    root.dataset.theme = next === 'system' ? system : next;

    requestAnimationFrame(() => {
      requestAnimationFrame(() => root.removeAttribute('data-theme-switching'));
    });

    try {
      localStorage.setItem(KEY, next);
    } catch {
      // Private browsing or blocked storage: the theme still applies for this
      // session, it just will not be remembered.
    }
    setThemeState(next);
  }, []);

  // Follow the OS while the user has not made a choice.
  useEffect(() => {
    if (theme !== 'system') return undefined;
    const query = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => {
      const root = document.documentElement;
      root.setAttribute('data-theme-switching', '');
      root.dataset.theme = query.matches ? 'dark' : 'light';
      requestAnimationFrame(() => {
        requestAnimationFrame(() => root.removeAttribute('data-theme-switching'));
      });
    };
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, [theme]);

  return { theme, setTheme: apply };
}
