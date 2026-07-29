import { toPublicPlayerDto, toPublicTeamDto } from './common/dto/public-response.dto';

describe('Privacy Redaction Mappers (Phase 3)', () => {
  const sensitivePlayer = {
    id: 'p1',
    name: '张三',
    studentId: '2023010101',
    legacyKey: 'LEGACY_99',
    jerseyNumber: '10',
    photo: 'https://cdn.example.com/p1.jpg',
    status: 'active',
    yellowCards: 1,
    redCards: 0,
    deletedAt: new Date('2026-01-01'),
    suspendedAtMatchId: 'm1',
    teamId: 't1',
    team: {
      id: 't1',
      teamName: '计算机学院足球队',
      teamDoctor: '李医生',
      headCoach: '王教练',
      teamLeader: '赵领队',
      coachPhone: '13800138000',
      leaderPhone: '13900139000',
      homeJerseyColor: '红色',
      awayJerseyColor: '白色',
      teamLogo: 'https://cdn.example.com/logo.png',
      homeJersey: 'https://cdn.example.com/hj.png',
      awayJersey: 'https://cdn.example.com/aj.png',
      gender: 'MALE',
      deletedAt: new Date('2026-01-01'),
    },
  };

  const sensitiveTeam = {
    id: 't1',
    teamName: '计算机学院足球队',
    teamDoctor: '李医生',
    headCoach: '王教练',
    teamLeader: '赵领队',
    coachPhone: '13800138000',
    leaderPhone: '13900139000',
    homeJerseyColor: '红色',
    awayJerseyColor: '白色',
    teamLogo: 'https://cdn.example.com/logo.png',
    homeJersey: 'https://cdn.example.com/hj.png',
    awayJersey: 'https://cdn.example.com/aj.png',
    gender: 'MALE',
    deletedAt: new Date('2026-01-01'),
    players: [sensitivePlayer],
  };

  function hasKeyDeep(obj: any, targetKeys: string[]): string | null {
    if (!obj || typeof obj !== 'object') return null;
    if (obj instanceof Date) return null;
    for (const key of Object.keys(obj)) {
      if (targetKeys.includes(key) && obj[key] !== undefined) {
        return key;
      }
      const found = hasKeyDeep(obj[key], targetKeys);
      if (found) return found;
    }
    return null;
  }

  const forbiddenKeys = [
    'studentId',
    'coachPhone',
    'leaderPhone',
    'password',
    'legacyKey',
    'deletedAt',
  ];

  it('toPublicPlayerDto should strip all sensitive fields at any depth', () => {
    const publicPlayer = toPublicPlayerDto(sensitivePlayer);
    const leakedKey = hasKeyDeep(publicPlayer, forbiddenKeys);
    expect(leakedKey).toBeNull();
    expect(publicPlayer.id).toBe('p1');
    expect(publicPlayer.name).toBe('张三');
    expect(publicPlayer.jerseyNumber).toBe('10');
  });

  it('toPublicTeamDto should strip all sensitive fields at any depth', () => {
    const publicTeam = toPublicTeamDto(sensitiveTeam);
    const leakedKey = hasKeyDeep(publicTeam, forbiddenKeys);
    expect(leakedKey).toBeNull();
    expect(publicTeam.id).toBe('t1');
    expect(publicTeam.teamName).toBe('计算机学院足球队');
    expect((publicTeam as any).coachPhone).toBeUndefined();
    expect((publicTeam as any).leaderPhone).toBeUndefined();
  });
});
