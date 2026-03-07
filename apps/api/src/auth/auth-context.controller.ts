import {
  Controller,
  Get,
  Query,
  Req,
  UseGuards,
  ForbiddenException,
  BadRequestException,
} from '@nestjs/common';
import type { Request } from 'express';
import { PrismaService } from '../prisma/prisma.service';
import { JwtAuthGuard } from './guards/jwt-auth.guard';

type ReqUser = { sub: string; email: string; role?: string };
type ReqWithUser = Request & { user?: ReqUser };

@Controller('auth')
export class AuthContextController {
  constructor(private prisma: PrismaService) {}

  @UseGuards(JwtAuthGuard)
  @Get('context')
  async context(
    @Req() req: ReqWithUser,
    @Query('businessId') businessId?: string,
  ) {
    const userId = String(req.user?.sub ?? '');
    if (!userId) throw new ForbiddenException('Unauthorized');
    if (!businessId) throw new BadRequestException('businessId required');

    const bm = await this.prisma.businessMember.findUnique({
      where: { businessId_userId: { businessId, userId } },
      select: { role: true },
    });
    if (!bm) throw new ForbiddenException('Not a member of this business');

    const staff = await this.prisma.staff.findFirst({
      where: { businessId, userId },
      select: { id: true },
    });

    return {
      userId,
      email: req.user?.email ?? null,
      businessId,
      businessRole: bm.role,
      staffId: staff?.id ?? null,
    };
  }
}
