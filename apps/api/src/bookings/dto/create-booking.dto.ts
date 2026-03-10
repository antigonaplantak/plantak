import { IsArray, IsISO8601, IsOptional, IsString } from 'class-validator';

export class CreateBookingDto {
  @IsString()
  businessId!: string;

  @IsString()
  staffId!: string;

  @IsString()
  serviceId!: string;

  @IsOptional()
  @IsString()
  variantId?: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  addonIds?: string[];

  @IsOptional()
  @IsISO8601()
  startAt?: string;

  @IsOptional()
  @IsString()
  startLocal?: string;

  @IsOptional()
  @IsString()
  tz?: string;

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
