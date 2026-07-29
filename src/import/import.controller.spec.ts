import { BadRequestException, ValidationPipe } from '@nestjs/common';
import { ImportController } from './import.controller';
import { PdfCommitRequestDto } from './dto/pdf-import.dto';
import { validate } from 'class-validator';

describe('ImportController & ValidationPipe DTO Safety', () => {
  let controller: ImportController;
  let importServiceMock: any;
  let pdfImportServiceMock: any;

  beforeEach(() => {
    importServiceMock = {
      previewFiles: jest.fn(),
      importFiles: jest.fn(),
      getLastImport: jest.fn(),
      undoLastImport: jest.fn(),
    };

    pdfImportServiceMock = {
      previewPdf: jest.fn(),
      commitPdfBatch: jest.fn(),
      cancelPdfBatch: jest.fn(),
      recoverStuckBatches: jest.fn(),
    };

    controller = new ImportController(importServiceMock as any, pdfImportServiceMock as any);
  });

  it('全局 ValidationPipe (whitelist: true) 绝不应剥离 ParsedFieldDto 中的 value, confidence, page 字段', async () => {
    const rawPayload = {
      teams: [
        {
          teamName: { value: '工程学院', confidence: 1.0, page: 1, manuallyConfirmed: true },
          headCoach: { value: '李教练', confidence: 1.0, page: 1, manuallyConfirmed: true },
          coachPhone: { value: '13800000000', confidence: 1.0, page: 1, manuallyConfirmed: true },
          teamLeader: { value: '张领队', confidence: 1.0, page: 1, manuallyConfirmed: true },
          leaderPhone: { value: '13900000000', confidence: 1.0, page: 1, manuallyConfirmed: true },
          teamDoctor: { value: '王医生', confidence: 1.0, page: 1, manuallyConfirmed: true },
          homeJerseyColor: { value: '白色', confidence: 1.0, page: 1, manuallyConfirmed: true },
          awayJerseyColor: { value: '黑色', confidence: 1.0, page: 1, manuallyConfirmed: true },
          players: [
            {
              name: { value: '张三', confidence: 1.0, page: 1, manuallyConfirmed: true },
              studentId: {
                value: '202100010001',
                confidence: 1.0,
                page: 1,
                manuallyConfirmed: true,
              },
              jerseyNumber: { value: '10', confidence: 1.0, page: 1, manuallyConfirmed: true },
              photo: {
                value: 'temp/pdf/b1/p1.webp',
                confidence: 1.0,
                page: 1,
                manuallyConfirmed: true,
              },
              needsManualConfirm: false,
            },
          ],
        },
      ],
    };

    const pipe = new ValidationPipe({ whitelist: true, transform: true });
    const transformedDto = (await pipe.transform(rawPayload, {
      type: 'body',
      metatype: PdfCommitRequestDto,
    })) as PdfCommitRequestDto;

    expect(transformedDto.teams[0].teamName.value).toBe('工程学院');
    expect(transformedDto.teams[0].teamName.confidence).toBe(1.0);
    expect(transformedDto.teams[0].players[0].name.value).toBe('张三');
    expect(transformedDto.teams[0].players[0].photo.value).toBe('temp/pdf/b1/p1.webp');

    const errors = await validate(transformedDto);
    expect(errors.length).toBe(0);
  });

  describe('previewPdf', () => {
    it('拒绝未提供文件', async () => {
      await expect(controller.previewPdf(null as any, {})).rejects.toThrow(BadRequestException);
    });

    it('拒绝非 .pdf 后缀的文件', async () => {
      const file = { originalname: 'test.docx' } as any;
      await expect(controller.previewPdf(file, {})).rejects.toThrow(BadRequestException);
    });

    it('正确转发符合规范的 PDF 文件至 PdfImportService', async () => {
      const file = { originalname: 'registration.pdf' } as any;
      pdfImportServiceMock.previewPdf.mockResolvedValue({ batchId: 'batch1' });

      const req = { user: { username: 'admin' } };
      const res = await controller.previewPdf(file, req);

      expect(res.batchId).toBe('batch1');
      expect(pdfImportServiceMock.previewPdf).toHaveBeenCalledWith(file, 'admin');
    });
  });

  describe('commitPdfBatch', () => {
    it('调用 PdfImportService commit 方法', async () => {
      pdfImportServiceMock.commitPdfBatch.mockResolvedValue({
        message: '成功',
        batchId: 'b1',
      });

      const dto = { teams: [] } as any;
      const req = { user: { username: 'admin' } };
      const res = await controller.commitPdfBatch('b1', dto, req);

      expect(res.batchId).toBe('b1');
      expect(pdfImportServiceMock.commitPdfBatch).toHaveBeenCalledWith('b1', 'admin', dto);
    });
  });
});
