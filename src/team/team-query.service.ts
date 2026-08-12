import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { publicPlayerFieldsSelect, publicTeamSelect } from '../common/dto/public-response.dto';

@Injectable()
export class TeamQueryService {
  constructor(private readonly prisma: PrismaService) {}

  async findAll(page: number = 1, limit: number = 10, seasonId?: string, gender?: string) {
    const pageNum = Math.max(1, Number(page) || 1);
    const limitNum = Math.max(1, Math.min(100, Number(limit) || 10));
    const skip = (pageNum - 1) * limitNum;

    const where: any = { deletedAt: null };
    if (seasonId && seasonId !== 'all') {
      where.OR = [
        { seasonProfiles: { some: { seasonId, isRegistered: true } } },
        { seasonPlayers: { some: { seasonId } } },
        { groupTeams: { some: { seasonId } } },
        { homeMatches: { some: { seasonId } } },
        { awayMatches: { some: { seasonId } } },
      ];
    } else if (gender && gender !== 'all') {
      where.gender = gender;
    }

    const [teams, total] = await Promise.all([
      this.prisma.team.findMany({
        skip,
        take: limitNum,
        where,
        include: {
          players: seasonId && seasonId !== 'all' ? false : { where: { deletedAt: null } },
          seasonPlayers:
            seasonId && seasonId !== 'all'
              ? {
                  where: {
                    seasonId,
                    player: { deletedAt: null },
                  },
                  include: { player: true },
                }
              : false,
          groupTeams: seasonId && seasonId !== 'all' ? { where: { seasonId } } : true,
          ...(seasonId && seasonId !== 'all' ? { seasonProfiles: { where: { seasonId } } } : {}),
        },
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.team.count({ where }),
    ]);
    const data = teams.map((team: any) => {
      const { seasonProfiles, seasonPlayers, ...baseTeam } = team;
      if (seasonId && seasonId !== 'all') {
        baseTeam.players = (seasonPlayers || []).map((roster: any) => ({
          ...roster.player,
          name: roster.playerName,
          studentId: roster.studentId,
          jerseyNumber: roster.jerseyNumber,
          photo: roster.playerPhoto,
          teamId: roster.teamId,
        }));
      }
      const profile = seasonProfiles?.[0];
      if (!profile) return baseTeam;
      return {
        ...baseTeam,
        teamName: profile.teamName,
        teamDoctor: profile.teamDoctor,
        headCoach: profile.headCoach,
        teamLeader: profile.teamLeader,
        coachPhone: profile.coachPhone,
        leaderPhone: profile.leaderPhone,
        homeJerseyColor: profile.homeJerseyColor,
        awayJerseyColor: profile.awayJerseyColor,
        teamLogo: profile.teamLogo,
        homeJersey: profile.homeJersey,
        awayJersey: profile.awayJersey,
        gender: profile.gender,
      };
    });
    return { data, total, page: pageNum, limit: limitNum };
  }

  async findPublicAll(page: number = 1, limit: number = 10, seasonId?: string, gender?: string) {
    const pageNum = Math.max(1, Number(page) || 1);
    const limitNum = Math.max(1, Math.min(100, Number(limit) || 10));
    const skip = (pageNum - 1) * limitNum;
    const hasSeason = !!seasonId && seasonId !== 'all';
    const where: any = { deletedAt: null };

    if (hasSeason) {
      where.OR = [
        { seasonProfiles: { some: { seasonId, isRegistered: true } } },
        { seasonPlayers: { some: { seasonId } } },
        { groupTeams: { some: { seasonId } } },
        { homeMatches: { some: { seasonId } } },
        { awayMatches: { some: { seasonId } } },
      ];
    } else if (gender && gender !== 'all') {
      where.gender = gender;
    }

    const [teams, total] = await Promise.all([
      this.prisma.team.findMany({
        skip,
        take: limitNum,
        where,
        select: {
          ...publicTeamSelect,
          players: hasSeason
            ? false
            : { where: { deletedAt: null }, select: publicPlayerFieldsSelect },
          seasonPlayers: hasSeason
            ? {
                where: { seasonId, player: { deletedAt: null } },
                select: {
                  teamId: true,
                  playerName: true,
                  jerseyNumber: true,
                  playerPhoto: true,
                  player: { select: publicPlayerFieldsSelect },
                },
              }
            : false,
          seasonProfiles: hasSeason ? { where: { seasonId }, select: publicTeamSelect } : false,
        },
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.team.count({ where }),
    ]);

    const data = teams.map((team: any) => {
      const { seasonProfiles, seasonPlayers, ...baseTeam } = team;
      if (hasSeason) {
        baseTeam.players = (seasonPlayers || []).map((roster: any) => ({
          ...roster.player,
          name: roster.playerName,
          jerseyNumber: roster.jerseyNumber,
          photo: roster.playerPhoto,
          teamId: roster.teamId,
        }));
      }
      const profile = seasonProfiles?.[0];
      if (!profile) return baseTeam;
      return {
        ...baseTeam,
        teamName: profile.teamName,
        teamDoctor: profile.teamDoctor,
        headCoach: profile.headCoach,
        teamLeader: profile.teamLeader,
        homeJerseyColor: profile.homeJerseyColor,
        awayJerseyColor: profile.awayJerseyColor,
        teamLogo: profile.teamLogo,
        homeJersey: profile.homeJersey,
        awayJersey: profile.awayJersey,
        gender: profile.gender,
      };
    });

    return { data, total, page: pageNum, limit: limitNum };
  }

  async findOne(id: string, seasonId?: string) {
    const team = await this.prisma.team.findUnique({
      where: { id },
      include: {
        players: seasonId ? false : { where: { deletedAt: null } },
        seasonPlayers: seasonId
          ? {
              where: { seasonId, player: { deletedAt: null } },
              include: { player: true },
            }
          : false,
        seasonProfiles: seasonId ? { where: { seasonId } } : false,
        groupTeams: seasonId ? { where: { seasonId } } : true,
      },
    });
    if (!team || team.deletedAt !== null) {
      throw new NotFoundException('球队不存在');
    }
    if (!seasonId) return team;

    const { seasonPlayers, seasonProfiles, ...baseTeam } = team as any;
    const profile = seasonProfiles?.[0];
    return {
      ...baseTeam,
      ...(profile || {}),
      id: team.id,
      players: (seasonPlayers || []).map((roster: any) => ({
        ...roster.player,
        name: roster.playerName,
        studentId: roster.studentId,
        jerseyNumber: roster.jerseyNumber,
        photo: roster.playerPhoto,
        teamId: roster.teamId,
      })),
    };
  }

  async searchByName(name: string) {
    if (!name || name.trim() === '') return [];
    return this.prisma.team.findMany({
      where: { teamName: { contains: name.trim() }, deletedAt: null },
      include: { players: { where: { deletedAt: null } } },
      take: 20,
    });
  }

  async searchPublicByName(name: string) {
    if (!name || name.trim() === '') return [];
    return this.prisma.team.findMany({
      where: { teamName: { contains: name.trim() }, deletedAt: null },
      select: {
        ...publicTeamSelect,
        players: { where: { deletedAt: null }, select: publicPlayerFieldsSelect },
      },
      take: 20,
    });
  }

  async findPublicOne(id: string) {
    const team = await this.prisma.team.findUnique({
      where: { id },
      select: {
        ...publicTeamSelect,
        deletedAt: true,
        players: { where: { deletedAt: null }, select: publicPlayerFieldsSelect },
      },
    });
    if (!team || team.deletedAt !== null) {
      throw new NotFoundException('球队不存在');
    }
    const { deletedAt: _deletedAt, ...publicTeam } = team;
    return publicTeam;
  }
}
