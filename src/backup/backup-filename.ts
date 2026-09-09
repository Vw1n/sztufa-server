import { BackupModule } from './backup-module-registry';

const MAX_NAME_LENGTH = 48;

export function sanitizeBackupFilenameSegment(value: string, fallback: string): string {
  const sanitized = Array.from(
    value
      .normalize('NFKC')
      .trim()
      .replace(/[^\p{L}\p{N}_-]+/gu, '-')
      .replace(/-+/g, '-')
      .replace(/^[-_]+|[-_]+$/g, ''),
  )
    .slice(0, MAX_NAME_LENGTH)
    .join('');

  return sanitized || fallback;
}

export function buildBackupFilename(options: {
  module: 'full' | BackupModule;
  season?: { id: string; name: string };
  createdAt: Date;
  purpose: string;
  protected: boolean;
}): string {
  const timestamp = options.createdAt
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}Z$/, 'Z');
  const purpose = sanitizeBackupFilenameSegment(options.purpose, 'manual');
  const seasonPart = options.season
    ? `_${sanitizeBackupFilenameSegment(options.season.name, 'unnamed-season')}_${sanitizeBackupFilenameSegment(options.season.id, 'unknown-season')}`
    : '';
  const protectedPart = options.protected ? '_protected' : '';

  return `${options.module}${seasonPart}_${timestamp}_${purpose}${protectedPart}.json.gz`;
}

export function buildAttachmentContentDisposition(filename: string): string {
  const asciiFallback = filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `attachment; filename="${asciiFallback}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}
