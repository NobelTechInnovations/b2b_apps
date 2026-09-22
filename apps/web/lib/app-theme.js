/**
 * App colour tints.
 *
 * Deliberately NOT a client module: both Server and Client Components need
 * these, and a `'use client'` file's exports cannot be called during a server
 * render. Pure data and a pure function, importable from anywhere.
 */
export const APP_TINT = {
  indigo: 'bg-[#eef2ff] text-[#4f46e5] dark:bg-[rgb(99_102_241/0.14)] dark:text-[#a5b4fc]',
  emerald: 'bg-[#ecfdf5] text-[#059669] dark:bg-[rgb(16_185_129/0.14)] dark:text-[#6ee7b7]',
  violet: 'bg-[#f5f3ff] text-[#7c3aed] dark:bg-[rgb(139_92_246/0.14)] dark:text-[#c4b5fd]',
  amber: 'bg-[#fffbeb] text-[#d97706] dark:bg-[rgb(245_158_11/0.14)] dark:text-[#fcd34d]',
  sky: 'bg-[#f0f9ff] text-[#0284c7] dark:bg-[rgb(14_165_233/0.14)] dark:text-[#7dd3fc]',
  cyan: 'bg-[#ecfeff] text-[#0891b2] dark:bg-[rgb(6_182_212/0.14)] dark:text-[#67e8f9]',
  rose: 'bg-[#fff1f2] text-[#e11d48] dark:bg-[rgb(244_63_94/0.14)] dark:text-[#fda4af]',
  pink: 'bg-[#fdf2f8] text-[#db2777] dark:bg-[rgb(236_72_153/0.14)] dark:text-[#f9a8d4]',
  purple: 'bg-[#faf5ff] text-[#9333ea] dark:bg-[rgb(168_85_247/0.14)] dark:text-[#d8b4fe]',
  fuchsia: 'bg-[#fdf4ff] text-[#c026d3] dark:bg-[rgb(217_70_239/0.14)] dark:text-[#f0abfc]',
  orange: 'bg-[#fff7ed] text-[#ea580c] dark:bg-[rgb(249_115_22/0.14)] dark:text-[#fdba74]',
  teal: 'bg-[#f0fdfa] text-[#0d9488] dark:bg-[rgb(20_184_166/0.14)] dark:text-[#5eead4]',
  lime: 'bg-[#f7fee7] text-[#65a30d] dark:bg-[rgb(132_204_22/0.14)] dark:text-[#bef264]',
  blue: 'bg-[#eff6ff] text-[#2563eb] dark:bg-[rgb(59_130_246/0.14)] dark:text-[#93c5fd]',
  slate: 'bg-[var(--surface-sunken)] text-[var(--text-secondary)]',
};

export const tintFor = (colour) => APP_TINT[colour] ?? APP_TINT.slate;
