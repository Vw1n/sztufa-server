import { BackupScope } from './backup-scope.service';
import { BackupStagingStore } from './backup-staging-store';
import { BackupModule, BackupTableRole } from './backup-module-registry';
import { PersistentBackupTableName } from './backup-table-registry';

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

export interface BackupManifestV4 {
  formatVersion: '4.0';
  createdAt: string;
  environment: string;
  schemaVersion: '4.0';
  checksumAlgorithm: 'sha256';
  checksum: string;
  compression: 'gzip';
  scope: 'full' | 'module';
  module: 'full' | BackupModule;
  selector: Record<string, string>;
  tables: Partial<Record<PersistentBackupTableName, number>>;
  tableRoles: Partial<Record<PersistentBackupTableName, BackupTableRole>>;
  externalDependencies: PersistentBackupTableName[];
  planDigest: string;
}

export type BackupManifest = BackupManifestV3 | BackupManifestV4;

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
