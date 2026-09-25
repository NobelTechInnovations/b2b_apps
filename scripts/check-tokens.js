#!/usr/bin/env node
/**
 * Every `var(--token)` the web app uses must be defined in globals.css.
 *
 * An undefined custom property does not error — it silently resolves to
 * nothing, so `bg-[var(--surface-base)]` renders as a transparent background.
 * That is exactly how the salary register came to show the page behind it.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

const WEB = path.join(process.cwd(), 'apps', 'web');

const files = [];
(function walk(dir) {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name.startsWith('.next')) continue;
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) walk(full);
    else if (/\.(jsx?|css)$/.test(name)) files.push(full);
  }
})(WEB);

// Tokens are defined in globals.css, in CSS modules that scope their own, and
// by next/font, which injects its variable on <html> at runtime.
const defined = new Set();
for (const file of files.filter((f) => f.endsWith('.css'))) {
  for (const match of readFileSync(file, 'utf8').matchAll(/(--[a-z0-9-]+)\s*:/g)) defined.add(match[1]);
}
for (const file of files.filter((f) => /\.jsx?$/.test(f))) {
  for (const match of readFileSync(file, 'utf8').matchAll(/variable:\s*['"](--[a-z0-9-]+)['"]/g)) defined.add(match[1]);
  // Inline style objects that set a custom property: { '--task-accent': … }
  for (const match of readFileSync(file, 'utf8').matchAll(/['"](--[a-z0-9-]+)['"]\s*:/g)) defined.add(match[1]);
}

const missing = new Map();
for (const file of files) {
  for (const match of readFileSync(file, 'utf8').matchAll(/var\((--[a-z0-9-]+)/g)) {
    if (defined.has(match[1])) continue;
    if (!missing.has(match[1])) missing.set(match[1], new Set());
    missing.get(match[1]).add(path.relative(WEB, file));
  }
}

if (!missing.size) {
  console.log(`  ✔ every design token used is defined (${defined.size} defined)`);
  process.exit(0);
}
for (const [token, where] of missing) {
  console.log(`  ✘ ${token} is used but never defined — ${[...where].join(', ')}`);
}
process.exit(1);
