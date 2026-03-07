import { IsBoolean, IsInt, IsOptional, IsString, MaxLength } from 'class-validator';

export class CreateServiceDto {
  @IsString()
  businessId!: string;

  @IsOptional()
  @IsString()
  categoryId?: string;

  @IsString()
  @MaxLength(160)
  name!: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsInt()
  durationMin!: number;

  @IsInt()
  priceCents!: number;

  @IsOptional()
  @IsString()
  currency?: string;

  @IsOptional()
  @IsInt()
  bufferBeforeMin?: number;

  @IsOptional()
  @IsInt()
  bufferAfterMin?: number;

  @IsOptional()
  @IsString()
  visibility?: 'PUBLIC' | 'PRIVATE';

  @IsOptional()
  @IsBoolean()
  onlineBookingEnabled?: boolean;

  @IsOptional()
  @IsBoolean()
  isPinned?: boolean;

  @IsOptional()
  @IsInt()
  position?: number;

  @IsOptional()
  @IsString()
  color?: string;
}
