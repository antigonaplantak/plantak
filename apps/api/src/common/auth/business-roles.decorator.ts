import { SetMetadata } from '@nestjs/common';

export type BusinessRole = 'OWNER' | 'ADMIN' | 'STAFF';

export const BUSINESS_ROLES_KEY = 'business_roles';
export const BusinessRoles = (...roles: BusinessRole[]) =>
  SetMetadata(BUSINESS_ROLES_KEY, roles);
