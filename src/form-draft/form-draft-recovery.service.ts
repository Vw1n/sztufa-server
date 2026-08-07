import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class FormDraftRecoveryService implements OnModuleInit {
  private readonly logger = new Logger(FormDraftRecoveryService.name);

  constructor(private readonly prisma: PrismaService) {}

  async onModuleInit() {
    await this.recoverStaleMaterializingDrafts();
  }

  async recoverStaleMaterializingDrafts() {
    const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000);
    try {
      const result = await this.prisma.adminFormDraft.updateMany({
        where: {
          status: 'MATERIALIZING',
          updatedAt: { lt: fiveMinutesAgo },
        },
        data: {
          status: 'DRAFT',
          lastError: '卡在正式化处理中超时，服务启动时已自动重置为草稿',
        },
      });

      if (result.count > 0) {
        this.logger.warn(`已自动恢复 ${result.count} 个超时卡住的 MATERIALIZING 草稿至 DRAFT 状态`);
      }
    } catch (err) {
      this.logger.error('清理超时卡死草稿失败:', err);
    }
  }
}
