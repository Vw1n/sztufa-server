import { BadRequestException } from '@nestjs/common';
import { PdfParserService } from './pdf-parser.service';

describe('PdfParserService', () => {
  let service: PdfParserService;

  beforeEach(() => {
    service = new PdfParserService();
  });

  it('应该拒绝为空的 PDF 文件', async () => {
    await expect(service.parseRegistrationPdf(null as any)).rejects.toThrow(BadRequestException);
  });

  it('应该拒绝魔数非 %PDF- 的非 PDF 文件', async () => {
    const fakeFile = {
      buffer: Buffer.from('NOT_A_PDF_DATA'),
      size: 14,
    } as any;

    await expect(service.parseRegistrationPdf(fakeFile)).rejects.toThrow('无效的 PDF 文件类型');
  });

  it('应该拒绝超过 20MB 的超大文件', async () => {
    const hugeFile = {
      buffer: Buffer.from('%PDF-1.4...'),
      size: 21 * 1024 * 1024,
    } as any;

    await expect(service.parseRegistrationPdf(hugeFile)).rejects.toThrow('PDF 文件大小超过限制');
  });

  it('应该对文本字符极少的纯扫描件弹出友善拦截提示', async () => {
    const mockEmptyPdfBuffer = Buffer.from(
      '%PDF-1.4\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>\nendobj\nxref\n0 4\n0000000000 65535 f \n0000000009 00000 n \n0000000062 00000 n \n0000000117 00000 n \ntrailer\n<< /Size 4 /Root 1 0 R >>\nstartxref\n185\n%%EOF',
    );

    const scannedFile = {
      buffer: mockEmptyPdfBuffer,
      size: mockEmptyPdfBuffer.length,
    } as any;

    await expect(service.parseRegistrationPdf(scannedFile)).rejects.toThrow(
      '第一期暂不支持扫描图片件，请上传原生文本 PDF 报名表',
    );
  });

  it('应该在 2D 空间包围盒 IoU 相交匹配中实现单图唯一性防重匹配', () => {
    const pageTexts = [
      {
        page: 1,
        items: [
          { text: '报名表', x: 100, y: 700, page: 1 },
          { text: '队伍名称', x: 50, y: 650, page: 1 },
          { text: '测试工程学院', x: 120, y: 650, page: 1 },
          { text: '球员姓名', x: 50, y: 500, page: 1 },
          { text: '学号', x: 150, y: 500, page: 1 },
          { text: '球衣号码', x: 250, y: 500, page: 1 },
          { text: '学号', x: 10, y: 400, page: 1 },
          // 球员 1
          { text: '张三', x: 50, y: 400, page: 1 },
          { text: '202100010001', x: 150, y: 400, page: 1 },
          { text: '10', x: 250, y: 400, page: 1 },
          // 球员 2
          { text: '李四', x: 350, y: 400, page: 1 },
          { text: '202100010002', x: 450, y: 400, page: 1 },
          { text: '11', x: 550, y: 400, page: 1 },
        ],
      },
    ];

    const images = [
      // 匹配球员 1 的照片
      { id: 'img_p1', buffer: Buffer.from('img1'), x: 130, y: 420, width: 40, height: 60, page: 1 },
      // 匹配球员 2 的照片
      { id: 'img_p2', buffer: Buffer.from('img2'), x: 430, y: 420, width: 40, height: 60, page: 1 },
    ];

    const extractPlayers = (service as any).extractPlayersFromPage(pageTexts[0].items, images, 1);

    expect(extractPlayers.length).toBe(2);
    expect(extractPlayers[0].photo.value).toBe('img_p1');
    expect(extractPlayers[1].photo.value).toBe('img_p2');
    // 验证唯一匹配：img_p1 与 img_p2 互不相同且无重合分配
    expect(extractPlayers[0].photo.value).not.toBe(extractPlayers[1].photo.value);
  });
});
