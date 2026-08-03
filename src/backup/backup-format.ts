import { BackupScope } from './backup-scope.service';
import { BackupStagingStore } from './backup-staging-store';

/**
 * 备份文件格式（V3）的共享类型定义。
 * 供 backup-writer（流式生成）与 backup-parser（流式解析）共同使用，
 * 避免两者互相引用或产生重复定义。
 */

export interface BackupManifestV3 {
  formatVersion: string;
  createdAt: string;
  environment: string;
  schemaVersion: string;
  checksumAlgorithm: string;
  checksum: string;
  compression: string;
  tables: Record<string, number>;
  scope?: BackupScope;
  season?: { id: string; name: string };
}

export interface PrepareV3StreamOptions {
  createdAt?: string;
  scope?: BackupScope;
  season?: { id: string; name: string };
}

export interface ParseStreamResult {
  manifest?: BackupManifestV3;
  formatVersion: string;
  timestamp?: number;
  scope: BackupScope;
  season?: { id: string; name: string };
  fileSha256: string;
  compressedSize: number;
  decompressedSize: number;
  computedChecksum: string;
  tableCounts: Record<string, number>;
  stagingStore: BackupStagingStore;
  cleanup: () => void;
}
