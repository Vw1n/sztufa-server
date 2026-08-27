import sharp from 'sharp';
import { S3Client, DeleteObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
import { CardStoreService } from './card-store.service';

describe('校园卡私有存储', () => {
  const originalEnv = { ...process.env };
  beforeEach(() =>
    Object.assign(process.env, {
      CARD_R2_ENDPOINT: 'https://example.invalid',
      CARD_R2_BUCKET_NAME: 'private-card-test',
      R2_BUCKET_NAME: 'public-test',
      CARD_R2_ACCESS_KEY_ID: 'test-only',
      CARD_R2_SECRET_ACCESS_KEY: 'test-only',
      CARD_STORAGE_PRIVATE_CONFIRMED: 'true',
    }),
  );
  afterEach(() => {
    process.env = { ...originalEnv };
    jest.restoreAllMocks();
  });
  it('不能复用公开图片桶，未确认私密配置时拒绝上传', async () => {
    process.env.CARD_R2_BUCKET_NAME = 'public-test';
    await expect(new CardStoreService().normalize()).rejects.toThrow('私有存储尚未配置');
  });
  it('不信任 MIME，实际解码、去元数据并重编码为 WebP', async () => {
    const buffer = await sharp({
      create: { width: 40, height: 30, channels: 3, background: '#1478ab' },
    })
      .withMetadata()
      .png()
      .toBuffer();
    const output = await new CardStoreService().normalize({
      buffer,
      mimetype: 'text/plain',
    } as Express.Multer.File);
    const metadata = await sharp(output).metadata();
    expect(metadata.format).toBe('webp');
    expect(metadata.exif).toBeUndefined();
    await expect(
      new CardStoreService().normalize({
        buffer: Buffer.from('<svg/>'),
        mimetype: 'image/jpeg',
      } as Express.Multer.File),
    ).rejects.toThrow('图片无法解析');
  });
  it('删除后必须确认对象不存在，权限故障不能伪装成已删除', async () => {
    const send = jest.spyOn(S3Client.prototype, 'send') as jest.Mock;
    send.mockResolvedValueOnce({}).mockRejectedValueOnce({ $metadata: { httpStatusCode: 404 } });
    await new CardStoreService().remove('campus-cards/test.webp');
    expect(send.mock.calls[0][0]).toBeInstanceOf(DeleteObjectCommand);
    expect(send.mock.calls[1][0]).toBeInstanceOf(HeadObjectCommand);
    send.mockResolvedValueOnce({}).mockRejectedValueOnce({ $metadata: { httpStatusCode: 403 } });
    await expect(new CardStoreService().remove('campus-cards/test.webp')).rejects.toMatchObject({
      $metadata: { httpStatusCode: 403 },
    });
  });
});
