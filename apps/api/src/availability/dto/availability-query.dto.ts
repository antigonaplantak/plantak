import {
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

  @IsString()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'date must be YYYY-MM-DD' })
  date!: string; // interpreted as LOCAL date in tz

  @IsOptional()
  @IsString()
  staffId?: string;

  @IsOptional()
  @IsInt()
  @Min(5)
  @Max(60)
  intervalMin?: number;

  /**
   * IANA time zone. Example: Europe/Paris
   * Minimal validation to avoid crazy input; we also fallback to Europe/Paris in service.
   */
  @IsOptional()
  @IsString()
  @Matches(/^[A-Za-z_]+\/[A-Za-z_]+$/, {
    message: 'tz must be IANA format like Europe/Paris',
  })
  tz?: string;

  /**
   * Optional: how to return slots (UTC ISO always, UI can render in tz)
   * If you don’t need it, you can remove.
   */
  @IsOptional()
  @IsIn(['utc'])
  format?: 'utc';
}
