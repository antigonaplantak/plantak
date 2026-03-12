import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { ApiBearerAuth, ApiQuery, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { TimeOffService } from './time-off.service';
import { CreateTimeOffDto } from './dto/create-time-off.dto';
import { UpdateTimeOffDto } from './dto/update-time-off.dto';

type ReqUser = { sub: string; email: string; role?: string };
type ReqWithUser = Request & { user?: ReqUser };

@ApiTags('TimeOff')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('staff/:staffId/time-off')
export class TimeOffController {
  constructor(private readonly timeOff: TimeOffService) {}

  @Get()
  @ApiQuery({ name: 'businessId', required: true, type: String })
  list(
    @Req() req: ReqWithUser,
    @Param('staffId') staffId: string,
    @Query('businessId') businessId: string,
  ) {
    return this.timeOff.list(String(req.user?.sub ?? ''), staffId, businessId);
  }

  @Post()
  create(
    @Req() req: ReqWithUser,
    @Param('staffId') staffId: string,
    @Body() dto: CreateTimeOffDto,
  ) {
    return this.timeOff.create(String(req.user?.sub ?? ''), staffId, dto);
  }

  @Patch(':timeOffId')
  update(
    @Req() req: ReqWithUser,
    @Param('staffId') staffId: string,
    @Param('timeOffId') timeOffId: string,
    @Body() dto: UpdateTimeOffDto,
  ) {
    return this.timeOff.update(
      String(req.user?.sub ?? ''),
      staffId,
      timeOffId,
      dto,
    );
  }

  @Delete(':timeOffId')
  @ApiQuery({ name: 'businessId', required: true, type: String })
  remove(
    @Req() req: ReqWithUser,
    @Param('staffId') staffId: string,
    @Param('timeOffId') timeOffId: string,
    @Query('businessId') businessId: string,
  ) {
    return this.timeOff.remove(
      String(req.user?.sub ?? ''),
      staffId,
      timeOffId,
      businessId,
    );
  }
}
