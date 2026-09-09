import { BadRequestException } from '@nestjs/common';
import {
  BACKUP_MODULE_REGISTRY,
  BACKUP_MODULES,
  FULL_BACKUP_TABLES,
} from './backup-module-registry';
import { BackupPlanService, getSeasonModuleWhereClause } from './backup-plan.service';
import { normalizeBackupRequest } from './backup-request';
import { V4_PERSISTENT_MODELS } from './backup-table-registry';

describe('backup module request and registry', () => {
  it('normalizes full, V4 season and legacy season requests', () => {
    expect(normalizeBackupRequest(undefined)).toEqual({ scope: 'full' });
    expect(
      normalizeBackupRequest({
        scope: 'module',
        module: 'season',
        selector: { seasonId: ' s1 ' },
      }),
    ).toEqual({ scope: 'module', module: 'season', selector: { seasonId: 's1' } });
    expect(normalizeBackupRequest({ scope: 'season', seasonId: 's2' })).toEqual({
      scope: 'module',
      module: 'season',
      selector: { seasonId: 's2' },
    });
  });

  it.each([
    null,
    { scope: 'unknown' },
    { scope: 'full', seasonId: 's1' },
    { scope: 'module', module: 'season', selector: {} },
    { scope: 'module', module: 'season', selector: { seasonId: 's1', extra: true } },
    { scope: 'module', module: 'staff', selector: { seasonId: 's1' } },
    { scope: 'module', module: 'missing', selector: {} },
  ])('rejects malformed request %#', (request) => {
    expect(() => normalizeBackupRequest(request)).toThrow(BadRequestException);
  });

  it('assigns every persistent table to one primary owned/reference module role', () => {
    const owned = BACKUP_MODULES.flatMap((module) => BACKUP_MODULE_REGISTRY[module].ownedTables);
    expect(new Set(owned).size).toBe(owned.length);
    const primaryTables = [...owned, ...BACKUP_MODULE_REGISTRY.season.referenceTables];
    expect(new Set(primaryTables).size).toBe(primaryTables.length);
    expect(new Set(primaryTables)).toEqual(new Set(V4_PERSISTENT_MODELS));
    expect(new Set(FULL_BACKUP_TABLES)).toEqual(new Set(V4_PERSISTENT_MODELS));
  });
});

describe('BackupPlanService', () => {
  const validateSeason = jest.fn();
  const service = new BackupPlanService({ validateSeason } as any);

  beforeEach(() => {
    validateSeason.mockReset();
    validateSeason.mockResolvedValue({ id: 's1', name: '赛季一' });
  });

  it('compiles a full plan containing all 22 persistent tables', async () => {
    const plan = await service.compile({ scope: 'full' });
    expect(plan.module).toBe('full');
    expect(plan.tables).toHaveLength(22);
    expect(plan.tables.every((table) => table.role === 'owned')).toBe(true);
    expect(validateSeason).not.toHaveBeenCalled();
    expect(Object.isFrozen(plan)).toBe(true);
  });

  it('compiles season owned/reference tables and external dependencies', async () => {
    const plan = await service.compile({
      scope: 'module',
      module: 'season',
      selector: { seasonId: 's1' },
    });

    expect(validateSeason).toHaveBeenCalledWith('s1');
    expect(plan.tables).toHaveLength(15);
    expect(plan.tables.find((table) => table.tableName === 'RegistrationPlayer')?.where).toEqual({
      registration: { seasonId: 's1' },
    });
    expect(plan.tables.find((table) => table.tableName === 'Team')?.role).toBe('reference');
    expect(plan.externalDependencies).toEqual(['User', 'MemberAccount']);
    const teamWhere = plan.tables.find((table) => table.tableName === 'Team')?.where;
    expect(Object.isFrozen(teamWhere)).toBe(true);
    expect(Object.isFrozen(teamWhere?.OR)).toBe(true);
  });

  it('uses database relation filters for indirect registration children', () => {
    expect(getSeasonModuleWhereClause('RegistrationTeamData', 's1')).toEqual({
      registration: { seasonId: 's1' },
    });
    expect(getSeasonModuleWhereClause('RegistrationPlayer', 's1')).toEqual({
      registration: { seasonId: 's1' },
    });
  });

  it.each(['staff', 'members', 'content', 'operations'] as const)(
    'compiles %s without a season selector',
    async (module) => {
      const plan = await service.compile({ scope: 'module', module, selector: {} });
      expect(plan.module).toBe(module);
      expect(plan.selector).toEqual({});
      expect(validateSeason).not.toHaveBeenCalled();
    },
  );
});
