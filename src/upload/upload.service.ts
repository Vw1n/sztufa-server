import {
  Injectable,
  Logger,
  ServiceUnavailableException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import sharp from 'sharp';

@Injectable()
export class UploadService {
  private readonly logger = new Logger(UploadService.name);
  private readonly s3Client: S3Client;

  constructor() {
    const requiredConfig = [
      'R2_ENDPOINT',
      'R2_ACCESS_KEY_ID',
      'R2_SECRET_ACCESS_KEY',
      'R2_BUCKET_NAME',
      'R2_PUBLIC_URL',
    ];
    const missingConfig = requiredConfig.filter((key) => !process.env[key]);
    if (missingConfig.length > 0) {
      this.logger.error(`R2 配置缺失: ${missingConfig.join(', ')}`);
    }

    this.s3Client = new S3Client({
      region: 'auto',
      endpoint: process.env.R2_ENDPOINT,
      credentials: {
        accessKeyId: process.env.R2_ACCESS_KEY_ID || '',
        secretAccessKey: process.env.R2_SECRET_ACCESS_KEY || '',
      },
    });
  }

  async uploadImage(file: Express.Multer.File): Promise<string> {
    // 1. 使用 sharp 压缩并转换为 webp buffer
    let compressedBuffer: Buffer;
    try {
      compressedBuffer = await sharp(file.buffer)
        .rotate()
        .resize({ width: 1200, withoutEnlargement: true })
        .webp({ quality: 80 })
        .toBuffer();
    } catch (error) {
      this.logger.error(
        `图片处理失败: name=${file.originalname}, type=${file.mimetype}, size=${file.size}`,
        error instanceof Error ? error.stack : String(error),
      );
      throw new UnprocessableEntityException('图片无法解析或格式不受支持，请更换图片后重试');
    }

    const fileKey = `${Date.now()}-${Math.random().toString(36).substring(2, 8)}.webp`;

    // 2. 上传至 Cloudflare R2 存储桶
    if (!process.env.R2_BUCKET_NAME || !process.env.R2_PUBLIC_URL) {
      throw new ServiceUnavailableException('图片存储服务配置不完整');
    }

    try {
      await this.s3Client.send(
        new PutObjectCommand({
          Bucket: process.env.R2_BUCKET_NAME,
          Key: fileKey,
          Body: compressedBuffer,
          ContentType: 'image/webp',
        }),
      );
    } catch (error) {
      this.logger.error(
        `R2 上传失败: key=${fileKey}, size=${compressedBuffer.length}`,
        error instanceof Error ? error.stack : String(error),
      );
      throw new ServiceUnavailableException('图片存储服务暂不可用，请稍后重试');
    }

    // 3. 返回公开的 CDN 访问链接
    return `${process.env.R2_PUBLIC_URL.replace(/\/$/, '')}/${fileKey}`;
  }
}
