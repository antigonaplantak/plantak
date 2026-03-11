import { Transform } from 'class-transformer';
import { normalizeAddonIds } from '../addon-ids.util';
import {
  IsArray,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  Min,
} from 'class-validator';


export class AvailabilityQueryDto {
  @IsString()
  businessId!: string;

  @IsString()
  serviceId!: string;

  @IsOptional()
  @IsString()
  variantId?: string;

  @IsOptional()
  @Transform(({ value }) => { const ids = normalizeAddonIds(value); return ids.length ? ids : undefined; })
  @IsArray()
  @IsString({ each: true })
  addonIds?: string[];

  @IsString()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'date must be YYYY-MM-DD' })
  date!: string;

  @IsOptional()
  @IsString()
  staffId?: string;

  @IsOptional()
  @IsInt()
  @Min(5)
  @Max(60)
  intervalMin?: number;

  @IsOptional()
  @IsString()
  @Matches(/^[A-Za-z_]+\/[A-Za-z_]+$/, {
    message: 'tz must be a valid IANA timezone like UTC or America/New_York',
  })
  tz?: string;
}
