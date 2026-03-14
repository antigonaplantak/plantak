import {
  Body,
  Controller,
  Delete,
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
import { ServicesService } from './services.service';
import { CreateServiceDto } from './dto/create-service.dto';
import { UpdateServiceDto } from './dto/update-service.dto';
import { SetServiceStatusDto } from './dto/set-service-status.dto';
import { ReplaceStaffServicesDto } from './dto/replace-staff-services.dto';
import type { Request } from 'express';

type ReqUser = { sub?: string; role?: string };
type ReqWithUser = Request & { user?: ReqUser };

@Controller()
export class ServicesHttpController {
  constructor(private readonly svc: ServicesService) {}

  @Post('services')
  @UseGuards(JwtAuthGuard)
  create(@Req() req: ReqWithUser, @Body() dto: CreateServiceDto) {
    return this.svc.createService(String(req.user?.sub ?? ''), dto);
  }

  @Get('services')
  @UseGuards(JwtAuthGuard)
  list(@Req() req: ReqWithUser, @Query('businessId') businessId: string) {
    return this.svc.listAdminServices(String(req.user?.sub ?? ''), businessId);
  }

  @Get('services/:serviceId')
  @UseGuards(JwtAuthGuard)
  getOne(@Req() req: ReqWithUser, @Param('serviceId') serviceId: string) {
    return this.svc.getService(String(req.user?.sub ?? ''), serviceId);
  }

  @Patch('services/:serviceId')
  @UseGuards(JwtAuthGuard)
  update(
    @Req() req: ReqWithUser,
    @Param('serviceId') serviceId: string,
    @Body() dto: UpdateServiceDto,
  ) {
    return this.svc.updateService(String(req.user?.sub ?? ''), serviceId, dto);
  }

  @Delete('services/:serviceId')
  @UseGuards(JwtAuthGuard)
  archive(@Req() req: ReqWithUser, @Param('serviceId') serviceId: string) {
    return this.svc.archiveService(String(req.user?.sub ?? ''), serviceId);
  }

  @Patch('services/:serviceId/status')
  @UseGuards(JwtAuthGuard)
  setStatus(
    @Req() req: ReqWithUser,
    @Param('serviceId') serviceId: string,
    @Body() dto: SetServiceStatusDto,
  ) {
    return this.svc.setServiceStatus(
      String(req.user?.sub ?? ''),
      serviceId,
      dto,
    );
  }

  @Put('staff/:staffId/services')
  @UseGuards(JwtAuthGuard)
  replaceStaffServices(
    @Req() req: ReqWithUser,
    @Param('staffId') staffId: string,
    @Body() dto: ReplaceStaffServicesDto,
  ) {
    return this.svc.replaceStaffServices(
      String(req.user?.sub ?? ''),
      staffId,
      dto,
    );
  }

  @Get('staff/:staffId/services')
  @UseGuards(JwtAuthGuard)
  listStaffServices(
    @Req() req: ReqWithUser,
    @Param('staffId') staffId: string,
    @Query('businessId') businessId: string,
  ) {
    return this.svc.listStaffServices(
      String(req.user?.sub ?? ''),
      staffId,
      businessId,
    );
  }

  @Get('public/services')
  listPublic(@Query('businessId') businessId: string) {
    return this.svc.listPublicServices(businessId);
  }

  @Get('public/service-categories')
  listPublicCategories(@Query('businessId') businessId: string) {
    return this.svc.listPublicCategories(businessId);
  }
}
