import {
  BadRequestException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import crypto from 'crypto';

function normalizeEmail(email: string): string {
  return String(email ?? '')
    .trim()
    .toLowerCase();
}
function gen6Digits(): string {
  return String(Math.floor(100000 + Math.random() * 900000));
}
function sha256Hex(input: string): string {
  return crypto.createHash('sha256').update(input).digest('hex');
}
function isProd(): boolean {
  return (process.env.NODE_ENV ?? 'development') === 'production';
}

@Injectable()
export class MagicAuthService {
  constructor(private prisma: PrismaService) {}

  private pepper(): string {
    const pep = process.env.AUTH_CODE_PEPPER ?? '';
    if (!pep) throw new Error('AUTH_CODE_PEPPER missing in .env');
    return pep;
  }

  private codeHash(email: string, code: string): string {
    return sha256Hex(`${normalizeEmail(email)}|${code}|${this.pepper()}`);
  }

  async requestLoginCode(input: {
    email: string;
    ip?: string;
    userAgent?: string;
  }): Promise<{ ok: true; devCode?: string; expiresAt: string }> {
    const email = normalizeEmail(input.email);
    if (!email || !email.includes('@'))
      throw new BadRequestException('Email invalid');

    const expiresAt = new Date(Date.now() + 10 * 60_000);

    const code = gen6Digits();
    const codeHash = this.codeHash(email, code);

    // cleanup expired pending codes (optional)
    await this.prisma.loginCode.updateMany({
      where: {
        email,
        purpose: 'LOGIN',
        usedAt: null,
        expiresAt: { lt: new Date() },
      },
      data: { usedAt: new Date() },
    });

    await this.prisma.loginCode.create({
      data: {
        email,
        codeHash,
        purpose: 'LOGIN',
        expiresAt,
        usedAt: null,
        attempts: 0,
        ip: input.ip ?? null,
        userAgent: input.userAgent ?? null,
      },
      select: { id: true },
    });

    if (!isProd()) {
      console.log(
        `[MAGIC DEV CODE] ${email} => ${code} (exp ${expiresAt.toISOString()})`,
      );
      return { ok: true, devCode: code, expiresAt: expiresAt.toISOString() };
    }

    return { ok: true, expiresAt: expiresAt.toISOString() };
  }

  async verifyLoginCode(input: {
    email: string;
    code: string;
    ip?: string;
    userAgent?: string;
  }): Promise<{ id: string; email: string; role: string }> {
    const email = normalizeEmail(input.email);
    const code = String(input.code ?? '').trim();

    if (!email || !email.includes('@'))
      throw new BadRequestException('Email invalid');
    if (!/^\d{6}$/.test(code)) throw new BadRequestException('Code invalid');

    const now = new Date();

    const row = await this.prisma.loginCode.findFirst({
      where: {
        email,
        purpose: 'LOGIN',
        usedAt: null,
        expiresAt: { gt: now },
      },
      orderBy: { createdAt: 'desc' },
      select: { id: true, codeHash: true, attempts: true },
    });

    if (!row) throw new UnauthorizedException('Invalid or expired code');

    if (row.attempts >= 5) {
      await this.prisma.loginCode.update({
        where: { id: row.id },
        data: { usedAt: now },
      });
      throw new UnauthorizedException('Too many attempts');
    }

    const expected = this.codeHash(email, code);
    if (expected !== row.codeHash) {
      await this.prisma.loginCode.update({
        where: { id: row.id },
        data: { attempts: { increment: 1 } },
      });
      throw new UnauthorizedException('Invalid or expired code');
    }

    // consume code
    await this.prisma.loginCode.update({
      where: { id: row.id },
      data: { usedAt: now },
    });

    // ✅ ensure user exists (no NULL passwordHash problems)
    const existing = await this.prisma.user.findUnique({
      where: { email },
      select: { id: true, email: true, role: true },
    });

    if (existing) {
      return {
        id: existing.id,
        email: existing.email,
        role: String(existing.role),
      };
    }

    const random = crypto.randomBytes(32).toString('hex');
    const created = await this.prisma.user.create({
      data: {
        email,
        // IMPORTANT: avoid null. works even if you still support password login.
        passwordHash: `MAGIC:${random}`,
        role: 'CUSTOMER',
        // if you have required "name" field, this helps:
      },
      select: { id: true, email: true, role: true },
    });

    return { id: created.id, email: created.email, role: String(created.role) };
  }
}
