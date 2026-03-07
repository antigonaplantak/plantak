import { IsIn, IsOptional, IsString } from 'class-validator';

export class CalendarBookingsQueryDto {
  @IsString()
  businessId!: string;

  @IsOptional()
  @IsString()
  from?: string; // ISO

  @IsOptional()
  @IsString()
  to?: string; // ISO

  @IsOptional()
  @IsString()
  tz?: string; // IANA

  @IsOptional()
  @IsString()
  staffId?: string; // optional filter (will be ignored for STAFF)

  @IsOptional()
  @IsString()
  locationId?: string;

  @IsOptional()
  @IsString()
  status?: 'PENDING' | 'CONFIRMED' | 'CANCELLED';

  @IsOptional()
  @IsIn(['asc', 'desc'])
  order?: 'asc' | 'desc';

  @IsOptional()
  @IsString()
  cursor?: string;

  @IsOptional()
  @IsString()
  limit?: string; // number as string
}
