import { describe, expect, it, beforeEach, afterEach, jest } from '@jest/globals';
import { Test, TestingModule } from '@nestjs/testing';
import {
  INestApplication,
  ValidationPipe,
  ExecutionContext,
  UnauthorizedException,
} from '@nestjs/common';
import request from 'supertest';
import { SeasonController } from './season.controller';
import { SeasonService } from './season.service';
import { Reflector } from '@nestjs/core';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { validate } from 'class-validator';
import { UpdateSeasonChampionDto } from './dto/update-season-champion.dto';

describe('SeasonController & DTO Validation', () => {
  let app: INestApplication;
  let seasonService: jest.Mocked<Partial<SeasonService>>;

  beforeEach(async () => {
    seasonService = {
      updateSeasonChampion: jest
        .fn<any>()
        .mockResolvedValue({ id: 'season-1', manualChampionTeamId: 'team-1' }),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [SeasonController],
      providers: [
        Reflector,
        RolesGuard,
        {
          provide: SeasonService,
          useValue: seasonService,
        },
      ],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue({
        canActivate: (context: ExecutionContext) => {
          const req = context.switchToHttp().getRequest();
          const authHeader = req.headers?.authorization;
          if (!authHeader) {
            throw new UnauthorizedException('未授权登录');
          }
          if (authHeader === 'Bearer regular-token') {
            req.user = { id: 'user-1', username: 'regular_user', role: 'user' };
          } else if (authHeader === 'Bearer admin-token') {
            req.user = { id: 'admin-1', username: 'super_admin_user', role: 'super_admin' };
          }
          return true;
        },
      })
      .compile();

    app = module.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true }));
    await app.init();
  });

  afterEach(async () => {
    if (app) await app.close();
  });

  describe('HTTP Route Guards & Role Authorization', () => {
    it('returns 401 Unauthorized when request has no Authorization header', async () => {
      const response = await request(app.getHttpServer())
        .patch('/api/v1/seasons/season-1/champion')
        .send({ teamId: 'team-1' });

      expect(response.status).toBe(401);
    });

    it('returns 403 Forbidden when user role is regular user', async () => {
      const response = await request(app.getHttpServer())
        .patch('/api/v1/seasons/season-1/champion')
        .set('Authorization', 'Bearer regular-token')
        .send({ teamId: 'team-1' });

      expect(response.status).toBe(403);
    });

    it('returns 200 OK when user is super_admin and payload is valid', async () => {
      const response = await request(app.getHttpServer())
        .patch('/api/v1/seasons/season-1/champion')
        .set('Authorization', 'Bearer admin-token')
        .send({ teamId: 'team-1' });

      expect(response.status).toBe(200);
      expect(seasonService.updateSeasonChampion).toHaveBeenCalledWith(
        'season-1',
        { teamId: 'team-1' },
        'super_admin_user',
      );
    });

    it('returns 400 Bad Request when request body is empty object {}', async () => {
      const response = await request(app.getHttpServer())
        .patch('/api/v1/seasons/season-1/champion')
        .set('Authorization', 'Bearer admin-token')
        .send({});

      expect(response.status).toBe(400);
    });

    it('returns 400 Bad Request when teamId is empty string ""', async () => {
      const response = await request(app.getHttpServer())
        .patch('/api/v1/seasons/season-1/champion')
        .set('Authorization', 'Bearer admin-token')
        .send({ teamId: '' });

      expect(response.status).toBe(400);
    });

    it('returns 200 OK when teamId is explicit null (clear champion)', async () => {
      const response = await request(app.getHttpServer())
        .patch('/api/v1/seasons/season-1/champion')
        .set('Authorization', 'Bearer admin-token')
        .send({ teamId: null });

      expect(response.status).toBe(200);
      expect(seasonService.updateSeasonChampion).toHaveBeenCalledWith(
        'season-1',
        { teamId: null },
        'super_admin_user',
      );
    });
  });

  describe('UpdateSeasonChampionDto class-validator unit tests', () => {
    it('passes validation for valid string teamId', async () => {
      const dto = new UpdateSeasonChampionDto();
      dto.teamId = 'team-123';
      const errors = await validate(dto);
      expect(errors.length).toBe(0);
    });

    it('passes validation for explicit null teamId', async () => {
      const dto = new UpdateSeasonChampionDto();
      dto.teamId = null;
      const errors = await validate(dto);
      expect(errors.length).toBe(0);
    });

    it('fails validation for missing teamId (undefined)', async () => {
      const dto = new UpdateSeasonChampionDto();
      const errors = await validate(dto);
      expect(errors.length).toBeGreaterThan(0);
      expect(errors[0].property).toBe('teamId');
    });

    it('fails validation for non-string type', async () => {
      const dto = new UpdateSeasonChampionDto();
      (dto as any).teamId = 123;
      const errors = await validate(dto);
      expect(errors.length).toBeGreaterThan(0);
    });
  });
});
