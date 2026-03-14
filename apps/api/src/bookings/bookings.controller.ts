import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { BookingsService } from './bookings.service';
import { CreateBookingDto } from './dto/create-booking.dto';
import { RescheduleBookingDto } from './dto/reschedule-booking.dto';
import { RescheduleBookingByIdDto } from './dto/reschedule-booking-by-id.dto';
import { ListBookingsQueryDto } from './dto/list-bookings.query.dto';
import { ListBookingHistoryQueryDto } from './dto/list-booking-history.query.dto';
import { BookingActionDto } from './dto/booking-action.dto';
import { ApiBearerAuth, ApiQuery, ApiTags } from '@nestjs/swagger';
import { BusinessRoles } from '../common/auth/business-roles.decorator';
import { BusinessRolesGuard } from '../common/auth/business-roles.guard';

type ReqUser = { sub: string; email: string; role?: string };
type ReqWithUser = Request & { user?: ReqUser };

function actorRoleFromJwt(
  req: ReqWithUser,
): 'OWNER' | 'ADMIN' | 'STAFF' | 'CUSTOMER' {
  const r = String(req.user?.role ?? 'CUSTOMER').toUpperCase();

  if (r === 'OWNER' || r === 'ADMIN' || r === 'STAFF') {
    return r;
  }

  return 'CUSTOMER';
}

@ApiTags('Bookings')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('bookings')
export class BookingsController {
  constructor(private readonly bookings: BookingsService) {}

  @Post()
  async create(@Req() req: ReqWithUser, @Body() dto: CreateBookingDto) {
    const actorUserId = String(req.user?.sub ?? '');
    const actorRole = actorRoleFromJwt(req);

    return this.bookings.create({
      businessId: dto.businessId,
      customerId: actorUserId,
      staffId: dto.staffId,
      serviceId: dto.serviceId,
      variantId: dto.variantId,
      addonIds: dto.addonIds,
      startAt: dto.startAt,
      startLocal: dto.startLocal,
      tz: dto.tz,
      notes: dto.notes,
      locationId: dto.locationId,
      actorUserId,
      actorRole,
      idempotencyKey: dto.idempotencyKey,
    });
  }

  @Post('reschedule')
  rescheduleLegacy(@Body() dto: RescheduleBookingDto, @Req() req: ReqWithUser) {
    return this.bookings.reschedule({
      ...(dto ?? {}),
      bookingId: String(dto?.bookingId || ''),
      actorUserId: String(req.user?.sub ?? ''),
      actorRole: actorRoleFromJwt(req),
    });
  }

  @Post(':id/reschedule')
  rescheduleById(
    @Param('id') id: string,
    @Body() dto: RescheduleBookingByIdDto,
    @Req() req: ReqWithUser,
  ) {
    return this.bookings.reschedule({
      ...(dto ?? {}),
      bookingId: id,
      actorUserId: String(req.user?.sub ?? ''),
      actorRole: actorRoleFromJwt(req),
    });
  }

  @Get()
  @ApiQuery({ name: 'businessId', required: true, type: String })
  @ApiQuery({ name: 'from', required: false, type: String })
  @ApiQuery({ name: 'to', required: false, type: String })
  @ApiQuery({ name: 'tz', required: false, type: String })
  @ApiQuery({ name: 'staffId', required: false, type: String })
  @ApiQuery({ name: 'locationId', required: false, type: String })
  @ApiQuery({
    name: 'status',
    required: false,
    enum: ['PENDING', 'CONFIRMED', 'CANCELLED'],
  })
  @ApiQuery({ name: 'cursor', required: false, type: String })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  @ApiQuery({ name: 'order', required: false, enum: ['asc', 'desc'] })
  async list(@Req() req: ReqWithUser, @Query() q: ListBookingsQueryDto) {
    const actorUserId = String(req.user?.sub ?? '');
    const limit = q.limit
      ? Math.max(1, Math.min(200, parseInt(q.limit, 10) || 50))
      : 50;
    const order = q.order ?? 'asc';

    return this.bookings.list({
      businessId: q.businessId,
      actorUserId,
      from: q.from,
      to: q.to,
      tz: q.tz,
      staffId: q.staffId,
      locationId: q.locationId,
      status: q.status,
      cursor: q.cursor,
      limit,
      order,
    });
  }

  @Get('calendar')
  async calendar(@Req() req: ReqWithUser, @Query() q: ListBookingsQueryDto) {
    const actorUserId = String(req.user?.sub ?? '');
    const limit = q.limit
      ? Math.max(1, Math.min(500, parseInt(q.limit, 10) || 200))
      : 200;
    const order = q.order ?? 'asc';

    return this.bookings.calendar({
      businessId: q.businessId,
      actorUserId,
      from: q.from,
      to: q.to,
      tz: q.tz,
      staffId: q.staffId,
      locationId: q.locationId,
      status: q.status,
      limit,
      order,
    });
  }

  @Get(':id/history')
  async history(
    @Req() req: ReqWithUser,
    @Param('id') id: string,
    @Query() q: ListBookingHistoryQueryDto,
  ) {
    const actorUserId = String(req.user?.sub ?? '');
    const limit = q.limit
      ? Math.max(1, Math.min(200, parseInt(q.limit, 10) || 50))
      : 50;
    const order = q.order ?? 'asc';

    return this.bookings.history({
      businessId: q.businessId,
      bookingId: id,
      actorUserId,
      limit,
      order,
    });
  }

  @Post(':id/cancel')
  async cancel(
    @Req() req: ReqWithUser,
    @Param('id') id: string,
    @Body() dto: BookingActionDto,
  ) {
    const actorUserId = String(req.user?.sub ?? '');
    const actorRole = actorRoleFromJwt(req);

    return this.bookings.cancel({
      businessId: dto.businessId,
      bookingId: id,
      actorUserId,
      actorRole,
      idempotencyKey: dto.idempotencyKey,
    });
  }

  @UseGuards(JwtAuthGuard, BusinessRolesGuard)
  @BusinessRoles('OWNER', 'ADMIN', 'STAFF')
  @Post(':id/confirm')
  async confirm(
    @Req() req: ReqWithUser,
    @Param('id') id: string,
    @Body() dto: BookingActionDto,
  ) {
    const actorUserId = String(req.user?.sub ?? '');
    const actorRole = actorRoleFromJwt(req);

    return this.bookings.confirm({
      businessId: dto.businessId,
      bookingId: id,
      actorUserId,
      actorRole,
      idempotencyKey: dto.idempotencyKey,
    });
  }


  @UseGuards(JwtAuthGuard, BusinessRolesGuard)
  @BusinessRoles('OWNER', 'ADMIN', 'STAFF')
  @Post(':id/deposit-paid')
  async markDepositPaid(
    @Req() req: ReqWithUser,
    @Param('id') id: string,
    @Body() dto: BookingActionDto,
  ) {
    const actorUserId = String(req.user?.sub ?? '');
    const actorRole = actorRoleFromJwt(req);
    return this.bookings.markDepositPaid({
      businessId: dto.businessId,
      bookingId: id,
      actorUserId,
      actorRole,
      idempotencyKey: dto.idempotencyKey,
    });
  }



  @UseGuards(JwtAuthGuard, BusinessRolesGuard)
  @BusinessRoles('OWNER', 'ADMIN', 'STAFF')
  @Post(':id/deposit-expire')
  async expirePendingDeposit(
    @Req() req: ReqWithUser,
    @Param('id') id: string,
    @Body() dto: BookingActionDto,
  ) {
    const actorUserId = String(req.user?.sub ?? '');
    const actorRole = actorRoleFromJwt(req);
    return this.bookings.expirePendingDeposit({
      businessId: dto.businessId,
      bookingId: id,
      actorUserId,
      actorRole,
      idempotencyKey: dto.idempotencyKey,
    });
  }



  @UseGuards(JwtAuthGuard, BusinessRolesGuard)
  @BusinessRoles('OWNER', 'ADMIN', 'STAFF')
  @Post(':id/payment-settle')
  async settlePayment(
    @Req() req: ReqWithUser,
    @Param('id') id: string,
    @Body() dto: BookingActionDto,
  ) {
    const actorUserId = String(req.user?.sub ?? '');
    const actorRole = actorRoleFromJwt(req);
    return this.bookings.settlePayment({
      businessId: dto.businessId,
      bookingId: id,
      actorUserId,
      actorRole,
      idempotencyKey: dto.idempotencyKey,
    });
  }

}
