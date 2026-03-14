import {
  Body,
  Controller,
  Get,
  Param,
  Put,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { ApiBearerAuth, ApiQuery, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { WorkingHoursService } from './working-hours.service';
import { ReplaceWorkingHoursDto } from './dto/replace-working-hours.dto';

type ReqUser = { sub: string; email: string; role?: string };
type ReqWithUser = Request & { user?: ReqUser };

@ApiTags('WorkingHours')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('staff/:staffId/working-hours')
export class WorkingHoursController {
  constructor(private readonly workingHours: WorkingHoursService) {}

  @Get()
  @ApiQuery({ name: 'businessId', required: true, type: String })
  list(
    @Req() req: ReqWithUser,
    @Param('staffId') staffId: string,
    @Query('businessId') businessId: string,
  ) {
    return this.workingHours.list(
      String(req.user?.sub ?? ''),
      staffId,
      businessId,
    );
  }

  @Put()
  replace(
    @Req() req: ReqWithUser,
    @Param('staffId') staffId: string,
    @Body() dto: ReplaceWorkingHoursDto,
  ) {
    return this.workingHours.replace(String(req.user?.sub ?? ''), staffId, dto);
  }
}
