import { Body, Controller, Headers, HttpCode, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import { ApiTags } from '@nestjs/swagger';
import { PaymentsService } from './payments.service';

type ReqWithRawBody = Request & { rawBody?: Buffer | string };

@ApiTags('Payments')
@Controller('payments/provider')
export class PaymentsController {
  constructor(private readonly payments: PaymentsService) {}

  @Post('webhook')
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

    return this.payments.processProviderWebhook({
      provider,
      providerEventId,
      eventType,
      signature,
      rawBody,
      businessId: String(body?.businessId ?? ''),
      bookingId: String(body?.bookingId ?? ''),
      payload: body ?? {},
    });
  }
}
