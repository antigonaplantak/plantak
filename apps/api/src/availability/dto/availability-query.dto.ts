import { Transform } from 'class-transformer';
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

function normalizeAddonIds(value: unknown): string[] | undefined {
  if (value === undefined || value === null || value === '') return undefined;

  const raw = Array.isArray(value)
    ? value.flatMap((x) => String(x).split(','))
    : String(value).split(',');

  const ids = [...new Set(raw.map((x) => x.trim()).filter(Boolean))];
  return ids.length ? ids : undefined;
}

export class AvailabilityQueryDto {
  @IsString()
  businessId!: string;

  @IsString()
  serviceId!: string;

  @IsOptional()
  @IsString()
  variantId?: string;

  @IsOptional()
  @Transform(({ value }) => normalizeAddonIds(value))
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
    message: 'tz must be IANA format like Europe/Paris',
  })
  tz?: string;

  @IsOptional()
  @IsIn(['utc'])
  format?: 'utc';
}
