import { Injectable, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { MandatoryBackupTableName } from './backup-table-registry';

export type BackupScope = 'full' | 'season';

export interface SeasonInfo {
  id: string;
  name: string;
}

export interface BackupScopeInfo {
  scope: BackupScope;
  season?: SeasonInfo;
}

export function getSeasonTableWhereClause(
  tableName: MandatoryBackupTableName,
  seasonId: string,
): Record<string, any> {
  const playerPredicate = {
    OR: [
      { seasonPlayers: { some: { seasonId } } },
      { matchLineups: { some: { match: { seasonId } } } },
      { goals: { some: { match: { seasonId } } } },
      { events: { some: { match: { seasonId } } } },
      { subEvents: { some: { match: { seasonId } } } },
      { assistEvents: { some: { match: { seasonId } } } },
      { mvpMatches: { some: { seasonId } } },
    ],
  };

  const teamPredicate = {
    OR: [
      { seasonProfiles: { some: { seasonId } } },
      { seasonPlayers: { some: { seasonId } } },
      { groupTeams: { some: { seasonId } } },
      { homeMatches: { some: { seasonId } } },
      { awayMatches: { some: { seasonId } } },
      { players: { some: playerPredicate } },
    ],
  };

  const userPredicate = {
    OR: [
      { predictions: { some: { match: { seasonId } } } },
      { seasonDeletionApprovals: { some: { seasonId } } },
      { team: { is: teamPredicate } },
    ],
  };

  switch (tableName) {
    case 'Season':
      return { id: seasonId };
    case 'SeasonTeamProfile':
    case 'SeasonTeamPlayer':
    case 'SeasonGroupTeam':
    case 'SeasonDeletionApproval':
    case 'Match':
      return { seasonId };
    case 'MatchLineup':
    case 'MatchEvent':
    case 'Goal':
    case 'Prediction':
      return { match: { seasonId } };
    case 'Team':
      return teamPredicate;
    case 'Player':
      return playerPredicate;
    case 'User':
      return userPredicate;
    case 'HistoryImportBatch':
    case 'AuditLog':
    case 'News':
    case 'PdfImportBatch':
      return { id: '00000000-0000-0000-0000-000000000000' };
    default:
      return { id: '00000000-0000-0000-0000-000000000000' };
  }
}

@Injectable()
export class BackupScopeService {
  constructor(private readonly prisma: PrismaService) {}

  async validateSeason(seasonId: string, tx?: any): Promise<SeasonInfo> {
    const client = tx || this.prisma;
    const season = await client.season.findUnique({
      where: { id: seasonId },
      select: { id: true, name: true },
    });
    if (!season) {
      throw new BadRequestException(`未找到指定 ID 的赛季: ${seasonId}`);
    }
    return season;
  }
}
