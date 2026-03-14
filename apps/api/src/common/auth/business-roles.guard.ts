import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  BadRequestException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Request } from 'express';
import { PrismaService } from '../../prisma/prisma.service';
import { BUSINESS_ROLES_KEY, BusinessRole } from './business-roles.decorator';

type ReqUser = { sub: string; email: string; role?: string };
type ReqWithUser = Request & {
  user?: ReqUser;
  body?: unknown;
  query?: unknown;
  params?: unknown;
};

function readBusinessIdFrom(value: unknown): string | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const v = value as Record<string, unknown>;
  const b = v['businessId'];
  return typeof b === 'string' && b.length > 0 ? b : undefined;
}

function pickBusinessId(req: ReqWithUser): string | undefined {
  return (
    readBusinessIdFrom(req.body) ??
    readBusinessIdFrom(req.query) ??
    readBusinessIdFrom(req.params)
  );
}

@Injectable()
export class BusinessRolesGuard implements CanActivate {
  constructor(
    private reflector: Reflector,
    private prisma: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const required =
      this.reflector.getAllAndOverride<BusinessRole[]>(BUSINESS_ROLES_KEY, [
        context.getHandler(),
        context.getClass(),
      ]) ?? [];

    if (required.length === 0) return true;

    const req = context.switchToHttp().getRequest<ReqWithUser>();
    const userId = String(req.user?.sub ?? '');
    if (!userId) throw new ForbiddenException('Unauthorized');

    const businessId = pickBusinessId(req);
    if (!businessId) throw new BadRequestException('businessId is required');

    const membership = await this.prisma.businessMember.findUnique({
      where: { businessId_userId: { businessId, userId } },
      select: { role: true },
    });

    if (!membership) throw new ForbiddenException('Not a business member');

    if (!required.includes(membership.role as BusinessRole)) {
      throw new ForbiddenException('Insufficient role');
    }

    return true;
  }
}
