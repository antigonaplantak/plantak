import { IsIn, IsOptional, IsString } from 'class-validator';

export class ListBookingHistoryQueryDto {
  @IsString()
  businessId!: string;

  @IsOptional()
  @IsIn(['asc', 'desc'])
  order?: 'asc' | 'desc';

  @IsOptional()
  @IsString()
  limit?: string;
}
