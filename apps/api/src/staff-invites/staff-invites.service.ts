import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import crypto from 'crypto';
import { PrismaService } from '../prisma/prisma.service';

function sha256Hex(input: string): string {
  return crypto.createHash('sha256').update(input).digest('hex');
}
function randomToken(): string {
  return crypto.randomBytes(32).toString('hex'); // 64 chars
}

@Injectable()
export class StaffInvitesService {
  constructor(private prisma: PrismaService) {}

  private invitePepper(): string {
    return process.env.INVITE_TOKEN_PEPPER ?? '';
  }

  private hashToken(token: string): string {
    const pep = this.invitePepper();
    if (!pep) throw new Error('INVITE_TOKEN_PEPPER missing');
    return sha256Hex(`${token}|${pep}`);
  }

  async createInvite(input: {
    businessId: string;
    staffId: string;
    email: string;
    role: 'OWNER' | 'ADMIN' | 'STAFF';
    actorUserId: string;
    actorRole: 'OWNER' | 'ADMIN';
  }) {
    if (!(input.actorRole === 'OWNER' || input.actorRole === 'ADMIN')) {
      throw new ForbiddenException('Only OWNER/ADMIN can invite staff');
    }

    const staff = await this.prisma.staff.findFirst({
      where: { id: input.staffId, businessId: input.businessId },
      select: { id: true, businessId: true, userId: true },
    });
    if (!staff) throw new NotFoundException('Staff not found');

    // if already linked, no need invite
    if (staff.userId) {
      throw new BadRequestException('Staff already linked to a user');
    }

    // one active invite per staff
    const existing = await this.prisma.staffInvite.findFirst({
      where: {
        businessId: input.businessId,
        staffId: input.staffId,
        acceptedAt: null,
        expiresAt: { gt: new Date() },
      },
      select: { id: true },
    });
    if (existing) {
      throw new BadRequestException(
        'Active invite already exists for this staff',
      );
    }

    const token = randomToken();
    const tokenHash = this.hashToken(token);
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60_000); // 7 days

    const invite = await this.prisma.staffInvite.create({
      data: {
        businessId: input.businessId,
        staffId: input.staffId,
        email: input.email.trim().toLowerCase(),
        role: input.role,
        tokenHash,
        expiresAt,
        createdByUserId: input.actorUserId,
      },
      select: {
        id: true,
        businessId: true,
        staffId: true,
        email: true,
        role: true,
        expiresAt: true,
        createdAt: true,
      },
    });

    const baseUrl = process.env.PUBLIC_APP_URL ?? 'http://localhost:3000';
    const inviteLink = `${baseUrl}/invite?token=${token}`;

    const isProd = (process.env.NODE_ENV ?? '').toLowerCase() === 'production';
    return {
      invite,
      inviteLink,
      ...(isProd ? {} : { devToken: token }),
    };
  }

  async acceptInvite(input: { token: string; actorUserId: string }) {
    const tokenHash = this.hashToken(input.token);

    const invite = await this.prisma.staffInvite.findFirst({
      where: {
        tokenHash,
        acceptedAt: null,
        expiresAt: { gt: new Date() },
      },
      select: {
        id: true,
        businessId: true,
        staffId: true,
        role: true,
      },
    });

    if (!invite) {
      throw new BadRequestException('Invalid or expired invite');
    }

    return this.prisma.$transaction(async (tx) => {
      // link staff -> user (only if empty)
      const staff = await tx.staff.findFirst({
        where: { id: invite.staffId, businessId: invite.businessId },
        select: { id: true, userId: true },
      });
      if (!staff) throw new NotFoundException('Staff not found');
      if (staff.userId && staff.userId !== input.actorUserId) {
        throw new BadRequestException('Staff already linked');
      }

      await tx.staff.update({
        where: { id: invite.staffId },
        data: { userId: input.actorUserId },
        select: { id: true },
      });

      // upsert business membership
      await tx.businessMember.upsert({
        where: {
          businessId_userId: {
            businessId: invite.businessId,
            userId: input.actorUserId,
          },
        },
        update: { role: invite.role },
        create: {
          businessId: invite.businessId,
          userId: input.actorUserId,
          role: invite.role,
        },
        select: { id: true },
      });

      const accepted = await tx.staffInvite.update({
        where: { id: invite.id },
        data: {
          acceptedAt: new Date(),
          acceptedByUserId: input.actorUserId,
        },
        select: {
          id: true,
          businessId: true,
          staffId: true,
          role: true,
          acceptedAt: true,
        },
      });

      return { ok: true, accepted };
    });
  }
}
