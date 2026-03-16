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
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PaymentsService } from './payments.service';
import { CreatePaymentSessionDto } from './dto/create-payment-session.dto';

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

  @Post('provider/webhook')
  @HttpCode(200)
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
