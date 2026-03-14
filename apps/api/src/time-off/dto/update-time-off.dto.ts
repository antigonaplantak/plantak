import { PartialType } from '@nestjs/mapped-types';
import { CreateTimeOffDto } from './create-time-off.dto';

export class UpdateTimeOffDto extends PartialType(CreateTimeOffDto) {}
