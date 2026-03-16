import { IsOptional, IsString } from 'class-validator';

export class CreatePaymentSessionDto {
  @IsString()
  businessId!: string;

  @IsOptional()
  @IsString()
  idempotencyKey?: string;

  @IsOptional()
  @IsString()
  returnUrl?: string;

  @IsOptional()
  @IsString()
  cancelUrl?: string;
}
