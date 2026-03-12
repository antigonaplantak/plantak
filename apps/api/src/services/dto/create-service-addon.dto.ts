import {
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';

export class CreateServiceAddonDto {
  @IsString()
  @MaxLength(160)
  name!: string;

  @IsOptional()
  @IsInt()
  durationMin?: number;

  @IsInt()
  priceCents!: number;

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
  @IsInt()
  position?: number;
}
