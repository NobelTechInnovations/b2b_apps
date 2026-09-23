import { createHash } from 'node:crypto';
import { mkdir, writeFile, readFile, unlink, stat } from 'node:fs/promises';
import path from 'node:path';

/**
 * Content-addressed blob storage.
 *
 * The key is the SHA-256 of the content, sharded two levels deep so no single
 * directory ever holds a million entries. Identical bytes are written once
 * however many documents point at them, which is why re-uploading the same
 * 40 MB deck to five folders costs 40 MB and not 200.
 *
 * The interface is deliberately small — put/get/remove/exists — so an S3 or
 * GCS backend can replace this without touching a caller.
 */
export function createLocalStorage({ root }) {
  const keyFor = (checksum) => path.join(checksum.slice(0, 2), checksum.slice(2, 4), checksum);
  const fullPath = (key) => path.join(root, key);

  return {
    kind: 'local',

    checksum(buffer) {
      return createHash('sha256').update(buffer).digest('hex');
    },

    async put(buffer) {
      const checksum = this.checksum(buffer);
      const key = keyFor(checksum);
      const target = fullPath(key);

      // Already stored: identical content, nothing to write.
      try {
        const existing = await stat(target);
        return { checksum, key, byteSize: existing.size, deduped: true };
      } catch {
        // not present — fall through and write it
      }

      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, buffer);

      return { checksum, key, byteSize: buffer.byteLength, deduped: false };
    },

    async get(key) {
      return readFile(fullPath(key));
    },

    async exists(key) {
      try {
        await stat(fullPath(key));
        return true;
      } catch {
        return false;
      }
    },

    async remove(key) {
      try {
        await unlink(fullPath(key));
        return true;
      } catch {
        return false;
      }
    },
  };
}

/** Classification drives icons, previews and whether the import wizard offers itself. */
export function classify(filename, mimeType) {
  const extension = (filename.split('.').pop() ?? '').toLowerCase();

  const spreadsheet = ['xlsx', 'xls', 'xlsm', 'csv', 'tsv'];
  const document = ['doc', 'docx', 'odt', 'rtf', 'txt', 'md'];
  const image = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'heic'];
  const archive = ['zip', 'tar', 'gz', 'rar', '7z'];

  if (spreadsheet.includes(extension)) return { kind: 'spreadsheet', extension };
  if (extension === 'pdf' || mimeType === 'application/pdf') return { kind: 'pdf', extension };
  if (document.includes(extension)) return { kind: 'document', extension };
  if (image.includes(extension) || mimeType?.startsWith('image/')) return { kind: 'image', extension };
  if (archive.includes(extension)) return { kind: 'archive', extension };

  return { kind: 'file', extension };
}

export const isSpreadsheet = (filename, mimeType) => classify(filename, mimeType).kind === 'spreadsheet';

export function humanSize(bytes) {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = Number(bytes);
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value < 10 && unit > 0 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}
