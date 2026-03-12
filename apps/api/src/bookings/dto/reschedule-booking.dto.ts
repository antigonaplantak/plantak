import { IsISO8601, IsOptional, IsString } from 'class-validator';

export class RescheduleBookingDto {
  @IsString()
  businessId!: string;
  @IsOptional()
  @IsString()
  bookingId?: string;
  // Variant B
  @IsOptional()
  @IsISO8601()
  newStartAt?: string;

  // Variant A
  @IsOptional()
  @IsString()
  newStartLocal?: string;

  @IsOptional()
  @IsString()
  tz?: string;

  @IsOptional()
  @IsString()
  idempotencyKey?: string;
}
