import { PartialType } from '@nestjs/mapped-types';
import { CreateServiceAddonDto } from './create-service-addon.dto';

export class UpdateServiceAddonDto extends PartialType(CreateServiceAddonDto) {}
