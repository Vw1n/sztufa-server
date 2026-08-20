import { Test, TestingModule } from '@nestjs/testing';
import { Reflector } from '@nestjs/core';
import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { RegistrationController } from './registration.controller';
import { RegistrationService } from './registration.service';
import { RolesGuard } from '../auth/roles.guard';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { ROLES_KEY } from '../auth/roles.decorator';
import { GUARDS_METADATA } from '@nestjs/common/constants';

describe('RegistrationController with Guard & Metadata Validation', () => {
  let controller: RegistrationController;
  let service: RegistrationService;
  let rolesGuard: RolesGuard;
  let reflector: Reflector;

  const mockRegistrationService = {
    getMine: jest.fn(),
    create: jest.fn(),
    save: jest.fn(),
    submit: jest.fn(),
    getAdminList: jest.fn(),
    getDetail: jest.fn(),
    approve: jest.fn(),
    requestChanges: jest.fn(),
  };

  const createMockContext = (
    user?: unknown,
    handler?: (...args: never[]) => unknown,
  ): ExecutionContext => {
    return {
      getHandler: () => handler || ((): void => {}),
      getClass: () => RegistrationController,
      switchToHttp: () => ({
        getRequest: () => ({ user }),
      }),
    } as unknown as ExecutionContext;
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [RegistrationController],
      providers: [
        Reflector,
        RolesGuard,
        {
          provide: RegistrationService,
          useValue: mockRegistrationService,
        },
      ],
    }).compile();

    controller = module.get<RegistrationController>(RegistrationController);
    service = module.get<RegistrationService>(RegistrationService);
    reflector = module.get<Reflector>(Reflector);
    rolesGuard = module.get<RolesGuard>(RolesGuard);
  });

  describe('Controller Guards & Metadata', () => {
    it('should have JwtAuthGuard and RolesGuard attached at class level', () => {
      const guards = Reflect.getMetadata(GUARDS_METADATA, RegistrationController);
      expect(guards).toBeDefined();
      expect(guards).toContain(JwtAuthGuard);
      expect(guards).toContain(RolesGuard);
    });

    it('should restrict getAdminList, approve, requestChanges to super_admin', () => {
      const adminListRoles = reflector.get<string[]>(ROLES_KEY, controller.getAdminList);
      const approveRoles = reflector.get<string[]>(ROLES_KEY, controller.approve);
      const requestChangesRoles = reflector.get<string[]>(ROLES_KEY, controller.requestChanges);

      expect(adminListRoles).toEqual(['super_admin']);
      expect(approveRoles).toEqual(['super_admin']);
      expect(requestChangesRoles).toEqual(['super_admin']);
    });

    it('should restrict getMine, create, save, submit to coach', () => {
      const mineRoles = reflector.get<string[]>(ROLES_KEY, controller.getMine);
      const createRoles = reflector.get<string[]>(ROLES_KEY, controller.create);
      const saveRoles = reflector.get<string[]>(ROLES_KEY, controller.save);
      const submitRoles = reflector.get<string[]>(ROLES_KEY, controller.submit);

      expect(mineRoles).toEqual(['coach']);
      expect(createRoles).toEqual(['coach']);
      expect(saveRoles).toEqual(['coach']);
      expect(submitRoles).toEqual(['coach']);
    });
  });

  describe('RolesGuard execution tests', () => {
    it('should reject coach trying to access getAdminList with ForbiddenException', () => {
      const coachUser = { id: 'u1', role: 'coach' };
      const ctx = createMockContext(coachUser, controller.getAdminList);

      expect(() => rolesGuard.canActivate(ctx)).toThrow(ForbiddenException);
    });

    it('should reject coach trying to access approve with ForbiddenException', () => {
      const coachUser = { id: 'u1', role: 'coach' };
      const ctx = createMockContext(coachUser, controller.approve);

      expect(() => rolesGuard.canActivate(ctx)).toThrow(ForbiddenException);
    });

    it('should allow coach to access getMine', () => {
      const coachUser = { id: 'u1', role: 'coach' };
      const ctx = createMockContext(coachUser, controller.getMine);

      expect(rolesGuard.canActivate(ctx)).toBe(true);
    });

    it('should allow super_admin to access any route', () => {
      const adminUser = { id: 'a1', role: 'super_admin' };
      const adminListCtx = createMockContext(adminUser, controller.getAdminList);
      const approveCtx = createMockContext(adminUser, controller.approve);

      expect(rolesGuard.canActivate(adminListCtx)).toBe(true);
      expect(rolesGuard.canActivate(approveCtx)).toBe(true);
    });

    it('should return false if unauthenticated (no user on request)', () => {
      const ctx = createMockContext(undefined, controller.getMine);
      expect(rolesGuard.canActivate(ctx)).toBe(false);
    });
  });

  describe('Controller Action Handlers', () => {
    it('getAdminList delegates to service.getAdminList', async () => {
      mockRegistrationService.getAdminList.mockResolvedValue({ items: [], total: 0 });
      await controller.getAdminList({ page: 1, pageSize: 20 });
      expect(service.getAdminList).toHaveBeenCalledWith({ page: 1, pageSize: 20 });
    });

    it('approve delegates to service.approve', async () => {
      const mockReq = { user: { id: 'a1', role: 'super_admin' } };
      mockRegistrationService.approve.mockResolvedValue({ id: 'reg-1', status: 'APPROVED' });
      await controller.approve('reg-1', { reviewComment: 'OK' }, mockReq as any);
      expect(service.approve).toHaveBeenCalledWith('reg-1', { reviewComment: 'OK' }, mockReq.user);
    });

    it('requestChanges delegates to service.requestChanges', async () => {
      const mockReq = { user: { id: 'a1', role: 'super_admin' } };
      mockRegistrationService.requestChanges.mockResolvedValue({
        id: 'reg-1',
        status: 'CHANGES_REQUESTED',
      });
      await controller.requestChanges('reg-1', { reviewComment: 'Fix' }, mockReq as any);
      expect(service.requestChanges).toHaveBeenCalledWith(
        'reg-1',
        { reviewComment: 'Fix' },
        mockReq.user,
      );
    });
  });
});
