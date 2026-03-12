import { PartialType } from '@nestjs/mapped-types';
import { CreateServiceVariantDto } from './create-service-variant.dto';

export class UpdateServiceVariantDto extends PartialType(
  CreateServiceVariantDto,
) {}
