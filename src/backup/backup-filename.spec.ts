import {
  buildAttachmentContentDisposition,
  buildBackupFilename,
  sanitizeBackupFilenameSegment,
} from './backup-filename';

describe('backup filename', () => {
  it('在赛季备份文件名中保留可辨识名称、完整 ID 与保护标记', () => {
    expect(
      buildBackupFilename({
        module: 'season',
        season: { id: 'season-clx123', name: '2026 秋季/联赛' },
        createdAt: new Date('2026-09-09T12:00:00.000Z'),
        purpose: 'archive',
        protected: true,
      }),
    ).toBe('season_2026-秋季-联赛_season-clx123_20260909T120000Z_archive_protected.json.gz');
  });

  it('清除路径字符、控制字符与仅由分隔符组成的名称', () => {
    expect(sanitizeBackupFilenameSegment('../\\\u0000', 'unnamed-season')).toBe('unnamed-season');
  });

  it('为中文文件名提供 ASCII fallback 与 UTF-8 下载名', () => {
    const disposition = buildAttachmentContentDisposition('season_秋季联赛_id.json.gz');
    expect(disposition).toContain('filename="season______id.json.gz"');
    expect(disposition).toContain(
      "filename*=UTF-8''season_%E7%A7%8B%E5%AD%A3%E8%81%94%E8%B5%9B_id.json.gz",
    );
  });
});
