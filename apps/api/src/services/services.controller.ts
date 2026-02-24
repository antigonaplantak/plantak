import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { MembershipGuard } from '../common/guards/membership.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { ServicesService } from './services.service';
import { CreateServiceDto } from './dto/create-service.dto';
import { UpdateServiceDto } from './dto/update-service.dto';
import { SetServiceStatusDto } from './dto/set-service-status.dto';

@UseGuards(JwtAuthGuard, MembershipGuard)
@Controller()
export class ServicesController {
  constructor(private svc: ServicesService) {}

  @Roles('OWNER', 'MANAGER')
  @Post('services')
  create(@Req() req: any, @Body() dto: CreateServiceDto) {
    return this.svc.create(req.business.id, dto);
  }

  // includeInactive=true vetëm për OWNER/MANAGER (opsionale – për momentin e lejojmë)
  @Roles('OWNER', 'MANAGER', 'STAFF')
  @Get('services')
  list(@Req() req: any, @Query('includeInactive') includeInactive?: string) {
    return this.svc.list(req.business.id, includeInactive === 'true');
  }

  @Roles('OWNER', 'MANAGER', 'STAFF')
  @Get('services/:serviceId')
  get(@Req() req: any, @Param('serviceId') serviceId: string) {
    return this.svc.get(req.business.id, serviceId);
  }

  @Roles('OWNER', 'MANAGER')
  @Patch('services/:serviceId')
  update(
    @Req() req: any,
    @Param('serviceId') serviceId: string,
    @Body() dto: UpdateServiceDto,
  ) {
    return this.svc.update(req.business.id, serviceId, dto);
  }

  @Roles('OWNER', 'MANAGER')
  @Patch('services/:serviceId/status')
  status(
    @Req() req: any,
    @Param('serviceId') serviceId: string,
    @Body() dto: SetServiceStatusDto,
  ) {
    return this.svc.status(req.business.id, serviceId, dto.isActive);
  }

  // Staff ↔ Services (në hapin tjetër)
  @Roles('OWNER', 'MANAGER')
  @Put('staff/:staffId/services')
  replaceStaffServices(
    @Req() req: any,
    @Param('staffId') staffId: string,
    @Body() body: any,
  ) {
    return this.svc.replaceStaffServices(req.business.id, staffId, body);
  }

  @Roles('OWNER', 'MANAGER', 'STAFF')
  @Get('staff/:staffId/services')
  staffServices(@Req() req: any, @Param('staffId') staffId: string) {
    return this.svc.staffServices(req.business.id, staffId);
  }
}
