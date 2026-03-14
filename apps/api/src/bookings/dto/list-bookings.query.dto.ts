import { IsIn, IsOptional, IsString } from 'class-validator';

export class ListBookingsQueryDto {
  @IsString()
  businessId!: string;

  // Accept either:
  // - absolute ISO (with Z/offset)
  // - local ISO "YYYY-MM-DDTHH:mm" when tz provided
  @IsOptional()
  @IsString()
  from?: string;

  @IsOptional()
  @IsString()
  to?: string;

  @IsOptional()
  @IsString()
  tz?: string;

  @IsOptional()
  @IsString()
  staffId?: string;

  @IsOptional()
  @IsString()
  locationId?: string;

  @IsOptional()
  @IsIn(['PENDING', 'CONFIRMED', 'CANCELLED'])
  status?: 'PENDING' | 'CONFIRMED' | 'CANCELLED';

  @IsOptional()
  @IsString()
  cursor?: string;

  @IsOptional()
  @IsString()
  limit?: string;

  @IsOptional()
  @IsIn(['asc', 'desc'])
  order?: 'asc' | 'desc';
}
