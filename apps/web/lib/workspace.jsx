'use client';

import { createContext, useContext, useCallback, useEffect, useState } from 'react';
import { api } from './api';

const WorkspaceContext = createContext(null);

/**
 * The workspace is the frontend's whole world model: who you are, which
 * organization you are in, which apps it has, and what you may do.
 *
 * Navigation, dashboard widgets and route guards all read from here, so
 * nothing about a customer's app selection is hardcoded anywhere in the UI.
 */
export function WorkspaceProvider({ initial, children }) {
  const [workspace, setWorkspace] = useState(initial ?? null);
  const [loading, setLoading] = useState(!initial);

  const reload = useCallback(async () => {
    try {
      const response = await api.get('/me/workspace');
      setWorkspace(response.data);
      return response.data;
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!initial) reload();
  }, [initial, reload]);

  const can = useCallback(
    (permission) => {
      if (!workspace) return false;
      if (workspace.member?.is_owner) return true;
      return workspace.permissions?.includes(permission) ?? false;
    },
    [workspace],
  );

  const hasApp = useCallback(
    (slug) => workspace?.apps?.includes(slug) ?? false,
    [workspace],
  );

  const value = {
    workspace,
    loading,
    reload,
    can,
    hasApp,
    user: workspace?.user ?? null,
    organization: workspace?.organization ?? null,
    navigation: workspace?.navigation ?? [],
    widgets: workspace?.widgets ?? [],
    subscription: workspace?.subscription ?? null,
    // True when this member can ONLY use the employee portal.
    portalOnly: workspace?.portal_only ?? false,
  };

  return <WorkspaceContext.Provider value={value}>{children}</WorkspaceContext.Provider>;
}

export function useWorkspace() {
  const context = useContext(WorkspaceContext);
  if (!context) throw new Error('useWorkspace must be used inside <WorkspaceProvider>');
  return context;
}

/** Hide UI a user cannot act on. The real gate is the gateway, not this. */
export function Can({ permission, app, fallback = null, children }) {
  const { can, hasApp } = useWorkspace();
  if (app && !hasApp(app)) return fallback;
  if (permission && !can(permission)) return fallback;
  return children;
}
