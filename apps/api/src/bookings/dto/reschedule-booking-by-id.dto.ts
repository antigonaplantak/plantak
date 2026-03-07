import { IsISO8601, IsOptional, IsString } from 'class-validator';

export class RescheduleBookingByIdDto {
  @IsString()
  businessId!: string;

  // Variant B (absolute ISO with timezone, e.g. ...Z)
  @IsOptional()
  @IsISO8601()
  newStartAt?: string;

  // Variant A (local ISO without timezone)
  @IsOptional()
  @IsString()
  newStartLocal?: string; // "YYYY-MM-DDTHH:mm"

  @IsOptional()
  @IsString()
  tz?: string; // IANA, e.g. "Europe/Paris"

  @IsOptional()
  @IsString()
  idempotencyKey?: string;
}
