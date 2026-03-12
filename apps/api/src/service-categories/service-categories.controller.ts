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

@Controller('service-categories')
@UseGuards(JwtAuthGuard)
export class ServiceCategoriesController {
  constructor(private readonly servicesService: ServicesService) {}

  @Post()
  create(@Req() req: any, @Body() dto: CreateServiceCategoryDto) {
    return this.servicesService.createCategory(req.user.sub, dto);
  }

  @Get()
  list(@Req() req: any, @Query('businessId') businessId: string) {
    return this.servicesService.listCategories(req.user.sub, businessId);
  }

  @Patch(':id')
  update(
    @Req() req: any,
    @Param('id') id: string,
    @Body() dto: UpdateServiceCategoryDto,
  ) {
    return this.servicesService.updateCategory(req.user.sub, id, dto);
  }

  @Delete(':id')
  archive(@Req() req: any, @Param('id') id: string) {
    return this.servicesService.archiveCategory(req.user.sub, id);
  }
}
