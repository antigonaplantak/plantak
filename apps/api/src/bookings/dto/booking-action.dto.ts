import { IsOptional, IsString } from 'class-validator';

export class BookingActionDto {
  @IsString()
  businessId!: string;

  @IsOptional()
  @IsString()
  idempotencyKey?: string;
}
