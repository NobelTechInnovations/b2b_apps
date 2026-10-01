/**
 * CSV as Excel and Google Sheets write it: quoted fields, doubled quotes, line
 * breaks inside quotes, a byte-order mark, and comma, semicolon or tab
 * separators. Returns the header row and one object per data row.
 */
export function parseCsv(text) {
  const source = String(text ?? '').replace(/^\uFEFF/, '');
  const firstLine = source.split(/\r?\n/, 1)[0] ?? '';
  const delimiter = [',', ';', '\t'].map((d) => [d, firstLine.split(d).length]).sort((a, b) => b[1] - a[1])[0][0];
  const records = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i];
    if (quoted) {
      if (ch === '"') {
        if (source[i + 1] === '"') { field += '"'; i += 1; } else quoted = false;
      } else field += ch;
    } else if (ch === '"' && field === '') quoted = true;
    else if (ch === delimiter) { row.push(field); field = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && source[i + 1] === '\n') i += 1;
      row.push(field); field = '';
      if (row.some((cell) => cell.trim() !== '')) records.push(row);
      row = [];
    } else field += ch;
  }
  row.push(field);
  if (row.some((cell) => cell.trim() !== '')) records.push(row);
  const [head = [], ...body] = records;
  const seen = new Map();
  const headers = head.map((h, index) => {
    const base = h.trim() || `Column ${index + 1}`;
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    return n > 1 ? `${base} (${n})` : base;
  });
  return { headers, rows: body.map((cells) => Object.fromEntries(headers.map((h, i) => [h, (cells[i] ?? '').trim()]))) };
}

/** One CSV line, quoted so commas, quotes and formulas survive. */
export function csvLine(values) {
  return values.map((value) => {
    const text = String(value ?? '');
    return `"${(/^[=+\-@]/.test(text) ? `'${text}` : text).replace(/"/g, '""')}"`;
  }).join(',');
}

export function downloadCsv(name, lines) {
  const blob = new Blob([`\uFEFF${lines.join('\n')}\n`], { type: 'text/csv;charset=utf-8' });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = name;
  link.click();
  URL.revokeObjectURL(link.href);
}

export const squash = (text) => String(text ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
