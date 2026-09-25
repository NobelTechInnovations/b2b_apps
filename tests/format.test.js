import { test } from 'node:test';
import assert from 'node:assert/strict';
import { relativeTime, money } from '../apps/web/lib/format.js';

const ago = (ms) => new Date(Date.now() - ms).toISOString();

test('relativeTime counts in the right unit', () => {
  assert.equal(relativeTime(ago(10_000)), 'just now');
  assert.equal(relativeTime(ago(5 * 60_000)), '5 minutes ago');
  assert.equal(relativeTime(ago(59 * 60_000)), '59 minutes ago');
  assert.equal(relativeTime(ago(3 * 3_600_000)), '3 hours ago');
  assert.equal(relativeTime(ago(26 * 3_600_000)), 'yesterday');
  assert.equal(relativeTime(ago(3 * 86_400_000)), '3 days ago');
  assert.equal(relativeTime(ago(14 * 86_400_000)), '2 weeks ago');
  assert.equal(relativeTime(ago(90 * 86_400_000)), '3 months ago');
  assert.equal(relativeTime(ago(800 * 86_400_000)), '2 years ago');
});

test('money shows paise as two digits, and drops them when whole', () => {
  assert.equal(money(550.5), '₹550.50');
  assert.equal(money(1249.5), '₹1,249.50');
  assert.equal(money(52000), '₹52,000');
  assert.equal(money('1003000.00'), '₹10,03,000');
});
