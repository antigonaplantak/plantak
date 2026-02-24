import {
  Body,
  Controller,
  Get,
  Headers,
  Param,
  Patch,
  Post,
  Put,
  Query,
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

  private businessIdFromHeader(xBusinessId: string | undefined): string {
    return String(xBusinessId ?? '');
  }

  @Roles('OWNER', 'MANAGER')
  @Post('services')
  create(
    @Headers('x-business-id') xBusinessId: string | undefined,
    @Body() dto: CreateServiceDto,
  ) {
    return this.svc.create(this.businessIdFromHeader(xBusinessId), dto);
  }

  @Roles('OWNER', 'MANAGER', 'STAFF')
  @Get('services')
  list(
    @Headers('x-business-id') xBusinessId: string | undefined,
    @Query('includeInactive') includeInactive?: string,
  ) {
    return this.svc.list(
      this.businessIdFromHeader(xBusinessId),
      includeInactive === 'true',
    );
  }

  @Roles('OWNER', 'MANAGER', 'STAFF')
  @Get('services/:serviceId')
  get(
    @Headers('x-business-id') xBusinessId: string | undefined,
    @Param('serviceId') serviceId: string,
  ) {
    return this.svc.get(this.businessIdFromHeader(xBusinessId), serviceId);
  }

  @Roles('OWNER', 'MANAGER')
  @Patch('services/:serviceId')
  update(
    @Headers('x-business-id') xBusinessId: string | undefined,
    @Param('serviceId') serviceId: string,
    @Body() dto: UpdateServiceDto,
  ) {
    return this.svc.update(
      this.businessIdFromHeader(xBusinessId),
      serviceId,
      dto,
    );
  }

  @Roles('OWNER', 'MANAGER')
  @Patch('services/:serviceId/status')
  status(
    @Headers('x-business-id') xBusinessId: string | undefined,
    @Param('serviceId') serviceId: string,
    @Body() dto: SetServiceStatusDto,
  ) {
    return this.svc.status(
      this.businessIdFromHeader(xBusinessId),
      serviceId,
      dto.isActive,
    );
  }

  @Roles('OWNER', 'MANAGER')
  @Put('staff/:staffId/services')
  replaceStaffServices(
    @Headers('x-business-id') xBusinessId: string | undefined,
    @Param('staffId') staffId: string,
    @Body() body: unknown,
  ) {
    return this.svc.replaceStaffServices(
      this.businessIdFromHeader(xBusinessId),
      staffId,
      body as any,
    );
  }

  @Roles('OWNER', 'MANAGER', 'STAFF')
  @Get('staff/:staffId/services')
  staffServices(
    @Headers('x-business-id') xBusinessId: string | undefined,
    @Param('staffId') staffId: string,
  ) {
    return this.svc.staffServices(
      this.businessIdFromHeader(xBusinessId),
      staffId,
    );
  }
}
