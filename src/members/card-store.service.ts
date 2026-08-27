import {
  Injectable,
  ServiceUnavailableException,
  UnprocessableEntityException,
} from '@nestjs/common';
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
} from '@aws-sdk/client-s3';
import sharp from 'sharp';
import { sharpLimiter } from '../common/concurrency-limiter';

@Injectable()
export class CardStoreService {
  private readonly client = new S3Client({
    region: 'auto',
    endpoint: process.env.CARD_R2_ENDPOINT,
    credentials: {
      accessKeyId: process.env.CARD_R2_ACCESS_KEY_ID || '',
      secretAccessKey: process.env.CARD_R2_SECRET_ACCESS_KEY || '',
    },
  });
  private bucket() {
    if (
      !process.env.CARD_R2_BUCKET_NAME ||
      !process.env.CARD_R2_ENDPOINT ||
      !process.env.CARD_R2_ACCESS_KEY_ID ||
      !process.env.CARD_R2_SECRET_ACCESS_KEY ||
      process.env.CARD_R2_BUCKET_NAME === process.env.R2_BUCKET_NAME ||
      process.env.CARD_STORAGE_PRIVATE_CONFIRMED !== 'true'
    ) {
      throw new ServiceUnavailableException('校园卡私有存储尚未配置，暂不能提交材料');
    }
    return process.env.CARD_R2_BUCKET_NAME;
  }
  async normalize(file?: Express.Multer.File) {
    this.bucket();
    if (!file?.buffer?.length || file.buffer.length > 3 * 1024 * 1024) {
      throw new UnprocessableEntityException('请上传不超过 3 MB 的校园卡照片');
    }
    return sharpLimiter.run(async () => {
      try {
        const input = sharp(file.buffer, { limitInputPixels: 20_000_000, animated: false }).timeout({
          seconds: 10,
        });
        const metadata = await input.metadata();
        if (!['jpeg', 'png', 'webp'].includes(metadata.format || '') || (metadata.pages || 1) > 1)
          throw new Error('format');
        return await input
          .rotate()
          .resize({ width: 1800, height: 1800, fit: 'inside', withoutEnlargement: true })
          .webp({ quality: 85 })
          .toBuffer();
      } catch {
        throw new UnprocessableEntityException(
          '图片无法解析，请使用清晰的 JPG、PNG 或 WebP 单张照片',
        );
      }
    });
  }
  async put(key: string, body: Buffer) {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket(),
        Key: key,
        Body: body,
        ContentType: 'image/webp',
        CacheControl: 'no-store',
      }),
    );
  }
  async read(key: string) {
    const result = await this.client.send(
      new GetObjectCommand({ Bucket: this.bucket(), Key: key }),
    );
    if (!result.Body || (result.ContentLength || 0) > 3 * 1024 * 1024)
      throw new ServiceUnavailableException('材料读取失败');
    return Buffer.from(await result.Body.transformToByteArray());
  }
  async remove(key: string) {
    const Bucket = this.bucket();
    await this.client.send(new DeleteObjectCommand({ Bucket, Key: key }));
    try {
      await this.client.send(new HeadObjectCommand({ Bucket, Key: key }));
    } catch (error: any) {
      if (error?.$metadata?.httpStatusCode === 404) return;
      throw error;
    }
    throw new Error('对象删除尚未确认');
  }
}
