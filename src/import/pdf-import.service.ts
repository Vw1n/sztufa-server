import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import crypto from 'crypto';
import sharp from 'sharp';
import { Prisma, PdfImportBatchStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { UploadService } from '../upload/upload.service';
import { PdfParserService } from './pdf-parser.service';
import {
  ParsedFieldDto,
  PdfCommitRequestDto,
  PdfCommitResponseDto,
  PdfPreviewUploadedRequestDto,
  PdfPreviewResponseDto,
  PdfUploadUrlRequestDto,
  PdfUploadUrlResponseDto,
} from './dto/pdf-import.dto';

const PDF_PREVIEW_CACHE_VERSION = '2026-07-29-images-v2';

@Injectable()
export class PdfImportService {
  private readonly logger = new Logger(PdfImportService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly uploadService: UploadService,
    private readonly pdfParserService: PdfParserService,
  ) {}

  async createPdfUploadUrl(
    username: string,
    dto: PdfUploadUrlRequestDto,
  ): Promise<PdfUploadUrlResponseDto> {
    if (!dto.fileName.toLowerCase().endsWith('.pdf')) {
      throw new BadRequestException('只支持上传 .pdf 格式的报名表');
    }
    if (!['application/pdf', 'application/octet-stream'].includes(dto.mimeType)) {
      throw new BadRequestException('PDF 文件 MIME 类型不正确');
    }

    const ownerScope = this.getPdfSourceOwnerScope(username);
    const objectKey = `temp/pdf-source/${ownerScope}/${crypto.randomUUID()}.pdf`;
    const uploadUrl = await this.uploadService.createPresignedUploadUrl(
      objectKey,
      'application/pdf',
    );

    return {
      uploadUrl,
      objectKey,
      expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
    };
  }

  async previewUploadedPdf(
    dto: PdfPreviewUploadedRequestDto,
    username: string,
  ): Promise<PdfPreviewResponseDto> {
    const expectedPrefix = `temp/pdf-source/${this.getPdfSourceOwnerScope(username)}/`;
    if (
      !dto.objectKey.startsWith(expectedPrefix) ||
      dto.objectKey.slice(expectedPrefix.length).includes('/') ||
      !dto.objectKey.endsWith('.pdf')
    ) {
      throw new BadRequestException('PDF 临时对象路径非法或不属于当前用户');
    }
    if (!dto.fileName.toLowerCase().endsWith('.pdf')) {
      throw new BadRequestException('只支持解析 .pdf 格式的报名表');
    }

    try {
      const buffer = await this.uploadService.getObjectBuffer(dto.objectKey, 20 * 1024 * 1024);
      if (buffer.length === 0 || buffer.length > 20 * 1024 * 1024) {
        throw new BadRequestException('PDF 文件为空或超过 20MB 限制');
      }
      if (buffer.length !== dto.fileSize) {
        throw new BadRequestException('PDF 上传不完整，请重新选择文件上传');
      }

      const file = {
        fieldname: 'file',
        originalname: dto.fileName,
        encoding: '7bit',
        mimetype: 'application/pdf',
        size: buffer.length,
        buffer,
      } as Express.Multer.File;

      return await this.previewPdf(file, username);
    } finally {
      await this.uploadService.deleteObject(dto.objectKey);
    }
  }

  async previewPdf(file: Express.Multer.File, username: string): Promise<PdfPreviewResponseDto> {
    this.lazyCleanupExpiredBatches(username).catch((err) =>
      this.logger.warn('惰性清理过期批次异常', err),
    );

    const fileHash = crypto
      .createHash('sha256')
      .update(PDF_PREVIEW_CACHE_VERSION)
      .update(file.buffer)
      .digest('hex');

    const recentSameBatch = await this.prisma.pdfImportBatch.findFirst({
      where: {
        username,
        fileHash,
        status: PdfImportBatchStatus.PREVIEW,
        expiresAt: { gt: new Date() },
      },
    });

    if (recentSameBatch && recentSameBatch.previewData) {
      const previewData = recentSameBatch.previewData as any;
      return {
        batchId: recentSameBatch.id,
        fileHash: recentSameBatch.fileHash,
        expiresAt: recentSameBatch.expiresAt.toISOString(),
        teams: previewData.teams || [],
        hasLowConfidence: previewData.hasLowConfidence || false,
      };
    }

    const { teams, extractedImages } = await this.pdfParserService.parseRegistrationPdf(file);

    const batchId = `pdf_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
    const tempPrefix = `temp/pdf/${batchId}/`;

    const uploadedImageMap = new Map<string, string>();

    try {
      const uploadedImages = await Promise.all(
        extractedImages.map(async (img) => {
          const tempKey = `${tempPrefix}${img.id}.webp`;
          const publicUrl = await this.uploadService.uploadBuffer(
            img.buffer,
            tempKey,
            'image/webp',
          );
          return [img.id, publicUrl] as const;
        }),
      );
      for (const [imageId, publicUrl] of uploadedImages) {
        uploadedImageMap.set(imageId, publicUrl);
      }

      let hasLowConfidence = false;
      for (const team of teams) {
        for (const field of [team.logo, team.homeJerseyPhoto, team.awayJerseyPhoto]) {
          if (field?.value && uploadedImageMap.has(field.value)) {
            field.value = uploadedImageMap.get(field.value)!;
          }
        }
        for (const player of team.players) {
          if (player.photo.value && uploadedImageMap.has(player.photo.value)) {
            player.photo.value = uploadedImageMap.get(player.photo.value)!;
          }
          if (player.needsManualConfirm || player.photo.confidence < 0.8) {
            hasLowConfidence = true;
          }
        }
      }

      const expiresAt = new Date(Date.now() + 30 * 60 * 1000);

      await this.prisma.pdfImportBatch.create({
        data: {
          id: batchId,
          fileHash,
          username,
          status: PdfImportBatchStatus.PREVIEW,
          previewData: JSON.parse(
            JSON.stringify({ teams, hasLowConfidence }),
          ) as Prisma.InputJsonValue,
          expiresAt,
        },
      });

      return {
        batchId,
        fileHash,
        expiresAt: expiresAt.toISOString(),
        teams,
        hasLowConfidence,
      };
    } catch (error) {
      this.logger.error(`Preview 批次创建失败，启动 S3 物理回滚补偿: prefix=${tempPrefix}`, error);
      await this.uploadService.deleteByPrefix(tempPrefix).catch(() => {});
      throw error;
    }
  }

  async uploadBatchTempPhoto(
    batchId: string,
    username: string,
    file: Express.Multer.File,
  ): Promise<{ url: string }> {
    const batch = await this.prisma.pdfImportBatch.findUnique({
      where: { id: batchId },
    });
    if (!batch || batch.username !== username || batch.status !== PdfImportBatchStatus.PREVIEW) {
      throw new BadRequestException('批次不存在、已失效或无权上传照片');
    }

    if (!file || !file.buffer) {
      throw new BadRequestException('请提供有效的图片文件');
    }

    // 强校验与解密转码：通过 sharp 解码转码 WebP 约束大小 ≤ 200KB，防文件伪造
    let webpBuffer: Buffer;
    try {
      let quality = 80;
      let width = 400;
      let height = 533;

      webpBuffer = await sharp(file.buffer)
        .rotate()
        .resize({ width, height, fit: 'cover', withoutEnlargement: true })
        .webp({ quality })
        .toBuffer();

      while (webpBuffer.length > 200 * 1024 && quality >= 20) {
        quality -= 15;
        width = Math.round(width * 0.85);
        height = Math.round(height * 0.85);
        webpBuffer = await sharp(file.buffer)
          .rotate()
          .resize({ width, height, fit: 'cover' })
          .webp({ quality })
          .toBuffer();
      }

      if (webpBuffer.length > 200 * 1024) {
        throw new UnprocessableEntityException(
          '大头照图片压缩后仍超过 200KB 体积限制，请提供较小分辨率的图片',
        );
      }
    } catch (err: any) {
      if (err instanceof UnprocessableEntityException) throw err;
      this.logger.error('手动更换照片 Sharp 解码转码失败', err);
      throw new UnprocessableEntityException(
        '更换的大头照图片损坏或格式不支持，请上传有效的图片文件',
      );
    }

    const tempKey = `temp/pdf/${batchId}/manual_${Date.now()}_${Math.random().toString(36).substring(2, 6)}.webp`;
    const publicUrl = await this.uploadService.uploadBuffer(webpBuffer, tempKey, 'image/webp');
    return { url: publicUrl };
  }

  async getBatchTempAsset(batchId: string, username: string, url: string): Promise<Buffer> {
    const batch = await this.prisma.pdfImportBatch.findFirst({
      where: {
        id: batchId,
        username,
        status: PdfImportBatchStatus.PREVIEW,
        expiresAt: { gt: new Date() },
      },
      select: { id: true },
    });
    if (!batch) {
      throw new NotFoundException('PDF 预览批次不存在、已过期或无权访问');
    }

    const key = this.uploadService.extractKeyFromUrl(url);
    const expectedPrefix = `temp/pdf/${batchId}/`;
    if (
      !key.startsWith(expectedPrefix) ||
      key.slice(expectedPrefix.length).includes('/') ||
      !key.endsWith('.webp')
    ) {
      throw new BadRequestException('图片不属于当前 PDF 预览批次');
    }

    return this.uploadService.getObjectBuffer(key, 200 * 1024);
  }

  async commitPdfBatch(
    batchId: string,
    username: string,
    dto: PdfCommitRequestDto,
  ): Promise<PdfCommitResponseDto> {
    const teams = dto.teams || [];
    if (!dto.seasonId) {
      throw new BadRequestException('提交 PDF 报名数据必须指定赛季');
    }
    const seasonId = dto.seasonId;
    const targetSeason = await this.prisma.season.findUnique({ where: { id: seasonId } });
    if (!targetSeason) {
      throw new BadRequestException('所选赛季不存在');
    }
    if (teams.length === 0) {
      throw new BadRequestException('提交的球队数据不能为空');
    }

    const user = this.prisma?.user
      ? await this.prisma.user.findUnique({ where: { username }, select: { role: true } })
      : null;
    const isSuperAdmin = user?.role === 'super_admin';

    const tempPrefix = `temp/pdf/${batchId}/`;

    for (const team of teams) {
      this.validateFieldConfidence(team.teamName, '球队名称', isSuperAdmin);
      this.validateFieldConfidence(team.headCoach, '主教练姓名', isSuperAdmin);
      this.validateFieldConfidence(team.coachPhone, '教练电话', isSuperAdmin);
      this.validateFieldConfidence(team.teamLeader, '领队姓名', isSuperAdmin);
      this.validateFieldConfidence(team.leaderPhone, '领队电话', isSuperAdmin);
      this.validateFieldConfidence(team.homeJerseyColor, '主队球衣颜色', isSuperAdmin);
      this.validateFieldConfidence(team.awayJerseyColor, '客队球衣颜色', isSuperAdmin);

      for (const player of team.players) {
        this.validateFieldConfidence(player.name, `球员姓名 (${player.name?.value || '未知'})`, isSuperAdmin);
        this.validateFieldConfidence(
          player.studentId,
          `学号 (${player.studentId?.value || '未知'})`,
          isSuperAdmin,
        );
        this.validateFieldConfidence(
          player.jerseyNumber,
          `球衣号码 (${player.name?.value || '未知'})`,
          isSuperAdmin,
        );
        this.validateFieldConfidence(player.photo, `照片 (${player.name?.value || '未知'})`, isSuperAdmin);

        const photoUrl = player.photo.value;
        if (photoUrl) {
          const key = this.uploadService.extractKeyFromUrl(photoUrl);
          if (!key.startsWith(tempPrefix)) {
            throw new BadRequestException(
              `球员 "${player.name.value || '未知'}" 的照片路径非法，超越了当前批次 (${tempPrefix}) 范围`,
            );
          }
        }
      }
    }

    const claimed = await this.prisma.pdfImportBatch.updateMany({
      where: {
        id: batchId,
        username,
        status: PdfImportBatchStatus.PREVIEW,
        expiresAt: { gt: new Date() },
      },
      data: {
        status: PdfImportBatchStatus.COMMITTING,
        commitStartedAt: new Date(),
      },
    });

    if (claimed.count !== 1) {
      throw new ConflictException('该批次已提交、已过期、正在处理中或无权操作');
    }

    const formalPrefix = `uploads/players/imports/${batchId}/`;

    try {
      for (const team of teams) {
        for (const field of [team.logo, team.homeJerseyPhoto, team.awayJerseyPhoto]) {
          if (field?.value) {
            const sourceKey = this.uploadService.extractKeyFromUrl(field.value);
            const fileName = sourceKey.substring(sourceKey.lastIndexOf('/') + 1);
            const formalKey = `${formalPrefix}${fileName}`;
            field.value = await this.uploadService.copyObject(sourceKey, formalKey);
          }
        }
        for (const player of team.players) {
          const photoUrl = player.photo.value;
          if (photoUrl) {
            const sourceKey = this.uploadService.extractKeyFromUrl(photoUrl);
            const fileName = sourceKey.substring(sourceKey.lastIndexOf('/') + 1);
            const formalKey = `${formalPrefix}${fileName}`;

            const formalUrl = await this.uploadService.copyObject(sourceKey, formalKey);
            player.photo.value = formalUrl;
          }
        }
      }

      let createdTeamsCount = 0;
      let createdPlayersCount = 0;

      await this.prisma.$transaction(async (tx) => {
        for (const teamDto of teams) {
          const teamName = teamDto.teamName.value?.trim() || '未命名球队';

          const team = await tx.team.create({
            data: {
              teamName,
              headCoach: teamDto.headCoach.value || null,
              coachPhone: teamDto.coachPhone.value || null,
              teamLeader: teamDto.teamLeader.value || null,
              leaderPhone: teamDto.leaderPhone.value || null,
              teamDoctor: teamDto.teamDoctor.value || null,
              homeJerseyColor: teamDto.homeJerseyColor.value || '白色',
              awayJerseyColor: teamDto.awayJerseyColor.value || '黑色',
              teamLogo: teamDto.logo?.value || null,
              homeJersey: teamDto.homeJerseyPhoto?.value || null,
              awayJersey: teamDto.awayJerseyPhoto?.value || null,
            },
          });
          createdTeamsCount++;

          await tx.seasonTeamProfile.create({
            data: {
              seasonId,
              teamId: team.id,
              teamName,
              headCoach: teamDto.headCoach.value || null,
              coachPhone: teamDto.coachPhone.value || null,
              teamLeader: teamDto.teamLeader.value || null,
              leaderPhone: teamDto.leaderPhone.value || null,
              teamDoctor: teamDto.teamDoctor.value || null,
              homeJerseyColor: teamDto.homeJerseyColor.value || '白色',
              awayJerseyColor: teamDto.awayJerseyColor.value || '黑色',
              teamLogo: teamDto.logo?.value || null,
              homeJersey: teamDto.homeJerseyPhoto?.value || null,
              awayJersey: teamDto.awayJerseyPhoto?.value || null,
              gender: targetSeason.name.includes('女') ? 'FEMALE' : 'MALE',
              isRegistered: true,
            },
          });

          for (const pDto of teamDto.players) {
            const studentId = pDto.studentId.value?.trim() || `PDF_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
            const name = pDto.name.value?.trim() || '未命名球员';
            const jerseyNumber = pDto.jerseyNumber.value?.trim() || '0';
            const photo = pDto.photo.value || null;

            const createdPlayer = await tx.player.create({
              data: {
                name,
                studentId,
                jerseyNumber,
                photo,
                teamId: team.id,
              },
            });

            await tx.seasonTeamPlayer.create({
              data: {
                seasonId,
                teamId: team.id,
                playerId: createdPlayer.id,
                playerName: name,
                studentId,
                jerseyNumber,
                playerPhoto: photo,
              },
            });
            createdPlayersCount++;
          }
        }

        await tx.pdfImportBatch.update({
          where: { id: batchId },
          data: {
            status: PdfImportBatchStatus.COMMITTED,
            committedAt: new Date(),
            previewData: Prisma.DbNull,
          },
        });
      });

      this.uploadService
        .deleteByPrefix(tempPrefix)
        .catch((err) => this.logger.warn(`清理临时文件失败 prefix=${tempPrefix}`, err));

      return {
        message: `成功完成 PDF 报名表提交，处理 ${createdTeamsCount} 支球队，${createdPlayersCount} 名球员`,
        batchId,
        createdTeamsCount,
        createdPlayersCount,
      };
    } catch (error: any) {
      this.logger.error(
        `PDF Commit 事务失败，启动物理清除补偿: formalPrefix=${formalPrefix}`,
        error,
      );

      let cleanupSuccess = false;
      try {
        await this.uploadService.deleteByPrefix(formalPrefix);
        cleanupSuccess = true;
      } catch (cleanErr) {
        this.logger.error(
          `S3 正式目录清理失败，标记 cleanupRequired=true 留待后续任务重试: formalPrefix=${formalPrefix}`,
          cleanErr,
        );
      }

      await this.prisma.pdfImportBatch
        .update({
          where: { id: batchId },
          data: {
            status: PdfImportBatchStatus.FAILED,
            failedAt: new Date(),
            failureReason: error?.message || String(error),
            cleanupRequired: !cleanupSuccess,
            previewData: Prisma.DbNull,
          },
        })
        .catch(() => {});

      throw new BadRequestException(`PDF 批次提交失败: ${error?.message || String(error)}`);
    }
  }

  async cancelPdfBatch(
    batchId: string,
    username: string,
  ): Promise<{ message: string; batchId: string }> {
    const batch = await this.prisma.pdfImportBatch.findUnique({
      where: { id: batchId },
    });

    if (!batch || batch.username !== username) {
      throw new NotFoundException('批次不存在或无权取消');
    }

    if (batch.status === PdfImportBatchStatus.PREVIEW) {
      const tempPrefix = `temp/pdf/${batchId}/`;
      await this.uploadService.deleteByPrefix(tempPrefix).catch((err) => {
        this.logger.warn(`取消批次时 S3 物理清理暂未完全成功 prefix=${tempPrefix}`, err);
      });

      await this.prisma.pdfImportBatch.update({
        where: { id: batchId },
        data: {
          status: PdfImportBatchStatus.CANCELLED,
          previewData: Prisma.DbNull,
        },
      });
    }

    return { message: '已成功取消 PDF 导入批次并清理临时文件', batchId };
  }

  async recoverStuckBatches(): Promise<{ message: string; recoveredBatchesCount: number }> {
    const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000);

    // 查出符合恢复条件的批次：停留在 COMMITTING > 10min 或 cleanupRequired 为 true 的异常批次
    const stuckBatches = await this.prisma.pdfImportBatch.findMany({
      where: {
        OR: [
          {
            status: PdfImportBatchStatus.COMMITTING,
            commitStartedAt: { lt: tenMinutesAgo },
          },
          {
            cleanupRequired: true,
          },
        ],
      },
    });

    let recoveredBatchesCount = 0;

    for (const batch of stuckBatches) {
      const formalPrefix = `uploads/players/imports/${batch.id}/`;
      this.logger.warn(
        `维护任务扫描到未完成清理的批次 ${batch.id}，执行 S3 物理删除: ${formalPrefix}`,
      );

      let cleanOk = false;
      try {
        await this.uploadService.deleteByPrefix(formalPrefix);
        cleanOk = true;
      } catch (cleanErr) {
        this.logger.error(
          `S3 清理失败，保持 cleanupRequired=true 以供下次轮询重试: batchId=${batch.id}`,
          cleanErr,
        );
      }

      await this.prisma.pdfImportBatch.update({
        where: { id: batch.id },
        data: {
          status: PdfImportBatchStatus.FAILED,
          failedAt: new Date(),
          failureReason: 'S3 物理补偿与僵死恢复处理',
          cleanupRequired: !cleanOk,
          previewData: Prisma.DbNull,
        },
      });

      if (cleanOk) {
        recoveredBatchesCount++;
      }
    }

    return {
      message: `恢复维护完成，彻底完成 S3 物理清理的批次数量: ${recoveredBatchesCount}`,
      recoveredBatchesCount,
    };
  }

  private validateFieldConfidence(
    field: ParsedFieldDto<any> | undefined,
    fieldName: string,
    isSuperAdmin = false,
  ) {
    if (!field || isSuperAdmin) return;
    if (field.confidence < 0.8 && !field.manuallyConfirmed) {
      throw new BadRequestException(
        `字段 "${fieldName}" 的匹配置信度较低 (${field.confidence})，请人工核对并勾选确认后提交`,
      );
    }
  }

  private getPdfSourceOwnerScope(username: string): string {
    return crypto.createHash('sha256').update(username).digest('hex').slice(0, 20);
  }

  private async lazyCleanupExpiredBatches(username: string): Promise<void> {
    const expiredBatches = await this.prisma.pdfImportBatch.findMany({
      where: {
        username,
        status: PdfImportBatchStatus.PREVIEW,
        expiresAt: { lt: new Date() },
      },
      take: 5,
    });

    for (const b of expiredBatches) {
      const tempPrefix = `temp/pdf/${b.id}/`;
      await this.uploadService.deleteByPrefix(tempPrefix).catch(() => {});
      await this.prisma.pdfImportBatch.update({
        where: { id: b.id },
        data: {
          status: PdfImportBatchStatus.EXPIRED,
          previewData: Prisma.DbNull,
        },
      });
    }
  }
}
