/*
  Warnings:

  - You are about to drop the column `actorId` on the `AuditLog` table. All the data in the column will be lost.
  - You are about to drop the column `entity` on the `AuditLog` table. All the data in the column will be lost.
  - You are about to drop the column `metaJson` on the `AuditLog` table. All the data in the column will be lost.
  - Made the column `entityType` on table `AuditLog` required. This step will fail if there are existing NULL values in that column.
  - Added the required column `updatedAt` to the `ServiceStaff` table without a default value. This is not possible if the table is not empty.

*/
-- CreateEnum
CREATE TYPE "ServiceVisibility" AS ENUM ('PUBLIC', 'PRIVATE');

-- DropForeignKey
ALTER TABLE "AuditLog" DROP CONSTRAINT "AuditLog_actorId_fkey";

-- DropIndex
DROP INDEX "AuditLog_actorId_createdAt_idx";

-- DropIndex
DROP INDEX "AuditLog_actorRole_idx";

-- DropIndex
DROP INDEX "AuditLog_actorUserId_idx";

-- DropIndex
DROP INDEX "AuditLog_businessId_idx";

-- AlterTable
ALTER TABLE "AuditLog" DROP COLUMN "actorId",
DROP COLUMN "entity",
DROP COLUMN "metaJson",
ADD COLUMN     "userId" TEXT,
ALTER COLUMN "entityType" SET NOT NULL;

-- AlterTable
ALTER TABLE "Service" ADD COLUMN     "archivedAt" TIMESTAMP(3),
ADD COLUMN     "categoryId" TEXT,
ADD COLUMN     "color" TEXT,
ADD COLUMN     "description" TEXT,
ADD COLUMN     "isPinned" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "isPublic" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "onlineBookingEnabled" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "position" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "sortOrder" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "visibility" "ServiceVisibility" NOT NULL DEFAULT 'PUBLIC';

-- AlterTable
ALTER TABLE "ServiceStaff" ADD COLUMN     "bufferAfterMinOverride" INTEGER,
ADD COLUMN     "bufferBeforeMinOverride" INTEGER,
ADD COLUMN     "durationMinOverride" INTEGER,
ADD COLUMN     "isActive" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "onlineBookingEnabled" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "priceCentsOverride" INTEGER,
ADD COLUMN     "updatedAt" TIMESTAMP(3) NOT NULL;

-- AlterTable
ALTER TABLE "Staff" ADD COLUMN     "displayName" TEXT;

-- CreateTable
CREATE TABLE "ServiceCategory" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ServiceCategory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ServiceVariant" (
    "id" TEXT NOT NULL,
    "serviceId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "priceDeltaCents" INTEGER NOT NULL DEFAULT 0,
    "durationDeltaMin" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ServiceVariant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ServiceAddon" (
    "id" TEXT NOT NULL,
    "serviceId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "priceDeltaCents" INTEGER NOT NULL DEFAULT 0,
    "durationDeltaMin" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ServiceAddon_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ServiceCategory_businessId_sortOrder_idx" ON "ServiceCategory"("businessId", "sortOrder");

-- CreateIndex
CREATE UNIQUE INDEX "ServiceCategory_businessId_name_key" ON "ServiceCategory"("businessId", "name");

-- CreateIndex
CREATE INDEX "ServiceVariant_serviceId_sortOrder_idx" ON "ServiceVariant"("serviceId", "sortOrder");

-- CreateIndex
CREATE INDEX "ServiceAddon_serviceId_sortOrder_idx" ON "ServiceAddon"("serviceId", "sortOrder");

-- CreateIndex
CREATE INDEX "AuditLog_businessId_createdAt_idx" ON "AuditLog"("businessId", "createdAt");

-- CreateIndex
CREATE INDEX "AuditLog_actorUserId_createdAt_idx" ON "AuditLog"("actorUserId", "createdAt");

-- CreateIndex
CREATE INDEX "AuditLog_entityType_entityId_idx" ON "AuditLog"("entityType", "entityId");

-- CreateIndex
CREATE INDEX "Service_businessId_categoryId_position_idx" ON "Service"("businessId", "categoryId", "position");

-- CreateIndex
CREATE INDEX "Service_businessId_visibility_onlineBookingEnabled_idx" ON "Service"("businessId", "visibility", "onlineBookingEnabled");

-- CreateIndex
CREATE INDEX "Service_businessId_archivedAt_idx" ON "Service"("businessId", "archivedAt");

-- CreateIndex
CREATE INDEX "ServiceStaff_staffId_isActive_idx" ON "ServiceStaff"("staffId", "isActive");

-- CreateIndex
CREATE INDEX "ServiceStaff_serviceId_isActive_idx" ON "ServiceStaff"("serviceId", "isActive");

-- AddForeignKey
ALTER TABLE "Service" ADD CONSTRAINT "Service_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "ServiceCategory"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ServiceCategory" ADD CONSTRAINT "ServiceCategory_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ServiceVariant" ADD CONSTRAINT "ServiceVariant_serviceId_fkey" FOREIGN KEY ("serviceId") REFERENCES "Service"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ServiceAddon" ADD CONSTRAINT "ServiceAddon_serviceId_fkey" FOREIGN KEY ("serviceId") REFERENCES "Service"("id") ON DELETE CASCADE ON UPDATE CASCADE;
