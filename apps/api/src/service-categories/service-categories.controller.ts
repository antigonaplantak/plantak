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
import { ServicesService } from '../services/services.service';
import { CreateServiceCategoryDto } from './dto/create-service-category.dto';
import { UpdateServiceCategoryDto } from './dto/update-service-category.dto';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import type { Request } from 'express';

type ReqUser = { sub?: string; role?: string };
type ReqWithUser = Request & { user?: ReqUser };

@Controller('service-categories')
@UseGuards(JwtAuthGuard)
export class ServiceCategoriesController {
  constructor(private readonly servicesService: ServicesService) {}

  @Post()
  create(@Req() req: ReqWithUser, @Body() dto: CreateServiceCategoryDto) {
    return this.servicesService.createCategory(
      String(req.user?.sub ?? ''),
      dto,
    );
  }

  @Get()
  list(@Req() req: ReqWithUser, @Query('businessId') businessId: string) {
    return this.servicesService.listCategories(
      String(req.user?.sub ?? ''),
      businessId,
    );
  }

  @Patch(':id')
  update(
    @Req() req: ReqWithUser,
    @Param('id') id: string,
    @Body() dto: UpdateServiceCategoryDto,
  ) {
    return this.servicesService.updateCategory(
      String(req.user?.sub ?? ''),
      id,
      dto,
    );
  }

  @Delete(':id')
  archive(@Req() req: ReqWithUser, @Param('id') id: string) {
    return this.servicesService.archiveCategory(
      String(req.user?.sub ?? ''),
      id,
    );
  }
}
