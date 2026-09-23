import ExcelJS from 'exceljs';

const MAX_PROFILE_ROWS = 500;   // enough to characterise a column
const MAX_SAMPLE_VALUES = 5;
const MAX_PREVIEW_ROWS = 100;

/**
 * Read a workbook into plain rows.
 *
 * ExcelJS hands back rich cell objects — formulas, hyperlinks, rich text,
 * dates — so everything is flattened to the value a person would see in the
 * cell. Anything downstream (profiling, preview, import) then works on
 * strings, numbers, booleans and Dates only.
 */
export async function readWorkbook(buffer, { extension } = {}) {
  const workbook = new ExcelJS.Workbook();

  if (extension === 'csv' || extension === 'tsv') {
    const text = buffer.toString('utf8');
    const delimiter = extension === 'tsv' ? '\t' : ',';
    return [{ name: 'Sheet1', rows: parseDelimited(text, delimiter) }];
  }

  await workbook.xlsx.load(buffer);

  return workbook.worksheets.map((sheet) => {
    const rows = [];
    sheet.eachRow({ includeEmpty: false }, (row) => {
      const values = [];
      // row.values is 1-indexed and sparse; walk by column count instead.
      for (let column = 1; column <= sheet.columnCount; column += 1) {
        values.push(flatten(row.getCell(column).value));
      }
      // Drop rows that are entirely empty — spreadsheets are full of them.
      if (values.some((v) => v !== null && v !== '')) rows.push(values);
    });
    return { name: sheet.name, rows };
  });
}

function flatten(value) {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value;
  if (typeof value === 'object') {
    if ('text' in value) return value.text;                                  // hyperlink
    if ('result' in value) return flatten(value.result);                     // formula
    if ('richText' in value) return value.richText.map((r) => r.text).join('');
    if ('error' in value) return null;                                       // #REF!, #N/A
    return String(value);
  }
  return value;
}

/** RFC-4180-ish CSV: handles quoted fields, embedded delimiters and "" escapes. */
function parseDelimited(text, delimiter) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];

    if (quoted) {
      if (char === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 1; }
        else quoted = false;
      } else field += char;
      continue;
    }

    if (char === '"') { quoted = true; continue; }
    if (char === delimiter) { row.push(field); field = ''; continue; }
    if (char === '\r') continue;
    if (char === '\n') {
      row.push(field);
      if (row.some((c) => c !== '')) rows.push(row);
      row = [];
      field = '';
      continue;
    }
    field += char;
  }

  row.push(field);
  if (row.some((c) => c !== '')) rows.push(row);

  return rows.map((r) => r.map((c) => (c === '' ? null : c)));
}

/**
 * Find the header row.
 *
 * Real exports rarely start at A1 — there is a title, a blank line, maybe a
 * "Generated on ..." stamp. The header is taken as the first row in the top
 * ten that is mostly non-empty text, has no duplicates, and is followed by a
 * row of a similar width. Falls back to row 0 rather than giving up.
 */
export function detectHeaderRow(rows) {
  const limit = Math.min(rows.length, 10);

  for (let i = 0; i < limit; i += 1) {
    const row = rows[i];
    const filled = row.filter((c) => c !== null && String(c).trim() !== '');
    if (filled.length < 2) continue;

    const allText = filled.every((c) => typeof c === 'string' || typeof c === 'number');
    const mostlyText = filled.filter((c) => typeof c === 'string').length >= filled.length * 0.6;
    const labels = filled.map((c) => String(c).trim().toLowerCase());
    const unique = new Set(labels).size === labels.length;

    const next = rows[i + 1];
    const nextFilled = next ? next.filter((c) => c !== null && String(c).trim() !== '').length : 0;

    if (allText && mostlyText && unique && nextFilled >= Math.max(1, filled.length - 2)) {
      return i;
    }
  }

  return 0;
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const PHONE = /^[+()\d][\d\s\-()]{6,}$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}/;
const DMY_DATE = /^\d{1,2}[/\-.]\d{1,2}[/\-.]\d{2,4}$/;
const BOOLEAN = /^(true|false|yes|no|y|n|1|0)$/i;

/** Best-guess type for a single cell. */
export function inferCellType(value) {
  if (value === null || value === undefined || value === '') return null;
  if (value instanceof Date) return 'date';
  if (typeof value === 'boolean') return 'boolean';
  if (typeof value === 'number') return Number.isInteger(value) ? 'number' : 'number';

  const text = String(value).trim();
  if (EMAIL.test(text)) return 'email';
  if (ISO_DATE.test(text) || DMY_DATE.test(text)) return 'date';
  if (BOOLEAN.test(text)) return 'boolean';
  if (PHONE.test(text) && text.replace(/\D/g, '').length >= 7) return 'phone';
  if (/^-?[\d,]+(\.\d+)?$/.test(text)) return 'number';
  return 'text';
}

/**
 * Profile every column: what it is called, what it holds, how complete it is.
 *
 * This is what makes the import wizard feel informed rather than blind — you
 * see "Email · 98% filled · 3 blanks" before you commit to a mapping.
 */
export function profileSheet(sheet) {
  const headerRow = detectHeaderRow(sheet.rows);
  const headers = (sheet.rows[headerRow] ?? []).map((cell, index) => {
    const label = cell === null ? '' : String(cell).trim();
    return label || `Column ${index + 1}`;
  });

  const dataRows = sheet.rows.slice(headerRow + 1);
  const sampleRows = dataRows.slice(0, MAX_PROFILE_ROWS);

  const columns = headers.map((header, index) => {
    const values = sampleRows.map((row) => row[index] ?? null);
    const filled = values.filter((v) => v !== null && String(v).trim() !== '');

    const typeCounts = {};
    for (const value of filled) {
      const type = inferCellType(value);
      if (type) typeCounts[type] = (typeCounts[type] ?? 0) + 1;
    }

    // The dominant type wins, but a column that is 90% numbers and 10% text
    // is still text as far as import validation is concerned.
    const ranked = Object.entries(typeCounts).sort((a, b) => b[1] - a[1]);
    const [topType, topCount] = ranked[0] ?? ['text', 0];
    const type = topCount / Math.max(filled.length, 1) >= 0.8 ? topType : 'text';

    const distinct = new Set(filled.map((v) => String(v))).size;

    return {
      index,
      header,
      type,
      filled: filled.length,
      blank: values.length - filled.length,
      fill_rate: values.length ? Math.round((filled.length / values.length) * 100) : 0,
      distinct,
      // A column where every value is unique is a natural key candidate.
      unique: filled.length > 0 && distinct === filled.length,
      samples: [...new Set(filled.map((v) => (v instanceof Date ? v.toISOString().slice(0, 10) : String(v))))]
        .slice(0, MAX_SAMPLE_VALUES),
    };
  });

  return {
    name: sheet.name,
    header_row: headerRow,
    headers,
    columns,
    total_rows: dataRows.length,
    preview: dataRows.slice(0, MAX_PREVIEW_ROWS).map((row) =>
      headers.map((_, index) => {
        const value = row[index] ?? null;
        return value instanceof Date ? value.toISOString().slice(0, 10) : value;
      }),
    ),
  };
}

/** Profile every sheet in a workbook, skipping ones with no usable data. */
export async function profileWorkbook(buffer, { extension } = {}) {
  const sheets = await readWorkbook(buffer, { extension });
  return sheets
    .filter((sheet) => sheet.rows.length > 0)
    .map(profileSheet)
    .filter((profile) => profile.headers.length > 0 && profile.total_rows > 0);
}

/** Rows as objects keyed by header, for the import engine. */
export async function readRows(buffer, { extension, sheetName, headerRow }) {
  const sheets = await readWorkbook(buffer, { extension });
  const sheet = sheets.find((s) => s.name === sheetName) ?? sheets[0];
  if (!sheet) return { headers: [], rows: [] };

  const index = headerRow ?? detectHeaderRow(sheet.rows);
  const headers = (sheet.rows[index] ?? []).map((cell, i) => {
    const label = cell === null ? '' : String(cell).trim();
    return label || `Column ${i + 1}`;
  });

  const rows = sheet.rows.slice(index + 1).map((row, offset) => {
    const record = {};
    headers.forEach((header, i) => { record[header] = row[i] ?? null; });
    // 1-based, and counted from the sheet's own first row so the number
    // matches what the person sees in Excel.
    record.__row = index + offset + 2;
    return record;
  });

  return { headers, rows };
}
