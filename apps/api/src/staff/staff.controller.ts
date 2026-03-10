import { Body, Controller, Get, Param, Patch, Query, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { ApiBearerAuth, ApiQuery, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { StaffService } from './staff.service';
import { UpdateStaffProfileDto } from './dto/update-staff-profile.dto';

type ReqUser = { sub: string; email: string; role?: string };
type ReqWithUser = Request & { user?: ReqUser };

@ApiTags('Staff')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('staff')
export class StaffController {
  constructor(private readonly staff: StaffService) {}

  @Get()
  @ApiQuery({ name: 'businessId', required: true, type: String })
  list(@Req() req: ReqWithUser, @Query('businessId') businessId: string) {
    return this.staff.listForBusiness(String(req.user?.sub ?? ''), businessId);
  }

  @Get(':staffId')
  @ApiQuery({ name: 'businessId', required: true, type: String })
  getProfile(
    @Req() req: ReqWithUser,
    @Param('staffId') staffId: string,
    @Query('businessId') businessId: string,
  ) {
    return this.staff.getProfile(String(req.user?.sub ?? ''), staffId, businessId);
  }

  @Patch(':staffId/profile')
  @ApiQuery({ name: 'businessId', required: true, type: String })
  updateProfile(
    @Req() req: ReqWithUser,
    @Param('staffId') staffId: string,
    @Query('businessId') businessId: string,
    @Body() dto: UpdateStaffProfileDto,
  ) {
    return this.staff.updateProfile(String(req.user?.sub ?? ''), staffId, businessId, dto);
  }

  @Get(':staffId/readiness')
  @ApiQuery({ name: 'businessId', required: true, type: String })
  getReadiness(
    @Req() req: ReqWithUser,
    @Param('staffId') staffId: string,
    @Query('businessId') businessId: string,
  ) {
    return this.staff.getReadiness(String(req.user?.sub ?? ''), staffId, businessId);
  }
}
