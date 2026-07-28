import {
  BadRequestException,
  Body,
  Controller,
  Post,
  Req,
  UploadedFiles,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FilesInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiBody, ApiConsumes, ApiOperation, ApiTags } from '@nestjs/swagger';
import { memoryStorage } from 'multer';
import { ImportService } from './import.service';
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

@Controller('api/v1/import')
@ApiTags('数据导入')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('super_admin')
export class ImportController {
  constructor(private readonly importService: ImportService) {}

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
