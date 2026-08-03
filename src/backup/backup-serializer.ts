/**
 * 备份序列化兼容出口。
 *
 * 原单文件已按职责拆分为：
 * - backup-format.ts：备份格式共享类型
 * - backup-writer.ts：流式生成（createV3BackupStream）
 * - backup-parser.ts：流式解析状态机（parseAndValidateBackupStream）
 *
 * 本文件保留全部原有导出，保证既有调用方（服务、校验器、测试、memory 压测子进程）
 * 无需修改导入路径。
 */
export { createV3BackupStream } from './backup-writer';
export { parseAndValidateBackupStream } from './backup-parser';
export type { BackupManifestV3, PrepareV3StreamOptions, ParseStreamResult } from './backup-format';
