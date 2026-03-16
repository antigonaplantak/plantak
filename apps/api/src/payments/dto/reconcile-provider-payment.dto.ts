import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsObject, IsOptional, IsString } from 'class-validator';

export class ReconcileProviderPaymentDto {
  @ApiProperty()
  @IsString()
  businessId!: string;

  @ApiProperty()
  @IsString()
  bookingId!: string;

  @ApiProperty()
  @IsString()
  provider!: string;

  @ApiProperty()
  @IsString()
  providerEventId!: string;

  @ApiProperty()
  @IsString()
  eventType!: string;

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
