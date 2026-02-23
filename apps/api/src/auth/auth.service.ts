import { BadRequestException, Injectable, UnauthorizedException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import * as bcrypt from 'bcrypt';
import { JwtService } from '@nestjs/jwt';
import { createHash } from 'crypto';

type AppRole = 'ADMIN' | 'STAFF' | 'CUSTOMER';
type JwtPayload = { sub: string; email: string; role: AppRole };

function sha256(input: string) {
  return createHash('sha256').update(input).digest('hex');
}

@Injectable()
export class AuthService {
  constructor(private prisma: PrismaService, private jwt: JwtService) {}

  private accessSecret = process.env.JWT_ACCESS_SECRET!;
  private refreshSecret = process.env.JWT_REFRESH_SECRET!;
  private accessTtlSeconds = Number(process.env.JWT_ACCESS_TTL_SECONDS ?? 900);
  private refreshTtlSeconds = Number(process.env.JWT_REFRESH_TTL_SECONDS ?? 604800);

  private async audit(actorId: string, action: string, metaJson?: any) {
    try {
      await this.prisma.auditLog.create({
        data: { actorId, action, entity: 'AUTH', entityId: actorId, metaJson },
      });
    } catch {
      // mos e rrëzo auth-in nëse audit dështon
    }
  }

  async register(email: string, password: string) {
    email = email.trim().toLowerCase();
    if (!email || !password || password.length < 8) {
      throw new BadRequestException('Email ose password jo valid (min 8 karaktere).');
    }

    const existing = await this.prisma.user.findUnique({ where: { email } });
    if (existing) throw new BadRequestException('Email ekziston.');

    const passwordHash = await bcrypt.hash(password, 12);
    const user = await this.prisma.user.create({
      data: { email, passwordHash, role: 'CUSTOMER' as any },
      select: { id: true, email: true, role: true, createdAt: true },
    });

    const tokens = await this.issueTokens(user.id, user.email, user.role as AppRole);
    await this.storeRefreshSession(user.id, tokens.refreshToken);
    await this.audit(user.id, 'AUTH_REGISTER', { email });

    return { user, ...tokens };
  }

  async login(email: string, password: string) {
    email = email.trim().toLowerCase();
    const user = await this.prisma.user.findUnique({ where: { email } });
    if (!user) throw new UnauthorizedException('Kredenciale të gabuara.');

    const ok = await bcrypt.compare(password, user.passwordHash);
    if (!ok) {
      await this.audit(user.id, 'AUTH_LOGIN_FAIL', { email });
      throw new UnauthorizedException('Kredenciale të gabuara.');
    }

    const safeUser = { id: user.id, email: user.email, role: user.role, createdAt: user.createdAt };
    const tokens = await this.issueTokens(user.id, user.email, user.role as AppRole);
    await this.storeRefreshSession(user.id, tokens.refreshToken);
    await this.audit(user.id, 'AUTH_LOGIN_SUCCESS', { email });

    return { user: safeUser, ...tokens };
  }

  async refresh(refreshToken: string) {
    if (!refreshToken) throw new UnauthorizedException('Missing refresh token');

    // verify signature/expiry
    let payload: any;
    try {
      payload = await this.jwt.verifyAsync(refreshToken, { secret: this.refreshSecret });
    } catch {
      throw new UnauthorizedException('Invalid refresh token');
    }

    const userId = String(payload.sub);
    const tokenHash = sha256(refreshToken);

    const session = await this.prisma.refreshSession.findFirst({
      where: { userId, tokenHash, revokedAt: null, expiresAt: { gt: new Date() } },
    });

    // REUSE DETECTION:
    // token valid, but no session => someone reused/stealed token or session already rotated/revoked
    if (!session) {
      await this.prisma.refreshSession.updateMany({
        where: { userId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      await this.audit(userId, 'AUTH_REFRESH_REUSE_DETECTED');
      throw new UnauthorizedException('Refresh token revoked/expired');
    }

    // rotate: revoke old
    await this.prisma.refreshSession.update({
      where: { id: session.id },
      data: { revokedAt: new Date() },
    });

    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new UnauthorizedException('User not found');

    const tokens = await this.issueTokens(user.id, user.email, user.role as AppRole);
    await this.storeRefreshSession(user.id, tokens.refreshToken);
    await this.audit(userId, 'AUTH_REFRESH');

    return tokens;
  }

  async revokeAllSessions(userId: string) {
    await this.prisma.refreshSession.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    await this.audit(userId, 'AUTH_REVOKE_ALL_SESSIONS');
    return { ok: true };
  }

  private async storeRefreshSession(userId: string, refreshToken: string) {
    const tokenHash = sha256(refreshToken);
    const expiresAt = new Date(Date.now() + this.refreshTtlSeconds * 1000);

    await this.prisma.refreshSession.create({
      data: { userId, tokenHash, expiresAt },
    });
  }

  private async issueTokens(sub: string, email: string, role: AppRole) {
    if (!this.accessSecret || !this.refreshSecret) {
      throw new Error('JWT secrets mungojnë në .env');
    }

    const payload: JwtPayload = { sub, email, role };

    const accessToken = await this.jwt.signAsync(payload, {
      secret: this.accessSecret,
      expiresIn: this.accessTtlSeconds,
    });

    const refreshToken = await this.jwt.signAsync(payload, {
      secret: this.refreshSecret,
      expiresIn: this.refreshTtlSeconds,
    });

    return { accessToken, refreshToken };
  }
}
