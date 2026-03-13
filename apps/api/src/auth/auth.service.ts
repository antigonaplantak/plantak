import {
  BadRequestException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { PrismaService } from '../prisma/prisma.service';
import { Role } from '@prisma/client';
import * as bcrypt from 'bcryptjs';
import crypto from 'crypto';

type AppRole = Role;

type Tokens = { accessToken: string; refreshToken: string };
type AuthResult = {
  user: { id: string; email: string; role: AppRole; createdAt: Date };
  accessToken: string;
  refreshToken: string;
};

type JwtPayload = { sub: string; email: string; role: AppRole };

function normEmail(email: string): string {
  return String(email || '')
    .trim()
    .toLowerCase();
}

function sha256(input: string): string {
  return crypto.createHash('sha256').update(input).digest('hex');
}

function envInt(name: string, fallback: number): number {
  const v = parseInt(String(process.env[name] ?? ''), 10);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

@Injectable()
export class AuthService {
  private readonly accessSecret: string;
  private readonly refreshSecret: string;
  private readonly accessTtlSeconds: number;
  private readonly refreshTtlSeconds: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
  ) {
    this.accessSecret =
      process.env.JWT_ACCESS_SECRET ??
      process.env.JWT_SECRET ??
      process.env.JWT_SECRET_KEY ??
      '';
    this.refreshSecret =
      process.env.JWT_REFRESH_SECRET ??
      process.env.JWT_SECRET ??
      process.env.JWT_SECRET_KEY ??
      '';

    this.accessTtlSeconds = envInt('JWT_ACCESS_TTL_SECONDS', 15 * 60); // 15m
    this.refreshTtlSeconds = envInt(
      'JWT_REFRESH_TTL_SECONDS',
      7 * 24 * 60 * 60,
    ); // 7d

    if (!this.accessSecret || !this.refreshSecret) {
      throw new Error(
        'JWT secrets missing (set JWT_ACCESS_SECRET + JWT_REFRESH_SECRET)',
      );
    }
  }

  private async issueTokens(
    sub: string,
    email: string,
    role: AppRole,
  ): Promise<Tokens> {
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

  private async storeRefreshSession(
    userId: string,
    refreshToken: string,
  ): Promise<void> {
    const tokenHash = sha256(refreshToken);
    const expiresAt = new Date(Date.now() + this.refreshTtlSeconds * 1000);

    // assumes RefreshSession model exists with these fields (typical)
    await this.prisma.refreshSession.create({
      data: {
        userId,
        tokenHash,
        expiresAt,
      },
    });
  }

  async register(email: string, password: string): Promise<AuthResult> {
    const e = normEmail(email);
    if (!e || !password || password.length < 8) {
      throw new BadRequestException('Invalid email or password');
    }

    const existing = await this.prisma.user.findUnique({ where: { email: e } });
    if (existing) throw new BadRequestException('Email already used');

    const passwordHash = await bcrypt.hash(password, 12);

    const user = await this.prisma.user.create({
      data: {
        email: e,
        passwordHash,
        role: 'CUSTOMER',
      },
      select: { id: true, email: true, role: true, createdAt: true },
    });

    const tokens = await this.issueTokens(user.id, user.email, user.role);
    await this.storeRefreshSession(user.id, tokens.refreshToken);

    return { user, ...tokens };
  }

  async login(email: string, password: string): Promise<AuthResult> {
    const e = normEmail(email);
    const user = await this.prisma.user.findUnique({
      where: { email: e },
      select: {
        id: true,
        email: true,
        role: true,
        createdAt: true,
        passwordHash: true,
      },
    });

    if (!user || !user.passwordHash)
      throw new UnauthorizedException('Invalid credentials');

    const ok = await bcrypt.compare(password, user.passwordHash);
    if (!ok) throw new UnauthorizedException('Invalid credentials');

    const tokens = await this.issueTokens(user.id, user.email, user.role);
    await this.storeRefreshSession(user.id, tokens.refreshToken);

    return {
      user: {
        id: user.id,
        email: user.email,
        role: user.role,
        createdAt: user.createdAt,
      },
      ...tokens,
    };
  }

  async refresh(refreshToken: string): Promise<Tokens> {
    if (!refreshToken) throw new UnauthorizedException('Missing refresh token');

    let payload: JwtPayload;
    try {
      payload = await this.jwt.verifyAsync<JwtPayload>(refreshToken, {
        secret: this.refreshSecret,
      });
    } catch {
      throw new UnauthorizedException('Invalid refresh token');
    }

    const tokenHash = sha256(refreshToken);

    const session = await this.prisma.refreshSession.findFirst({
      where: {
        userId: payload.sub,
        tokenHash,
        revokedAt: null,
        expiresAt: { gt: new Date() },
      },
      select: { id: true, userId: true },
    });

    if (!session) throw new UnauthorizedException('Refresh session not found');

    // rotate: revoke old and issue new
    await this.prisma.refreshSession.update({
      where: { id: session.id },
      data: { revokedAt: new Date() },
    });

    const user = await this.prisma.user.findUnique({
      where: { id: payload.sub },
      select: { id: true, email: true, role: true },
    });
    if (!user) throw new UnauthorizedException('User not found');

    const tokens = await this.issueTokens(user.id, user.email, user.role);
    await this.storeRefreshSession(user.id, tokens.refreshToken);

    return tokens;
  }

  async revokeAllSessions(userId: string): Promise<{ ok: true }> {
    await this.prisma.refreshSession.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    return { ok: true };
  }

  /**
   * Magic auth uses this: returns { user, accessToken, refreshToken }
   */
  async issueTokensForUser(userId: string): Promise<AuthResult> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, email: true, role: true, createdAt: true },
    });
    if (!user) throw new UnauthorizedException('User not found');

    const tokens = await this.issueTokens(user.id, user.email, user.role);
    await this.storeRefreshSession(user.id, tokens.refreshToken);

    return { user, ...tokens };
  }

  /**
   * Context për UI (role në business + staffId)
   */
  async getContext(input: { userId: string; businessId: string }): Promise<{
    userId: string;
    email: string;
    appRole: AppRole;
    businessRole: 'OWNER' | 'ADMIN' | 'STAFF' | null;
    staffId: string | null;
  }> {
    const businessId = String(input.businessId || '');
    const userId = String(input.userId || '');

    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, email: true, role: true },
    });
    if (!user) throw new UnauthorizedException('User not found');

    const bm = await this.prisma.businessMember.findUnique({
      where: { businessId_userId: { businessId, userId } },
      select: { role: true },
    });

    const staff = await this.prisma.staff.findFirst({
      where: { businessId, userId },
      select: { id: true },
    });

    return {
      userId: user.id,
      email: user.email,
      appRole: user.role,
      businessRole: bm ? (bm.role as 'OWNER' | 'ADMIN' | 'STAFF') : null,
      staffId: staff ? staff.id : null,
    };
  }
}
