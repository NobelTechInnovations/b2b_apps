'use client';
import { createContext, useContext } from 'react';
export const AiHelpContext = createContext(false);
export function useAiHelp() { return useContext(AiHelpContext); }
export function askAboutField(label, hint) {
  window.dispatchEvent(new CustomEvent('nexus:ai-help', { detail: { field: String(label ?? '').slice(0, 120), hint: typeof hint === 'string' ? hint.slice(0, 80) : '' } }));
}
