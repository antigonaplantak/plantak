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
} from "@nestjs/common";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { ServicesService } from "./services.service";
import { CreateServiceDto } from "./dto/create-service.dto";
import { UpdateServiceDto } from "./dto/update-service.dto";
import { SetServiceStatusDto } from "./dto/set-service-status.dto";
import { ReplaceStaffServicesDto } from "./dto/replace-staff-services.dto";

@Controller()
export class ServicesHttpController {
  constructor(private readonly svc: ServicesService) {}

  @Post("services")
  @UseGuards(JwtAuthGuard)
  create(@Req() req: any, @Body() dto: CreateServiceDto) {
    return this.svc.createService(req.user.sub, dto);
  }

  @Get("services")
  @UseGuards(JwtAuthGuard)
  list(@Req() req: any, @Query("businessId") businessId: string) {
    return this.svc.listAdminServices(req.user.sub, businessId);
  }

  @Get("services/:serviceId")
  @UseGuards(JwtAuthGuard)
  getOne(@Req() req: any, @Param("serviceId") serviceId: string) {
    return this.svc.getService(req.user.sub, serviceId);
  }

  @Patch("services/:serviceId")
  @UseGuards(JwtAuthGuard)
  update(@Req() req: any, @Param("serviceId") serviceId: string, @Body() dto: UpdateServiceDto) {
    return this.svc.updateService(req.user.sub, serviceId, dto);
  }

  @Delete("services/:serviceId")
  @UseGuards(JwtAuthGuard)
  archive(@Req() req: any, @Param("serviceId") serviceId: string) {
    return this.svc.archiveService(req.user.sub, serviceId);
  }

  @Patch("services/:serviceId/status")
  @UseGuards(JwtAuthGuard)
  setStatus(@Req() req: any, @Param("serviceId") serviceId: string, @Body() dto: SetServiceStatusDto) {
    return this.svc.setServiceStatus(req.user.sub, serviceId, dto);
  }

  @Put("staff/:staffId/services")
  @UseGuards(JwtAuthGuard)
  replaceStaffServices(
    @Req() req: any,
    @Param("staffId") staffId: string,
    @Body() dto: ReplaceStaffServicesDto,
  ) {
    return this.svc.replaceStaffServices(req.user.sub, staffId, dto);
  }

  @Get("staff/:staffId/services")
  @UseGuards(JwtAuthGuard)
  listStaffServices(
    @Req() req: any,
    @Param("staffId") staffId: string,
    @Query("businessId") businessId: string,
  ) {
    return this.svc.listStaffServices(req.user.sub, staffId, businessId);
  }

  @Get("public/services")
  listPublic(@Query("businessId") businessId: string) {
    return this.svc.listPublicServices(businessId);
  }

  @Get("public/service-categories")
  listPublicCategories(@Query("businessId") businessId: string) {
    return this.svc.listPublicCategories(businessId);
  }
}
