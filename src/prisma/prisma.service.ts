import { Injectable, OnModuleInit } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit {
  async onModuleInit() {
    let retries = 5;
    while (retries > 0) {
      try {
        await this.$connect();
        return;
      } catch (error: any) {
        retries -= 1;
        console.warn(
          `[PrismaService] 数据库连接失败，正在重试... (剩余 ${retries} 次尝试)。错误: ${error.message || String(error)}`,
        );
        if (retries === 0) throw error;
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }
    }
  }
}
