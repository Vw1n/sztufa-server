import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Post,
  Req,
  UploadedFile,
  UploadedFiles,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor, FilesInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiBody, ApiConsumes, ApiOperation, ApiTags } from '@nestjs/swagger';
import { memoryStorage } from 'multer';
import { ImportService } from './import.service';
import { PdfImportService } from './pdf-import.service';
import {
  PdfCommitRequestDto,
  PdfPreviewUploadedRequestDto,
  PdfUploadUrlRequestDto,
} from './dto/pdf-import.dto';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';

const JSON_UPLOAD_OPTIONS = {
  storage: memoryStorage(),
  limits: {
    files: 10,
    fileSize: 2 * 1024 * 1024,
  },
};

const PDF_UPLOAD_OPTIONS = {
  storage: memoryStorage(),
  limits: {
    files: 1,
    fileSize: 20 * 1024 * 1024, // 20MB
  },
};

const MULTIPART_BODY_SCHEMA = {
  schema: {
    type: 'object',
    required: ['files'],
    properties: {
      files: {
        type: 'array',
        items: {
          type: 'string',
          format: 'binary',
        },
      },
      expectedDigest: {
        type: 'string',
        description: '预检返回的摘要；正式导入时用于确认文件未发生变化',
      },
    },
  },
};

const PDF_SINGLE_FILE_SCHEMA = {
  schema: {
    type: 'object',
    required: ['file'],
    properties: {
      file: {
        type: 'string',
        format: 'binary',
        description: '深圳技术大学“校长杯”等官方 PDF 足球赛报名表',
      },
    },
  },
};

@Controller('api/v1/import')
@ApiTags('数据导入')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('super_admin')
export class ImportController {
  constructor(
    private readonly importService: ImportService,
    private readonly pdfImportService: PdfImportService,
  ) {}

  @Post('json/preview')
  @ApiOperation({ summary: '预检历史 JSON 文件，不写入数据库' })
  @ApiConsumes('multipart/form-data')
  @ApiBody(MULTIPART_BODY_SCHEMA)
  @UseInterceptors(FilesInterceptor('files', 10, JSON_UPLOAD_OPTIONS))
  async previewJson(@UploadedFiles() files: Express.Multer.File[]) {
    this.validateFiles(files);
    return this.importService.previewFiles(files);
  }

  @Post('json')
  @ApiOperation({ summary: '将预检过的历史 JSON 文件事务性导入数据库' })
  @ApiConsumes('multipart/form-data')
  @ApiBody(MULTIPART_BODY_SCHEMA)
  @UseInterceptors(FilesInterceptor('files', 10, JSON_UPLOAD_OPTIONS))
  async importJson(
    @UploadedFiles() files: Express.Multer.File[],
    @Body('expectedDigest') expectedDigest: string,
    @Req() req: any,
  ) {
    this.validateFiles(files);
    if (!expectedDigest) {
      throw new BadRequestException('请先预检文件，并提交预检返回的摘要');
    }

    const result = await this.importService.importFiles(
      files,
      req.user?.username || 'admin',
      expectedDigest,
    );
    return {
      message: '历史 JSON 导入完成',
      result,
    };
  }

  @Get('json/last')
  @ApiOperation({ summary: '查询最近一次可撤销的历史 JSON 导入' })
  async getLastJsonImport() {
    return this.importService.getLastImport();
  }

  @Post('json/undo')
  @ApiOperation({ summary: '撤销最近一次历史 JSON 导入' })
  async undoLastJsonImport(@Req() req: any) {
    const result = await this.importService.undoLastImport(req.user?.username || 'admin');
    return {
      message: '已撤销上一次历史 JSON 导入',
      result,
    };
  }

  // ==================== PDF 报名表导入两阶段 API ====================

  @Post('pdf/upload-url')
  @ApiOperation({ summary: '获取 PDF 直传 R2/S3 的预签名地址（绕过 Serverless 请求体限制）' })
  async createPdfUploadUrl(@Body() dto: PdfUploadUrlRequestDto, @Req() req: any) {
    return this.pdfImportService.createPdfUploadUrl(req.user?.username || 'admin', dto);
  }

  @Post('pdf/preview-uploaded')
  @ApiOperation({ summary: '解析已经通过预签名地址直传至 R2/S3 的 PDF' })
  async previewUploadedPdf(@Body() dto: PdfPreviewUploadedRequestDto, @Req() req: any) {
    return this.pdfImportService.previewUploadedPdf(dto, req.user?.username || 'admin');
  }

  @Post('pdf/preview')
  @ApiOperation({ summary: '预检与智能解析官方 PDF 报名表（生成置信度及临时大头照）' })
  @ApiConsumes('multipart/form-data')
  @ApiBody(PDF_SINGLE_FILE_SCHEMA)
  @UseInterceptors(FileInterceptor('file', PDF_UPLOAD_OPTIONS))
  async previewPdf(@UploadedFile() file: Express.Multer.File, @Req() req: any) {
    if (!file) {
      throw new BadRequestException('请上传 PDF 格式的报名表文件');
    }
    if (!file.originalname.toLowerCase().endsWith('.pdf')) {
      throw new BadRequestException('只支持上传 .pdf 格式的足球赛报名表');
    }
    return this.pdfImportService.previewPdf(file, req.user?.username || 'admin');
  }

  @Post('pdf/:batchId/commit')
  @ApiOperation({ summary: '提交由管理员二次确认后的 PDF 导入批次（事务写入数据库）' })
  async commitPdfBatch(
    @Param('batchId') batchId: string,
    @Body() dto: PdfCommitRequestDto,
    @Req() req: any,
  ) {
    return this.pdfImportService.commitPdfBatch(batchId, req.user?.username || 'admin', dto);
  }

  @Post('pdf/:batchId/photo')
  @ApiOperation({ summary: '为特定 PDF 导入批次单独替换上传临时大头照' })
  @ApiConsumes('multipart/form-data')
  @UseInterceptors(FileInterceptor('file', JSON_UPLOAD_OPTIONS))
  async uploadBatchTempPhoto(
    @Param('batchId') batchId: string,
    @UploadedFile() file: Express.Multer.File,
    @Req() req: any,
  ) {
    if (!file) {
      throw new BadRequestException('请选择图片文件');
    }
    return this.pdfImportService.uploadBatchTempPhoto(batchId, req.user?.username || 'admin', file);
  }

  @Post('pdf/:batchId/cancel')
  @ApiOperation({ summary: '主动取消 PDF 导入批次（物理清理临时大头照）' })
  async cancelPdfBatch(@Param('batchId') batchId: string, @Req() req: any) {
    return this.pdfImportService.cancelPdfBatch(batchId, req.user?.username || 'admin');
  }

  @Post('pdf/recovery')
  @ApiOperation({ summary: '受保护的维护触发接口：清理与恢复僵死的 PDF 导入批次' })
  async recoverStuckPdfBatches() {
    return this.pdfImportService.recoverStuckBatches();
  }

  private validateFiles(files: Express.Multer.File[] | undefined) {
    if (!files?.length) {
      throw new BadRequestException('请选择至少一个 JSON 文件');
    }

    const invalidFile = files.find((file) => !file.originalname.toLowerCase().endsWith('.json'));
    if (invalidFile) {
      throw new BadRequestException(`只支持 JSON 文件：${invalidFile.originalname}`);
    }
  }
}
