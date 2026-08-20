import { ConflictException } from '@nestjs/common';
import { PrismaClient, RegistrationStatus } from '@prisma/client';
import { AuditLogService } from '../audit-log/audit-log.service';
import { TeamRosterService } from '../team/team-roster.service';
import { RegistrationService, UserContext } from './registration.service';

const databaseUrl = process.env.REGISTRATION_TEST_DATABASE_URL;
const isSafeLocalDatabase = Boolean(
  databaseUrl &&
  /@(127\.0\.0\.1|localhost):\d+\/sztufa_registration_test(?:\?|$)/.test(databaseUrl),
);

const describeWithLocalPostgres = isSafeLocalDatabase ? describe : describe.skip;

describeWithLocalPostgres('RegistrationService PostgreSQL integration', () => {
  const prisma = new PrismaClient({
    datasources: { db: { url: databaseUrl } },
  });

  const auditLogService = new AuditLogService(prisma as never);
  const teamRosterService = new TeamRosterService(prisma as never);
  const service = new RegistrationService(prisma as never, auditLogService, teamRosterService);

  const cleanupFixtures: Array<{
    seasonId: string;
    teamId: string;
    coachId: string;
    adminId: string;
    teamName: string;
  }> = [];

  const seedSubmittedRegistration = async (label: string) => {
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    const seasonId = `registration-season-${suffix}`;
    const teamId = `registration-team-${suffix}`;
    const coachId = `registration-coach-${suffix}`;
    const adminId = `registration-admin-${suffix}`;
    const registrationId = `registration-${suffix}`;
    const teamName = `Integration ${label} ${suffix}`;

    cleanupFixtures.push({ seasonId, teamId, coachId, adminId, teamName });

    await prisma.season.create({
      data: {
        id: seasonId,
        name: `Integration Season ${label} ${suffix}`,
        status: 'active',
      },
    });

    await prisma.team.create({
      data: {
        id: teamId,
        teamName,
        homeJerseyColor: '蓝色',
        awayJerseyColor: '白色',
        gender: 'MALE',
      },
    });

    await prisma.user.createMany({
      data: [
        {
          id: coachId,
          username: `coach-${suffix}`,
          password: 'integration-only',
          role: 'coach',
          teamId,
        },
        {
          id: adminId,
          username: `admin-${suffix}`,
          password: 'integration-only',
          role: 'super_admin',
        },
      ],
    });

    await prisma.teamRegistration.create({
      data: {
        id: registrationId,
        seasonId,
        teamId,
        submittedById: coachId,
        status: RegistrationStatus.SUBMITTED,
        submittedAt: new Date(),
        teamData: {
          create: {
            teamName,
            homeJerseyColor: '蓝色',
            awayJerseyColor: '白色',
            gender: 'MALE',
          },
        },
        players: {
          create: {
            name: `Player ${suffix}`,
            studentId: `SID-${suffix}`,
            jerseyNumber: '10',
          },
        },
      },
    });

    const adminContext: UserContext = {
      id: adminId,
      username: `admin-${suffix}`,
      role: 'super_admin',
      teamId: null,
    };

    return {
      registrationId,
      seasonId,
      teamId,
      teamName,
      adminContext,
    };
  };

  afterEach(async () => {
    for (const fixture of cleanupFixtures.splice(0)) {
      await prisma.teamRegistration.deleteMany({
        where: { seasonId: fixture.seasonId },
      });
      await prisma.seasonTeamPlayer.deleteMany({
        where: { seasonId: fixture.seasonId },
      });
      await prisma.seasonTeamProfile.deleteMany({
        where: { seasonId: fixture.seasonId },
      });
      await prisma.player.deleteMany({ where: { teamId: fixture.teamId } });
      await prisma.user.deleteMany({
        where: { id: { in: [fixture.coachId, fixture.adminId] } },
      });
      await prisma.team.deleteMany({ where: { id: fixture.teamId } });
      await prisma.season.deleteMany({ where: { id: fixture.seasonId } });
      await prisma.auditLog.deleteMany({
        where: {
          action: 'REGISTRATION_APPROVE',
          details: { contains: fixture.teamName },
        },
      });
    }
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('rolls back status, profile, players and audit log when materialization fails', async () => {
    const seeded = await seedSubmittedRegistration('rollback');
    const failingRosterService = {
      registerPlayer: jest.fn().mockRejectedValue(new Error('forced roster failure')),
    } as unknown as TeamRosterService;
    const failingService = new RegistrationService(
      prisma as never,
      auditLogService,
      failingRosterService,
    );

    await expect(
      failingService.approve(
        seeded.registrationId,
        { reviewComment: 'integration rollback' },
        seeded.adminContext,
      ),
    ).rejects.toThrow('forced roster failure');

    const [registration, profileCount, playerCount, rosterCount, auditCount] = await Promise.all([
      prisma.teamRegistration.findUnique({
        where: { id: seeded.registrationId },
        select: { status: true, reviewedAt: true, reviewedById: true },
      }),
      prisma.seasonTeamProfile.count({
        where: { seasonId: seeded.seasonId, teamId: seeded.teamId },
      }),
      prisma.player.count({ where: { teamId: seeded.teamId } }),
      prisma.seasonTeamPlayer.count({
        where: { seasonId: seeded.seasonId, teamId: seeded.teamId },
      }),
      prisma.auditLog.count({
        where: {
          action: 'REGISTRATION_APPROVE',
          details: { contains: seeded.teamName },
        },
      }),
    ]);

    expect(registration).toEqual({
      status: RegistrationStatus.SUBMITTED,
      reviewedAt: null,
      reviewedById: null,
    });
    expect(profileCount).toBe(0);
    expect(playerCount).toBe(0);
    expect(rosterCount).toBe(0);
    expect(auditCount).toBe(0);
  });

  it('allows exactly one of two concurrent approvals to materialize the roster', async () => {
    const seeded = await seedSubmittedRegistration('concurrency');

    const results = await Promise.allSettled([
      service.approve(
        seeded.registrationId,
        { reviewComment: 'first reviewer' },
        seeded.adminContext,
      ),
      service.approve(
        seeded.registrationId,
        { reviewComment: 'second reviewer' },
        seeded.adminContext,
      ),
    ]);

    const fulfilled = results.filter((result) => result.status === 'fulfilled');
    const rejected = results.filter(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    );

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toBeInstanceOf(ConflictException);

    const [registration, profile, rosterCount, auditCount] = await Promise.all([
      prisma.teamRegistration.findUnique({
        where: { id: seeded.registrationId },
        select: { status: true },
      }),
      prisma.seasonTeamProfile.findUnique({
        where: {
          seasonId_teamId: {
            seasonId: seeded.seasonId,
            teamId: seeded.teamId,
          },
        },
        select: { isRegistered: true },
      }),
      prisma.seasonTeamPlayer.count({
        where: { seasonId: seeded.seasonId, teamId: seeded.teamId },
      }),
      prisma.auditLog.count({
        where: {
          action: 'REGISTRATION_APPROVE',
          details: { contains: seeded.teamName },
        },
      }),
    ]);

    expect(registration?.status).toBe(RegistrationStatus.APPROVED);
    expect(profile?.isRegistered).toBe(true);
    expect(rosterCount).toBe(1);
    expect(auditCount).toBe(1);
  });
});
