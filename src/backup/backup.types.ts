import { BackupScope } from './backup-scope.service';

/**
 * 备份领域公共类型。
 * 独立成文件以消除服务间的反向类型依赖（例如 retention → backup.service 的循环隐患）。
 */

export interface BackupMetadata {
  key: string;
  filename: string;
  size: number;
  lastModified?: Date;
  formatVersion?: string;
  compressed?: boolean;
  checksum?: string;
  purpose?: string;
  protected?: boolean;
  validated?: boolean;
  scope?: BackupScope;
  seasonId?: string;
}

export interface UploadInitResult {
  uploadToken: string;
  uploadUrl: string;
  key: string;
  expiresIn: number;
  requiredHeaders: Record<string, string>;
}

export interface CreateBackupOptions {
  purpose?: 'manual' | 'scheduled' | 'pre-restore' | 'uploaded';
  protected?: boolean;
  scope?: BackupScope;
  seasonId?: string;
  signal?: AbortSignal;
}

/** 无状态 HMAC 上传 Token 的载荷结构 */
export interface UploadTokenPayload {
  key: string;
  size: number;
  fileSha256: string;
  userId: string;
  expiresAt: number;
}
