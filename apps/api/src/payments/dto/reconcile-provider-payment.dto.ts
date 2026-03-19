import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsObject, IsOptional, IsString } from 'class-validator';
import type {
  PaymentProviderEventType,
  PaymentProviderName,
} from '../payment-provider-contract';
import {
  PAYMENT_PROVIDER_EVENT_TYPES,
  PAYMENT_PROVIDER_NAMES,
} from '../payment-provider-contract';

export class ReconcileProviderPaymentDto {
  @ApiProperty()
  @IsString()
  businessId!: string;

  @ApiProperty()
  @IsString()
  bookingId!: string;

  @ApiProperty({
    enum: PAYMENT_PROVIDER_NAMES,
  })
  @IsString()
  provider!: PaymentProviderName;

  @ApiProperty()
  @IsString()
  providerEventId!: string;

  @ApiProperty({
    enum: PAYMENT_PROVIDER_EVENT_TYPES,
  })
  @IsString()
  eventType!: PaymentProviderEventType;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  providerSessionRef?: string;

  @ApiPropertyOptional({
    type: 'object',
    additionalProperties: true,
  })
  @IsOptional()
  @IsObject()
  payload?: Record<string, unknown>;
}
