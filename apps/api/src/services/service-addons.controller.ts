import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { ServiceAddonsService } from './service-addons.service';
import { CreateServiceAddonDto } from './dto/create-service-addon.dto';
import { UpdateServiceAddonDto } from './dto/update-service-addon.dto';

@Controller('services/:serviceId/addons')
@UseGuards(JwtAuthGuard)
export class ServiceAddonsController {
  constructor(private readonly svc: ServiceAddonsService) {}

  @Post()
  create(
    @Req() req: any,
    @Param('serviceId') serviceId: string,
    @Body() dto: CreateServiceAddonDto,
  ) {
    return this.svc.create(req.user.sub, serviceId, dto);
  }

  @Get()
  list(@Req() req: any, @Param('serviceId') serviceId: string) {
    return this.svc.list(req.user.sub, serviceId);
  }

  @Patch(':addonId')
  update(
    @Req() req: any,
    @Param('serviceId') serviceId: string,
    @Param('addonId') addonId: string,
    @Body() dto: UpdateServiceAddonDto,
  ) {
    return this.svc.update(req.user.sub, serviceId, addonId, dto);
  }

  @Delete(':addonId')
  archive(
    @Req() req: any,
    @Param('serviceId') serviceId: string,
    @Param('addonId') addonId: string,
  ) {
    return this.svc.archive(req.user.sub, serviceId, addonId);
  }
}
