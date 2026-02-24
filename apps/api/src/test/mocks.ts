import type { PrismaClient } from '@prisma/client';

/**
 * Mock minimal i PrismaService për unit tests.
 * Shto metoda kur të të duhen më vonë.
 */
export const prismaMock = {
  user: {
    findUnique: jest.fn(),
    create: jest.fn(),
  },
  refreshSession: {
    create: jest.fn(),
    findFirst: jest.fn(),
    update: jest.fn(),
    deleteMany: jest.fn(),
  },
  membership: {
    findFirst: jest.fn(),
  },
} as unknown as PrismaClient;

export const jwtMock = {
  signAsync: jest.fn(() => 'token'),
  verifyAsync: jest.fn(() => ({
    sub: 'u1',
    email: 'a@b.com',
    role: 'CUSTOMER',
  })),
};
