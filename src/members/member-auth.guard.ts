import { Injectable } from '@nestjs/common';
import { AuthGuard, PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { ConfigService } from '@nestjs/config';
import { MemberService } from './member.service';

@Injectable()
export class MemberJwtStrategy extends PassportStrategy(Strategy, 'member-jwt') {
  constructor(
    config: ConfigService,
    private readonly members: MemberService,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey:
        config.get<string>('MEMBER_JWT_SECRET') ||
        config.get<string>('JWT_SECRET', 'local-development-secret-change-me'),
      audience: 'member',
      algorithms: ['HS256'],
    });
  }
  validate(payload: any) {
    return this.members.validate(payload);
  }
}
@Injectable()
export class MemberAuthGuard extends AuthGuard('member-jwt') {}
@Injectable()
export class OptionalMemberAuthGuard extends AuthGuard('member-jwt') {
  handleRequest(_err: any, user: any) {
    return user || null;
  }
}
