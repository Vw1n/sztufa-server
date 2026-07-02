import { Injectable } from '@nestjs/common';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import sharp from 'sharp';

@Injectable()
export class UploadService {
  private s3Client = new S3Client({
    region: 'auto',
    endpoint: process.env.R2_ENDPOINT,
    credentials: {
      accessKeyId: process.env.R2_ACCESS_KEY_ID,
      secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
    },
  });

  async uploadImage(file: Express.Multer.File): Promise<string> {
    // 1. 使用 sharp 压缩并转换为 webp buffer
    const compressedBuffer = await sharp(file.buffer)
      .resize({ width: 1200, withoutEnlargement: true }) // 限制最大宽度，防止超大图
      .webp({ quality: 80 }) // 压缩率设为 80，质量与体积的最优解
      .toBuffer();

    const fileKey = `${Date.now()}-${Math.random().toString(36).substring(2, 8)}.webp`;

    // 2. 上传至 Cloudflare R2 存储桶
    await this.s3Client.send(new PutObjectCommand({
      Bucket: process.env.R2_BUCKET_NAME,
      Key: fileKey,
      Body: compressedBuffer,
      ContentType: 'image/webp',
    }));

    // 3. 返回公开的 CDN 访问链接
    return `${process.env.R2_PUBLIC_URL}/${fileKey}`;
  }
}
