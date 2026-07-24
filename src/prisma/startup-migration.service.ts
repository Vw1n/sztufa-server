import { Injectable, OnModuleInit } from '@nestjs/common';
import { PrismaService } from './prisma.service';
import { SeasonStatisticsService } from './season-statistics.service';

@Injectable()
export class StartupMigrationService implements OnModuleInit {
  private static hasRun = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly seasonStatistics: SeasonStatisticsService,
  ) {}

  async onModuleInit() {
    await this.run();
  }

  async run() {
    if (StartupMigrationService.hasRun) return;
    StartupMigrationService.hasRun = true;

    try {
      await this.migrateSeasonRosters();
      await this.seedInitialNews();
      await this.precomputeSeasonCaches();
    } catch (error) {
      console.error('[Startup Migration] Error during startup migration:', error);
    }
  }

  private async migrateSeasonRosters() {
    const rosterCount = await this.prisma.seasonTeamPlayer.count();
    if (rosterCount !== 0) return;

    console.log('[Startup Migration] SeasonTeamPlayer is empty, migrating roster data...');
    const seasons = await this.prisma.season.findMany();
    const players = await this.prisma.player.findMany();

    for (const season of seasons) {
      console.log(`[Startup Migration] Registering players to season: ${season.name}`);
      for (const player of players) {
        await this.prisma.seasonTeamPlayer
          .upsert({
            where: {
              seasonId_playerId: { seasonId: season.id, playerId: player.id },
            },
            create: {
              seasonId: season.id,
              teamId: player.teamId,
              playerId: player.id,
            },
            update: {},
          })
          .catch((error) => {
            console.error(
              `[Startup Migration] Failed to register player ${player.name} to season ${season.name}:`,
              error.message,
            );
          });
      }
    }
    console.log('[Startup Migration] SeasonTeamPlayer migration completed!');
  }

  private async seedInitialNews() {
    const newsCount = await this.prisma.news.count();
    if (newsCount !== 0) return;

    console.log('[Startup Migration] News table is empty, seeding initial WeChat news articles...');
    await this.prisma.news.createMany({
      data: [
        {
          title: '【赛事预热】第八届“校长杯”总决赛即将开战！',
          category: '赛事',
          description:
            '巅峰对决即将上演！两支老牌冠军队伍强势突围，成功会师总决赛，开启终极冠军争夺战！让我们共同期待这场年度足球盛宴！',
          coverImage: '/activity1.jpg',
          wechatUrl:
            'https://mp.weixin.qq.com/s?__biz=MzkxMzIzOTQ4MA==&mid=2247489893&idx=1&sn=4abc5e36f42f1ec8ce5ae88e6b9cfa13&chksm=c0b8fb11c918d5815c11852db750948d93c9044c5b3a33c2b02e75b8e482a6b0a4109bac29f7&sessionid=1784201826&scene=126&clicktime=1784201838&enterid=1784201838&subscene=10000&ascene=3&fasttmpl_type=4&fasttmpl_fullversion=8348083-zh_CN-zip&fasttmpl_flag=0&realreporttime=1784201838994&devicetype=android-36&version=28004c31&nettype=WIFI&lang=zh_CN&session_us=gh_8d0a6966201e&countrycode=CN&exportkey=n_ChQIAhIQaZf9AK3uKC%2B6ca442OH%2B%2FRLxAQIE97dBBAEAAAAAAIeXIIhYkQsAAAAOpnltbLcz9gKNyK89dVj0qGV71Izvj%2Bm8fFAmu2sTc%2Ffr6pEYdr5qrhSvqjEb4XpSc481MGbhgQEFJIV5a6oPc1BVZjgSiLk5CBmVxfkFdpr8bLdpQiOrvPcwAkZGomQ2aGzGoOl%2BjCfVND775OLK%2BSiVE7uo4t%2FrNLfVLr9Xda%2B98gv4fvQ8Vr50lhvgUWYCgl6z6o9Nd8KC3p06u8FfCjXfI7ePmrpTHnPjGkAmSlmcdjS19wGf0OtrXObsbPNHx%2BDaZ4fJNKfvGnWGF%2F8Py8osdKl9fsUJizY%3D&pass_ticket=InieAWhw8D6e0PpRRWN3qVT9VLS%2BsZs1b%2FS%2BZPiNdV2%2BIG%2BoRxAtAC29k36IXtQg&wx_header=3',
          date: '2026-06-17',
          content: '',
        },
        {
          title: '【喜报】我校女子足球队省赛创历史最佳战绩！',
          category: '赛事',
          description:
            '在2025年广东省青少年校园足球联赛（大学组）中，我校女子足球队奋勇拼搏，首次闯进八强，最终荣获赛事一等奖，创造了自建队以来的历史最佳战绩！',
          coverImage: '/activity2.jpg',
          wechatUrl: 'https://mp.weixin.qq.com/s/PXl0z-m0Kkoc1aN8kWsPtA',
          date: '2025-12-20',
          content: '',
        },
      ],
    });
    console.log('[Startup Migration] Seeding WeChat news completed!');
  }

  private async precomputeSeasonCaches() {
    console.log('[Startup Migration] Pre-computing standings and stats caches for all seasons...');
    const seasons = await this.prisma.season.findMany();
    const errors: string[] = [];
    for (const season of seasons) {
      const result = await this.seasonStatistics.computeAndCache(season.id);
      if (!result.success) {
        errors.push(`赛季 ${season.name}: ${result.error}`);
      }
    }
    if (errors.length > 0) {
      console.error('[Startup Migration] 部分赛季缓存预计算失败:', errors);
    }
    console.log('[Startup Migration] Standings and stats pre-computation completed!');
  }
}
