import { BadRequestException, ConflictException, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { PdfImportService } from './pdf-import.service';
import { PdfImportBatchStatus } from '@prisma/client';

describe('PdfImportService', () => {
  let service: PdfImportService;
  let prismaMock: any;
  let uploadServiceMock: any;
  let pdfParserServiceMock: any;

  beforeEach(() => {
    prismaMock = {
      pdfImportBatch: {
        findFirst: jest.fn(async () => null),
        findUnique: jest.fn(async () => null),
        findMany: jest.fn(async () => []),
        create: jest.fn(async () => ({})),
        updateMany: jest.fn(async () => ({ count: 1 })),
        update: jest.fn(async () => ({})),
      },
      $transaction: jest.fn(async (cb) => cb(prismaMock)),
      team: {
        findUnique: jest.fn(async () => null),
        create: jest.fn(async () => ({ id: 't1', teamName: '测试球队' })),
        update: jest.fn(async () => ({ id: 't1' })),
      },
      player: {
        findUnique: jest.fn(async () => null),
        create: jest.fn(async () => ({ id: 'p1' })),
        update: jest.fn(async () => ({ id: 'p1' })),
      },
    };

    uploadServiceMock = {
      uploadBuffer: jest.fn().mockResolvedValue('https://cdn.example.com/temp/pdf/batch1/p1.webp'),
      extractKeyFromUrl: jest.fn((url) => {
        if (!url) return '';
        if (url.startsWith('https://cdn.example.com/')) {
          return url.replace('https://cdn.example.com/', '');
        }
        return url;
      }),
      copyObject: jest.fn(async (src, dest) => `https://cdn.example.com/${dest}`),
      deleteByPrefix: jest.fn(async () => {}),
      deleteObjects: jest.fn(async () => {}),
    };

    pdfParserServiceMock = {
      parseRegistrationPdf: jest.fn(async () => ({
        teams: [
          {
            teamName: { value: '测试工程学院', confidence: 1.0, page: 1 },
            headCoach: { value: '李教练', confidence: 1.0, page: 1 },
            coachPhone: { value: '13800000000', confidence: 1.0, page: 1 },
            teamLeader: { value: '张领队', confidence: 1.0, page: 1 },
            leaderPhone: { value: '13900000000', confidence: 1.0, page: 1 },
            teamDoctor: { value: '王医生', confidence: 1.0, page: 1 },
            homeJerseyColor: { value: '白色', confidence: 1.0, page: 1 },
            awayJerseyColor: { value: '黑色', confidence: 1.0, page: 1 },
            players: [
              {
                name: { value: '张三', confidence: 1.0, page: 1 },
                studentId: { value: '202100010001', confidence: 1.0, page: 1 },
                jerseyNumber: { value: '10', confidence: 1.0, page: 1 },
                photo: { value: 'p1_1', confidence: 1.0, page: 1 },
                needsManualConfirm: false,
              },
            ],
          },
        ],
        extractedImages: [
          { id: 'p1_1', buffer: Buffer.from('img'), x: 180, y: 200, width: 60, height: 80, page: 1 },
        ],
      })),
    };

    service = new PdfImportService(
      prismaMock as any,
      uploadServiceMock as any,
      pdfParserServiceMock as any,
    );
  });

  describe('uploadBatchTempPhoto - 手动替换照片校验与转码', () => {
    it('手动更换照片时，若上传假图片/破坏数据，应由 sharp 校验解码并抛出 UnprocessableEntityException', async () => {
      prismaMock.pdfImportBatch.findUnique.mockResolvedValue({
        id: 'batch1',
        username: 'admin',
        status: PdfImportBatchStatus.PREVIEW,
      });
      const fakeFile = { buffer: Buffer.from('FAKE_NOT_AN_IMAGE_DATA') } as any;

      await expect(
        service.uploadBatchTempPhoto('batch1', 'admin', fakeFile),
      ).rejects.toThrow(UnprocessableEntityException);
    });
  });

  describe('previewPdf - 预检与异常物理回滚', () => {
    it('若 5 分钟内提交相同文件的 preview 且未过期，应返回现有批次', async () => {
      prismaMock.pdfImportBatch.findFirst.mockResolvedValue({
        id: 'pdf_existing_123',
        fileHash: 'hash123',
        expiresAt: new Date(Date.now() + 10000),
        previewData: { teams: [], hasLowConfidence: false },
      });

      const file = { buffer: Buffer.from('%PDF-1.4...'), size: 100 } as any;
      const res = await service.previewPdf(file, 'admin');

      expect(res.batchId).toBe('pdf_existing_123');
      expect(pdfParserServiceMock.parseRegistrationPdf).not.toHaveBeenCalled();
    });

    it('若 Preview 阶段上传 S3 后创建 DB 批次失败，应立即触发物理清理 S3 临时对象', async () => {
      prismaMock.pdfImportBatch.create.mockRejectedValue(new Error('DB 插入冲突'));

      const file = { buffer: Buffer.from('%PDF-1.4...'), size: 100 } as any;

      await expect(service.previewPdf(file, 'admin')).rejects.toThrow('DB 插入冲突');
      expect(uploadServiceMock.deleteByPrefix).toHaveBeenCalledWith(
        expect.stringMatching(/^temp\/pdf\/pdf_/),
      );
    });
  });

  describe('commitPdfBatch - 并发抢占与安全白名单校验', () => {
    it('超越当前批次范围的 S3 Key 应该被强行拒绝，且在抢占状态前报错', async () => {
      const dto = {
        teams: [
          {
            teamName: { value: '测试球队', confidence: 1.0 },
            headCoach: { value: '李教练', confidence: 1.0 },
            coachPhone: { value: '13800000000', confidence: 1.0 },
            teamLeader: { value: '张领队', confidence: 1.0 },
            leaderPhone: { value: '13900000000', confidence: 1.0 },
            homeJerseyColor: { value: '白', confidence: 1.0 },
            awayJerseyColor: { value: '黑', confidence: 1.0 },
            players: [
              {
                name: { value: '张三', confidence: 1.0 },
                studentId: { value: '202100010001', confidence: 1.0 },
                jerseyNumber: { value: '10', confidence: 1.0 },
                photo: { value: 'https://cdn.example.com/other_batch/p1.webp', confidence: 1.0 },
                needsManualConfirm: false,
              },
            ],
          },
        ],
      } as any;

      await expect(service.commitPdfBatch('batch1', 'admin', dto)).rejects.toThrow(
        BadRequestException,
      );
      expect(prismaMock.pdfImportBatch.updateMany).not.toHaveBeenCalled();
    });

    it('未经人工确认且包含低置信度字段时，应拦截拒绝提交且不抢占状态', async () => {
      const dto = {
        teams: [
          {
            teamName: { value: '测试球队', confidence: 1.0 },
            headCoach: { value: '李教练', confidence: 1.0 },
            coachPhone: { value: '13800000000', confidence: 1.0 },
            teamLeader: { value: '张领队', confidence: 1.0 },
            leaderPhone: { value: '13900000000', confidence: 1.0 },
            homeJerseyColor: { value: '白', confidence: 1.0 },
            awayJerseyColor: { value: '黑', confidence: 1.0 },
            players: [
              {
                name: { value: '低置信度球员', confidence: 1.0 },
                studentId: { value: '202100010001', confidence: 1.0 },
                jerseyNumber: { value: '10', confidence: 1.0 },
                photo: { value: 'https://cdn.example.com/temp/pdf/batch1/p1.webp', confidence: 0.5, manuallyConfirmed: false },
                needsManualConfirm: true,
              },
            ],
          },
        ],
      } as any;

      await expect(service.commitPdfBatch('batch1', 'admin', dto)).rejects.toThrow(
        BadRequestException,
      );
      expect(prismaMock.pdfImportBatch.updateMany).not.toHaveBeenCalled();
    });

    it('并发 commit 时，updateMany 为 0 应该直接抛出 409 ConflictException', async () => {
      prismaMock.pdfImportBatch.updateMany.mockResolvedValue({ count: 0 });

      const dto = {
        teams: [
          {
            teamName: { value: '测试球队', confidence: 1.0 },
            headCoach: { value: '李教练', confidence: 1.0 },
            coachPhone: { value: '13800000000', confidence: 1.0 },
            teamLeader: { value: '张领队', confidence: 1.0 },
            leaderPhone: { value: '13900000000', confidence: 1.0 },
            homeJerseyColor: { value: '白', confidence: 1.0 },
            awayJerseyColor: { value: '黑', confidence: 1.0 },
            players: [],
          },
        ],
      } as any;

      await expect(service.commitPdfBatch('batch1', 'admin', dto)).rejects.toThrow(
        ConflictException,
      );
    });

    it('DB 事务执行失败且 S3 清理异常时，应将批次标记为 FAILED 且 cleanupRequired = true', async () => {
      prismaMock.team.findUnique.mockRejectedValue(new Error('Prisma 写入死锁'));
      uploadServiceMock.deleteByPrefix.mockRejectedValueOnce(new Error('S3 物理清理 503 超时'));

      const dto = {
        teams: [
          {
            teamName: { value: '测试球队', confidence: 1.0 },
            headCoach: { value: '李教练', confidence: 1.0 },
            coachPhone: { value: '13800000000', confidence: 1.0 },
            teamLeader: { value: '张领队', confidence: 1.0 },
            leaderPhone: { value: '13900000000', confidence: 1.0 },
            homeJerseyColor: { value: '白', confidence: 1.0 },
            awayJerseyColor: { value: '黑', confidence: 1.0 },
            players: [
              {
                name: { value: '张三', confidence: 1.0 },
                studentId: { value: '202100010001', confidence: 1.0 },
                jerseyNumber: { value: '10', confidence: 1.0 },
                photo: { value: 'https://cdn.example.com/temp/pdf/batch1/p1.webp', confidence: 1.0, manuallyConfirmed: true },
                needsManualConfirm: false,
              },
            ],
          },
        ],
      } as any;

      await expect(service.commitPdfBatch('batch1', 'admin', dto)).rejects.toThrow('PDF 批次提交失败');

      expect(prismaMock.pdfImportBatch.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'batch1' },
          data: expect.objectContaining({
            status: PdfImportBatchStatus.FAILED,
            cleanupRequired: true,
          }),
        }),
      );
    });
  });

  describe('recoverStuckBatches - 僵死批次与 cleanupRequired 扫描重试', () => {
    it('应扫描 cleanupRequired = true 的批次并在物理清理成功后置复位 cleanupRequired = false', async () => {
      prismaMock.pdfImportBatch.findMany.mockResolvedValue([
        { id: 'failed_batch_88', status: PdfImportBatchStatus.FAILED, cleanupRequired: true },
      ]);
      uploadServiceMock.deleteByPrefix.mockResolvedValueOnce();

      const res = await service.recoverStuckBatches();

      expect(res.recoveredBatchesCount).toBe(1);
      expect(uploadServiceMock.deleteByPrefix).toHaveBeenCalledWith(
        'uploads/players/imports/failed_batch_88/',
      );
      expect(prismaMock.pdfImportBatch.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'failed_batch_88' },
          data: expect.objectContaining({ cleanupRequired: false }),
        }),
      );
    });
  });

  describe('cancelPdfBatch - 取消批次', () => {
    it('非本人批次应拒绝取消', async () => {
      prismaMock.pdfImportBatch.findUnique.mockResolvedValue({
        id: 'batch1',
        username: 'other_user',
      });

      await expect(service.cancelPdfBatch('batch1', 'admin')).rejects.toThrow(
        NotFoundException,
      );
    });

    it('成功取消 PREVIEW 批次并销毁临时文件', async () => {
      prismaMock.pdfImportBatch.findUnique.mockResolvedValue({
        id: 'batch1',
        username: 'admin',
        status: PdfImportBatchStatus.PREVIEW,
      });

      const res = await service.cancelPdfBatch('batch1', 'admin');
      expect(res.batchId).toBe('batch1');
      expect(uploadServiceMock.deleteByPrefix).toHaveBeenCalledWith('temp/pdf/batch1/');
      expect(prismaMock.pdfImportBatch.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'batch1' },
          data: expect.objectContaining({ status: PdfImportBatchStatus.CANCELLED }),
        }),
      );
    });
  });
});
