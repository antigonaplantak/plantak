import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Min } from 'class-validator';

export class PaymentRefundDto {
  @IsString()
  businessId!: string;

  @IsOptional()
  @IsString()
  idempotencyKey?: string;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  amountCents!: number;
}
