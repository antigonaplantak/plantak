import {
  Body,
  Controller,
  Headers,
  HttpCode,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { ApiBearerAuth, ApiHeader, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { BusinessRoles } from '../common/auth/business-roles.decorator';
import { BusinessRolesGuard } from '../common/auth/business-roles.guard';
import { PaymentsService } from './payments.service';
import { CreatePaymentSessionDto } from './dto/create-payment-session.dto';
import { ReconcileProviderPaymentDto } from './dto/reconcile-provider-payment.dto';
import {
  PAYMENT_PROVIDER_EVENT_TYPES,
  PAYMENT_PROVIDER_NAMES,
} from './payment-provider-contract';

type ReqUser = { sub: string; email: string; role?: string };
type ReqWithUser = Request & { user?: ReqUser };
type ReqWithRawBody = Request & { rawBody?: Buffer | string };

@ApiTags('Payments')
@Controller('payments')
export class PaymentsController {
  constructor(private readonly payments: PaymentsService) {}

  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @Post('bookings/:id/session')
  async createBookingPaymentSession(
    @Req() req: ReqWithUser,
    @Param('id') id: string,
    @Body() dto: CreatePaymentSessionDto,
  ) {
    const actorUserId = String(req.user?.sub ?? '');

    return this.payments.createBookingPaymentSession({
      businessId: dto.businessId,
      bookingId: id,
      actorUserId,
      idempotencyKey: dto.idempotencyKey,
      returnUrl: dto.returnUrl,
      cancelUrl: dto.cancelUrl,
    });
  }

  @UseGuards(JwtAuthGuard, BusinessRolesGuard)
  @ApiBearerAuth()
  @BusinessRoles('OWNER', 'ADMIN', 'STAFF')
  @Post('provider/reconcile')
  @HttpCode(200)
  async reconcileProviderPayment(@Body() dto: ReconcileProviderPaymentDto) {
    return this.payments.reconcileProviderEvent({
      businessId: dto.businessId,
      bookingId: dto.bookingId,
      provider: dto.provider,
      providerEventId: dto.providerEventId,
      eventType: dto.eventType,
      providerSessionRef: dto.providerSessionRef,
      payload: dto.payload ?? {},
    });
  }

  @Post('provider/webhook')
  @HttpCode(200)
  @ApiHeader({
    name: 'x-payment-provider',
    required: true,
    enum: PAYMENT_PROVIDER_NAMES,
  })
  @ApiHeader({
    name: 'x-payment-event-id',
    required: true,
  })
  @ApiHeader({
    name: 'x-payment-event-type',
    required: true,
    enum: PAYMENT_PROVIDER_EVENT_TYPES,
  })
  @ApiHeader({
    name: 'x-payment-signature',
    required: true,
  })
  async providerWebhook(
    @Req() req: ReqWithRawBody,
    @Headers('x-payment-signature') signature: string,
    @Headers('x-payment-provider') provider: string,
    @Headers('x-payment-event-id') providerEventId: string,
    @Headers('x-payment-event-type') eventType: string,
    @Body() body: Record<string, unknown>,
  ) {
    const rawBody =
      typeof req.rawBody === 'string'
        ? req.rawBody
        : Buffer.isBuffer(req.rawBody)
          ? req.rawBody.toString('utf8')
          : JSON.stringify(body ?? {});

    const businessId =
      typeof body.businessId === 'string' ? body.businessId : '';
    const bookingId = typeof body.bookingId === 'string' ? body.bookingId : '';

    return this.payments.processProviderWebhook({
      provider,
      providerEventId,
      eventType,
      signature,
      rawBody,
      businessId,
      bookingId,
      payload: body ?? {},
    });
  }
}
