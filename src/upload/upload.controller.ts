import {
  Controller,
  Post,
  UseInterceptors,
  UploadedFile,
  UseGuards,
  BadRequestException,
  Body,
  Request,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import multer from 'multer';
import { ApiTags, ApiOperation, ApiConsumes, ApiBody, ApiBearerAuth } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { UploadService } from './upload.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';

@ApiTags('图片上传')
@Controller('api/v1/upload')
export class UploadController {
  constructor(private readonly uploadService: UploadService) {}

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @Post()
  @Throttle({ default: { limit: 120, ttl: 60000 } })
  @ApiOperation({ summary: '上传图片并压缩为 WebP 格式' })
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        file: {
          type: 'string',
          format: 'binary',
        },
      },
    },
  })
  @UseInterceptors(
    FileInterceptor('file', {
      storage: multer.memoryStorage(),
      limits: {
        fileSize: 5 * 1024 * 1024, // 限制文件大小最大为 5MB
      },
    }),
  )
  async uploadFile(@UploadedFile() file: Express.Multer.File, @Request() req: any) {
    if (!file) {
      throw new BadRequestException('请选择要上传的文件');
    }

    // 校验文件类型是否为图片
    if (!file.mimetype.startsWith('image/')) {
      throw new BadRequestException('只能上传图片文件');
    }

    const username = req.user?.username || 'anonymous';
    const url = await this.uploadService.uploadImage(file, username);
    return {
      statusCode: 201,
      message: '图片上传成功',
      data: { url },
    };
  }

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @Post('cleanup-temp')
  async cleanupTemp(@Body('keys') keys: string[], @Request() req: any) {
    const username = req.user?.username || 'admin';
    return this.uploadService.cleanupTempKeys(keys || [], username);
  }
}
