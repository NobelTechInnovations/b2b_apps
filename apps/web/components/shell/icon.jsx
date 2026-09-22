'use client';

import * as Icons from 'lucide-react';
import { Circle } from 'lucide-react';

/**
 * The app registry stores icon names as strings, so the shell resolves them at
 * render time. Adding an app never means touching a component.
 */
export function Icon({ name, className, strokeWidth = 1.75 }) {
  const Component = Icons[name] ?? Circle;
  return <Component className={className} strokeWidth={strokeWidth} />;
}

// Re-exported so existing client imports keep working. Server Components must
// import these from '@/lib/app-theme' — a client module's exports cannot be
// called during a server render.
export { APP_TINT, tintFor } from '@/lib/app-theme';
