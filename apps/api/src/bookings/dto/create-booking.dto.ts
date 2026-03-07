import { IsISO8601, IsOptional, IsString } from 'class-validator';

export class CreateBookingDto {
  @IsString()
  businessId!: string;

  @IsString()
  staffId!: string;

  @IsString()
  serviceId!: string;

  // Variant B (absolute ISO with timezone, e.g. ...Z)
  @IsOptional()
  @IsISO8601()
  startAt?: string;

  // Variant A (local ISO without timezone)
  @IsOptional()
  @IsString()
  startLocal?: string; // "YYYY-MM-DDTHH:mm"

  @IsOptional()
  @IsString()
  tz?: string; // IANA, e.g. "Europe/Paris"

  @IsOptional()
  @IsString()
  idempotencyKey?: string;

  @IsOptional()
  @IsString()
  notes?: string;

  @IsOptional()
  @IsString()
  locationId?: string;
}
