import { IsBoolean, IsIn, IsInt, IsOptional, IsString, MaxLength, Min } from 'class-validator';

export class UpdateServiceDto {
  @IsOptional()
  @IsString()
  @MaxLength(120)
  name?: string;

  @IsOptional()
  @IsInt()
  @Min(5)
  durationMin?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  bufferBeforeMin?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  bufferAfterMin?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  priceCents?: number;

  @IsOptional()
  @IsString()
  @IsIn(['EUR', 'CHF', 'GBP', 'USD'])
  currency?: string;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
