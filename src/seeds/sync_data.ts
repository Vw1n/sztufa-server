import { PrismaClient } from '@prisma/client';
import * as bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

async function main() {
  console.log('开始同步数据...');

  // 1. 同步 User (创建默认管理员)
  const existingAdmin = await prisma.user.findUnique({ where: { username: 'admin' } });
  if (!existingAdmin) {
    const hashedPassword = await bcrypt.hash('password123', 10);
    await prisma.user.create({
      data: {
        username: 'admin',
        password: hashedPassword,
        role: 'admin',
      },
    });
    console.log('已创建本地管理员账号: admin / password123');
  }

  // 2. 同步 Teams & Players
  const teamsResponse = await fetch('https://api.sztufa.xyz/api/v1/teams?page=1&limit=100');
  const teamsData = (await teamsResponse.json()) as any;

  for (const team of teamsData.data) {
    console.log(`正在同步球队: ${team.teamName}`);
    await prisma.team.upsert({
      where: { id: team.id },
      update: {
        teamName: team.teamName,
        teamDoctor: team.teamDoctor,
        headCoach: team.headCoach,
        teamLeader: team.teamLeader,
        coachPhone: team.coachPhone,
        leaderPhone: team.leaderPhone,
        homeJerseyColor: team.homeJerseyColor,
        awayJerseyColor: team.awayJerseyColor,
        teamLogo: team.teamLogo,
        homeJersey: team.homeJersey,
        awayJersey: team.awayJersey,
      },
      create: {
        id: team.id,
        teamName: team.teamName,
        teamDoctor: team.teamDoctor,
        headCoach: team.headCoach,
        teamLeader: team.teamLeader,
        coachPhone: team.coachPhone,
        leaderPhone: team.leaderPhone,
        homeJerseyColor: team.homeJerseyColor,
        awayJerseyColor: team.awayJerseyColor,
        teamLogo: team.teamLogo,
        homeJersey: team.homeJersey,
        awayJersey: team.awayJersey,
      },
    });

    if (team.players && team.players.length > 0) {
      for (const player of team.players) {
        await prisma.player.upsert({
          where: { studentId: player.studentId },
          update: {
            name: player.name,
            jerseyNumber: player.jerseyNumber,
            photo: player.photo,
            teamId: team.id,
          },
          create: {
            id: player.id,
            name: player.name,
            studentId: player.studentId,
            jerseyNumber: player.jerseyNumber,
            photo: player.photo,
            teamId: team.id,
          },
        });
      }
      console.log(`  已导入球员数量: ${team.players.length}`);
    }
  }

  // 3. 同步 Matches
  const matchesResponse = await fetch('https://api.sztufa.xyz/api/v1/matches?page=1&limit=100');
  const matchesData = (await matchesResponse.json()) as any;

  for (const match of matchesData.data) {
    console.log(`正在同步比赛: ${match.homeTeam.teamName} vs ${match.awayTeam.teamName}`);
    await prisma.match.upsert({
      where: { id: match.id },
      update: {
        homeTeamId: match.homeTeamId,
        awayTeamId: match.awayTeamId,
        homeScore: match.homeScore,
        awayScore: match.awayScore,
        matchDate: new Date(match.matchDate),
        location: match.location,
        status: match.status,
      },
      create: {
        id: match.id,
        homeTeamId: match.homeTeamId,
        awayTeamId: match.awayTeamId,
        homeScore: match.homeScore,
        awayScore: match.awayScore,
        matchDate: new Date(match.matchDate),
        location: match.location,
        status: match.status,
      },
    });
  }

  console.log('同步成功！');
}

main().catch(console.error).finally(() => prisma.$disconnect());
