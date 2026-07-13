import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class AuditLogService {
  constructor(private readonly prisma: PrismaService) {}

  async log(username: string, action: string, details: string) {
    // 过滤掉我们不需要写入的核心非修改日志，比如 USER_LOGIN 不再写入
    if (action === 'USER_LOGIN') {
      return null;
    }
    return this.prisma.auditLog.create({
      data: {
        username,
        action,
        details,
      },
    });
  }

  private extractName(text: string): string {
    const match = text.match(/["'“‘]([^"'”’]+)["'”’]/);
    return match ? match[1] : '';
  }

  private mergeLogs(rawLogs: any[]): any[] {
    const merged: any[] = [];
    let currentGroup: any = null;

    for (const log of rawLogs) {
      const logTime = new Date(log.createdAt).getTime();
      const groupTime = currentGroup ? new Date(currentGroup.createdAt).getTime() : 0;
      
      // 合并条件：同一操作人、同一操作类型，且时间间隔在 5 分钟以内
      if (currentGroup && 
          currentGroup.username === log.username && 
          currentGroup.action === log.action &&
          Math.abs(groupTime - logTime) <= 5 * 60 * 1000) {
        currentGroup.items.push(log);
      } else {
        if (currentGroup) {
          merged.push(currentGroup);
        }
        currentGroup = {
          ...log,
          items: [log]
        };
      }
    }
    if (currentGroup) {
      merged.push(currentGroup);
    }

    return merged.map(group => {
      if (group.items.length === 1) {
        return {
          id: group.id,
          createdAt: group.createdAt,
          username: group.username,
          action: group.action,
          details: group.details
        };
      }

      // 提取被操作的名字（球队名、球员名、用户名等）并去重
      const names = group.items.map(item => this.extractName(item.details)).filter(Boolean);
      const uniqueNames = Array.from(new Set(names));
      const displayNames = uniqueNames.slice(0, 2).map(n => `"${n}"`).join('、');
      const suffix = uniqueNames.length > 2 ? '等' : '';
      const count = group.items.length;

      let details = group.details;
      switch (group.action) {
        case 'UPDATE_PLAYER':
          details = `批量修改球员 ${displayNames}${suffix} 等 ${count} 人的信息`;
          break;
        case 'CREATE_PLAYER':
          details = `批量新增球员 ${displayNames}${suffix} 等 ${count} 名球员`;
          break;
        case 'DELETE_PLAYER':
          details = `批量删除球员 ${displayNames}${suffix} 等 ${count} 名球员`;
          break;
        case 'UPDATE_MATCH':
          details = `批量修改比赛 ${displayNames}${suffix} 等 ${count} 场比赛的记录`;
          break;
        case 'CREATE_MATCH':
          details = `批量录入比赛 ${displayNames}${suffix} 等 ${count} 场比赛`;
          break;
        case 'DELETE_MATCH':
          details = `批量删除比赛 ${displayNames}${suffix} 等 ${count} 场比赛`;
          break;
        case 'UPDATE_TEAM':
          details = `批量修改球队 ${displayNames}${suffix} 等 ${count} 支球队的信息`;
          break;
        case 'CREATE_TEAM':
          details = `批量创建球队 ${displayNames}${suffix} 等 ${count} 支球队`;
          break;
        case 'DELETE_TEAM':
          details = `批量删除球队 ${displayNames}${suffix} 等 ${count} 支球队`;
          break;
        case 'UPDATE_USER_ROLE':
          details = `批量分配用户 ${displayNames}${suffix} 等 ${count} 人的权限`;
          break;
        default:
          details = `连续执行了 ${count} 次 ${group.action} 操作`;
      }

      return {
        id: group.id,
        createdAt: group.createdAt,
        username: group.username,
        action: group.action,
        details
      };
    });
  }

  async findAll(page: number = 1, limit: number = 20, username?: string, action?: string) {
    const pageNum = Math.max(1, Number(page) || 1);
    const limitNum = Math.max(1, Math.min(100, Number(limit) || 20));
    const skip = (pageNum - 1) * limitNum;

    // 默认不加载 USER_LOGIN 这种无修改操作的日志
    const where: any = {
      action: { not: 'USER_LOGIN' }
    };

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

    const [rawData, total] = await Promise.all([
      this.prisma.auditLog.findMany({
        where,
        skip,
        take: limitNum * 2, // 捞取双倍数据，为合并去重留出空间
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.auditLog.count({ where }),
    ]);

    const data = this.mergeLogs(rawData).slice(0, limitNum);

    return { data, total, page: pageNum, limit: limitNum };
  }
}
