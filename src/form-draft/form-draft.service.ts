import { Injectable, Logger, NotFoundException, ForbiddenException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { SaveFormDraftDto } from './dto/save-form-draft.dto';
import { normalizeTeamPayload } from '../team/team-write-normalizer';
import { normalizeMatchPayload } from '../match/match-write-normalizer';
import { TeamService } from '../team/team.service';
import { MatchService } from '../match/match.service';
import { UploadService } from '../upload/upload.service';

@Injectable()
export class FormDraftService {
  private readonly logger = new Logger(FormDraftService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly teamService: TeamService,
    private readonly matchService: MatchService,
    private readonly uploadService: UploadService,
  ) {}

  async saveDraft(dto: SaveFormDraftDto, username: string, draftId?: string) {
    if (draftId) {
      const existing = await this.prisma.adminFormDraft.findUnique({
        where: { id: draftId },
      });
      if (!existing) {
        throw new NotFoundException('找不到要更新的草稿');
      }

      const updated = await this.prisma.adminFormDraft.update({
        where: { id: draftId },
        data: {
          formType: dto.formType || existing.formType,
          payload: dto.payload || existing.payload,
          seasonId: dto.seasonId ?? existing.seasonId,
          officialRecordId: dto.officialRecordId ?? existing.officialRecordId,
          // 保证草稿所有者 username 不可变
        },
      });

      return {
        draftId: updated.id,
        saveStatus: updated.status,
        officialRecordId: updated.officialRecordId,
        draft: updated,
      };
    } else {
      const created = await this.prisma.adminFormDraft.create({
        data: {
          formType: dto.formType,
          payload: dto.payload || {},
          seasonId: dto.seasonId || null,
          officialRecordId: dto.officialRecordId || null,
          status: 'DRAFT',
          username,
        },
      });

      return {
        draftId: created.id,
        saveStatus: created.status,
        officialRecordId: created.officialRecordId,
        draft: created,
      };
    }
  }

  async getDraft(id: string) {
    const draft = await this.prisma.adminFormDraft.findUnique({
      where: { id },
    });
    if (!draft) {
      throw new NotFoundException('草稿不存在');
    }
    return draft;
  }

  async listDrafts(formType?: string) {
    const where: any = {};
    if (formType) {
      where.formType = formType;
    }
    return this.prisma.adminFormDraft.findMany({
      where,
      orderBy: { updatedAt: 'desc' },
    });
  }

  async deleteDraft(id: string, username: string = 'admin', userCtx?: any) {
    const draft = await this.prisma.adminFormDraft.findUnique({
      where: { id },
    });
    if (!draft) {
      throw new NotFoundException('草稿不存在');
    }

    if (userCtx && userCtx.role !== 'super_admin' && draft.username !== username) {
      throw new ForbiddenException('您没有权限删除此草稿');
    }

    // 安全清理草稿引用的对象存储图片 (校验草稿所有者归属并排除当前草稿的交叉校验)
    await this.cleanupUnreferencedDraftImages(draft.payload, draft.username || username, draft.id);

    await this.prisma.adminFormDraft.delete({
      where: { id },
    });

    return { success: true };
  }

  private async cleanupUnreferencedDraftImages(
    payload: any,
    ownerUsername: string,
    currentDraftId: string,
  ) {
    if (!payload || typeof payload !== 'object') return;

    const urlsOrKeys: string[] = [];
    if (payload.teamLogo) urlsOrKeys.push(payload.teamLogo);
    if (payload.homeJersey) urlsOrKeys.push(payload.homeJersey);
    if (payload.awayJersey) urlsOrKeys.push(payload.awayJersey);

    if (Array.isArray(payload.players)) {
      for (const p of payload.players) {
        if (p.photo) urlsOrKeys.push(p.photo);
      }
    }

    await this.uploadService.cleanupTempKeys(urlsOrKeys, ownerUsername, {
      excludedDraftId: currentDraftId,
    });
  }

  async tryMaterialize(
    draftId: string,
    username: string,
  ): Promise<{ success: boolean; officialRecordId?: string; error?: string }> {
    // 1. 原子 CAS 抢占状态为 MATERIALIZING
    const casResult = await this.prisma.adminFormDraft.updateMany({
      where: { id: draftId, status: { in: ['DRAFT', 'FAILED'] } },
      data: { status: 'MATERIALIZING' },
    });

    if (casResult.count === 0) {
      return { success: false, error: '草稿正在处理中或已生成正式记录，请勿重复提交' };
    }

    const draft = await this.prisma.adminFormDraft.findUnique({
      where: { id: draftId },
    });
    if (!draft) {
      return { success: false, error: '草稿不存在' };
    }

    try {
      if (draft.formType === 'TEAM') {
        const normalized = normalizeTeamPayload(draft.payload);
        const hasTeamContent =
          !!normalized.teamName?.trim() ||
          !!normalized.teamLogo ||
          !!normalized.homeJersey ||
          !!normalized.awayJersey ||
          (normalized.players && normalized.players.length > 0);

        if (!hasTeamContent) {
          await this.prisma.adminFormDraft.update({
            where: { id: draftId },
            data: { status: 'DRAFT' },
          });
          return { success: false, error: '缺少球队基本信息（如队名），仅保存为草稿' };
        }

        let seasonId = draft.seasonId || (draft.payload as any)?.seasonId;
        if (!seasonId) {
          const activeSeason = await this.prisma.season.findFirst({
            where: { status: 'active' },
            orderBy: { createdAt: 'desc' },
          });
          seasonId = activeSeason?.id || null;
        }

        if (!seasonId) {
          await this.prisma.adminFormDraft.update({
            where: { id: draftId },
            data: { status: 'DRAFT' },
          });
          return { success: false, error: '未确定目标赛季，仅保存为草稿' };
        }

        let createdTeamId: string | undefined = undefined;
        await this.prisma.$transaction(async (tx) => {
          if (draft.officialRecordId) {
            const updateDto: any = { seasonId, ...normalized };
            await this.teamService.updateWithPlayersCore(
              tx,
              draft.officialRecordId,
              updateDto,
              username,
              { role: 'super_admin' },
            );
            createdTeamId = draft.officialRecordId;
          } else {
            const createDto: any = { seasonId, ...normalized };
            const team = await this.teamService.createTeamCore(tx, createDto, username, {
              role: 'super_admin',
            });
            createdTeamId = team.id;
          }

          await tx.adminFormDraft.update({
            where: { id: draftId },
            data: {
              status: 'MATERIALIZED',
              officialRecordId: createdTeamId,
              seasonId,
              lastError: null,
            },
          });
        });

        if (createdTeamId) {
          await this.teamService.afterTeamCommitted(createdTeamId, username);
          return { success: true, officialRecordId: createdTeamId };
        }
      } else if (draft.formType === 'MATCH') {
        const normalized = normalizeMatchPayload(draft.payload);
        if (!normalized.homeTeamId || !normalized.awayTeamId) {
          await this.prisma.adminFormDraft.update({
            where: { id: draftId },
            data: { status: 'DRAFT' },
          });
          return { success: false, error: '主队或客队未选择，仅保存为草稿' };
        }
        if (normalized.homeTeamId === normalized.awayTeamId) {
          await this.prisma.adminFormDraft.update({
            where: { id: draftId },
            data: { status: 'DRAFT' },
          });
          return { success: false, error: '主客队不能为同一支球队，仅保存为草稿' };
        }

        let createdMatchId: string | undefined = undefined;
        let matchEvents: any[] = [];
        await this.prisma.$transaction(async (tx) => {
          const payloadAny = draft.payload as any;
          if (draft.officialRecordId) {
            const updateDto: any = {
              ...normalized,
              lineups: payloadAny?.lineups || [],
              events: payloadAny?.events || [],
              goals: payloadAny?.goals || [],
            };
            const updateRes = await this.matchService.updateMatchCore(
              tx,
              draft.officialRecordId,
              updateDto,
              username,
            );
            createdMatchId = draft.officialRecordId;
            matchEvents = updateRes.events;
          } else {
            const createDto: any = {
              ...normalized,
              lineups: payloadAny?.lineups || [],
              events: payloadAny?.events || [],
              goals: payloadAny?.goals || [],
            };
            const result = await this.matchService.createMatchCore(tx, createDto);
            createdMatchId = result.match.id;
            matchEvents = result.events;
          }

          await tx.adminFormDraft.update({
            where: { id: draftId },
            data: {
              status: 'MATERIALIZED',
              officialRecordId: createdMatchId,
              seasonId: normalized.seasonId,
              lastError: null,
            },
          });
        });

        if (createdMatchId) {
          await this.matchService.afterMatchCommitted(createdMatchId, username, matchEvents);
          return { success: true, officialRecordId: createdMatchId };
        }
      }

      return { success: false, error: '未知草稿类型' };
    } catch (err: any) {
      const errMsg = err?.message || String(err);
      this.logger.error(`Materialization failed for draft ${draftId}: ${errMsg}`, err.stack);

      await this.prisma.adminFormDraft.update({
        where: { id: draftId },
        data: {
          status: 'FAILED',
          lastError: errMsg,
        },
      });

      return { success: false, error: errMsg };
    }
  }
}
