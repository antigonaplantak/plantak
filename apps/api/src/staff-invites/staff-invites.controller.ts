import { Body, Controller, Post, Req, UseGuards } from '@nestjs/common';
import { Request } from 'express';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { BusinessRoles } from '../common/auth/business-roles.decorator';
import { BusinessRolesGuard } from '../common/auth/business-roles.guard';
import { CreateStaffInviteDto } from './dto/create-staff-invite.dto';
import { AcceptStaffInviteDto } from './dto/accept-staff-invite.dto';
import { StaffInvitesService } from './staff-invites.service';

type ReqUser = { sub: string; email: string; role?: string };
type ReqWithUser = Request & { user?: ReqUser };

function actorRoleFromJwt(
  req: ReqWithUser,
): 'OWNER' | 'ADMIN' | 'STAFF' | 'CUSTOMER' {
  const r = String(req.user?.role ?? 'CUSTOMER');
  if (r === 'OWNER' || r === 'ADMIN' || r === 'STAFF') return r;
  return 'CUSTOMER';
}

@UseGuards(JwtAuthGuard)
@Controller('staff/invites')
export class StaffInvitesController {
  constructor(private invites: StaffInvitesService) {}

  // OWNER/ADMIN create invite
  @UseGuards(BusinessRolesGuard)
  @BusinessRoles('OWNER', 'ADMIN')
  @Post()
  async create(@Req() req: ReqWithUser, @Body() dto: CreateStaffInviteDto) {
    const actorUserId = String(req.user?.sub ?? '');
    const actorRole = actorRoleFromJwt(req);
    return this.invites.createInvite({
      businessId: dto.businessId,
      staffId: dto.staffId,
      email: dto.email,
      role: (dto.role ?? 'STAFF') as 'OWNER' | 'ADMIN' | 'STAFF',
      actorUserId,
      actorRole:
        actorRole === 'OWNER' || actorRole === 'ADMIN' ? actorRole : 'ADMIN',
    });
  }

  // staff accepts invite (must be logged in)
  @Post('accept')
  async accept(@Req() req: ReqWithUser, @Body() dto: AcceptStaffInviteDto) {
    const actorUserId = String(req.user?.sub ?? '');
    return this.invites.acceptInvite({ token: dto.token, actorUserId });
  }
}
