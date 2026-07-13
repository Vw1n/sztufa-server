import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class AuditLogService {
  constructor(private readonly prisma: PrismaService) {}

  async log(username: string, action: string, details: string) {
    return this.prisma.auditLog.create({
      data: {
        username,
        action,
        details,
      },
    });
  }

  async findAll(page: number = 1, limit: number = 20, username?: string, action?: string) {
    const pageNum = Math.max(1, Number(page) || 1);
    const limitNum = Math.max(1, Math.min(100, Number(limit) || 20));
    const skip = (pageNum - 1) * limitNum;

    const where: any = {};
    if (username && username.trim() !== '') {
      where.username = { contains: username.trim() };
    }
    if (action && action !== 'all') {
      if (action === 'MATCH_ACTIONS') {
        where.action = { in: ['CREATE_MATCH', 'UPDATE_MATCH', 'DELETE_MATCH'] };
      } else if (action === 'PLAYER_ACTIONS') {
        where.action = { in: ['CREATE_PLAYER', 'UPDATE_PLAYER', 'DELETE_PLAYER'] };
      } else if (action === 'TEAM_ACTIONS') {
        where.action = { in: ['CREATE_TEAM', 'UPDATE_TEAM', 'DELETE_TEAM'] };
      } else if (action === 'USER_ACTIONS') {
        where.action = { in: ['USER_REGISTER', 'UPDATE_USER_ROLE', 'DELETE_USER', 'RESET_USER_PASSWORD'] };
      } else if (action === 'BACKUP_ACTIONS') {
        where.action = { in: ['CREATE_BACKUP', 'RESTORE_BACKUP'] };
      } else {
        where.action = action;
      }
    }

    const [data, total] = await Promise.all([
      this.prisma.auditLog.findMany({
        where,
        skip,
        take: limitNum,
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.auditLog.count({ where }),
    ]);

    return { data, total, page: pageNum, limit: limitNum };
  }
}
