'use client';

import { useMemo } from 'react';

/**
 * A very small Markdown renderer, for letters.
 *
 * Employment letters use a deliberately narrow subset — headings, bold,
 * italics, tables, lists and paragraphs — so a dependency that handles the
 * whole CommonMark spec would be weight we never use.
 *
 * It never renders raw HTML. Letter bodies are written by HR staff, which
 * makes them untrusted input as far as the browser is concerned: everything
 * is escaped first, and only the handful of patterns below become markup.
 */

const escape = (text) =>
  String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

/** Inline emphasis, applied after escaping so `<b>` in the source stays text. */
const inline = (text) =>
  escape(text)
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
    .replace(/`([^`]+)`/g, '<code>$1</code>');

function renderTable(lines) {
  const cells = (line) =>
    line.replace(/^\||\|$/g, '').split('|').map((cell) => cell.trim());

  const [head, , ...body] = lines;
  const headCells = cells(head);

  // A two-column table with an empty header row is the "label / value" idiom
  // letters use for a salary summary; it should not print an empty header.
  const headless = headCells.every((cell) => cell === '');

  return `<table>${
    headless ? '' : `<thead><tr>${headCells.map((c) => `<th>${inline(c)}</th>`).join('')}</tr></thead>`
  }<tbody>${body
    .map((line) => `<tr>${cells(line).map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`)
    .join('')}</tbody></table>`;
}

function toHtml(source) {
  const lines = String(source ?? '').replace(/\r\n/g, '\n').split('\n');
  const out = [];
  let paragraph = [];
  let list = null;

  const flushParagraph = () => {
    if (!paragraph.length) return;
    out.push(`<p>${paragraph.map(inline).join('<br />')}</p>`);
    paragraph = [];
  };
  const flushList = () => {
    if (!list) return;
    out.push(`<${list.tag}>${list.items.map((i) => `<li>${inline(i)}</li>`).join('')}</${list.tag}>`);
    list = null;
  };
  const flush = () => { flushParagraph(); flushList(); };

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];

    if (!line.trim()) { flush(); continue; }

    const heading = line.match(/^(#{1,4})\s+(.*)$/);
    if (heading) {
      flush();
      const level = heading[1].length;
      out.push(`<h${level}>${inline(heading[2])}</h${level}>`);
      continue;
    }

    if (/^\s*([-*_])\1{2,}\s*$/.test(line)) { flush(); out.push('<hr />'); continue; }

    // A table is a run of pipe-delimited lines with a separator second.
    if (line.trim().startsWith('|') && lines[i + 1]?.trim().match(/^\|[\s:|-]+\|$/)) {
      flush();
      const block = [];
      while (i < lines.length && lines[i].trim().startsWith('|')) { block.push(lines[i].trim()); i += 1; }
      i -= 1;
      out.push(renderTable(block));
      continue;
    }

    const bullet = line.match(/^\s*[-*]\s+(.*)$/);
    const numbered = line.match(/^\s*\d+[.)]\s+(.*)$/);
    if (bullet || numbered) {
      flushParagraph();
      const tag = bullet ? 'ul' : 'ol';
      if (list?.tag !== tag) { flushList(); list = { tag, items: [] }; }
      list.items.push((bullet ?? numbered)[1]);
      continue;
    }

    flushList();
    paragraph.push(line);
  }

  flush();
  return out.join('\n');
}

/**
 * Tailwind's reset strips every margin from headings, paragraphs and lists,
 * which is right for an app and wrong for a document. These rules put a
 * letter's typography back, scoped to this component so nothing else changes.
 */
const STYLES = `
.nx-md { line-height: 1.65; font-size: 13px; }
.nx-md > * + * { margin-top: 0.85em; }
.nx-md h1 { font-size: 1.35em; font-weight: 700; letter-spacing: -0.01em; }
.nx-md h2 { font-size: 1.15em; font-weight: 700; }
.nx-md h3, .nx-md h4 { font-size: 1em; font-weight: 700; }
.nx-md h1, .nx-md h2, .nx-md h3, .nx-md h4 { margin-top: 1.5em; }
.nx-md > h1:first-child, .nx-md > h2:first-child { margin-top: 0; }
.nx-md strong { font-weight: 650; }
.nx-md ul, .nx-md ol { padding-left: 1.4em; }
.nx-md ul { list-style: disc; }
.nx-md ol { list-style: decimal; }
.nx-md li + li { margin-top: 0.3em; }
.nx-md hr { border: 0; border-top: 1px solid currentColor; opacity: 0.15; margin: 1.6em 0; }
.nx-md table { width: 100%; border-collapse: collapse; font-size: 0.95em; }
.nx-md th, .nx-md td { border: 1px solid currentColor; border-color: rgb(0 0 0 / 0.12);
                       padding: 0.4em 0.7em; text-align: left; vertical-align: top; }
.nx-md th { font-weight: 650; background: rgb(0 0 0 / 0.03); }
/* A label/value table reads better with the first column doing the labelling. */
.nx-md td:first-child { color: rgb(0 0 0 / 0.62); width: 40%; }
.nx-md code { font-size: 0.9em; background: rgb(0 0 0 / 0.05); padding: 0.1em 0.3em; border-radius: 3px; }
`;

export function Markdown({ children, className }) {
  const html = useMemo(() => toHtml(children), [children]);

  return (
    <>
      <style>{STYLES}</style>
      <div
        className={`nx-md ${className ?? ''}`}
        // Safe by construction: `toHtml` escapes every character of the source
        // before any markup is added, so nothing in the input can become a tag.
        dangerouslySetInnerHTML={{ __html: html }}
      />
    </>
  );
}
