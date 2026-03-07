/*
  Warnings:

  - You are about to drop the column `durationDeltaMin` on the `ServiceAddon` table. All the data in the column will be lost.
  - You are about to drop the column `isActive` on the `ServiceAddon` table. All the data in the column will be lost.
  - You are about to drop the column `priceDeltaCents` on the `ServiceAddon` table. All the data in the column will be lost.
  - You are about to drop the column `sortOrder` on the `ServiceAddon` table. All the data in the column will be lost.
  - You are about to drop the column `sortOrder` on the `ServiceCategory` table. All the data in the column will be lost.
  - You are about to drop the column `durationDeltaMin` on the `ServiceVariant` table. All the data in the column will be lost.
  - You are about to drop the column `isActive` on the `ServiceVariant` table. All the data in the column will be lost.
  - You are about to drop the column `priceDeltaCents` on the `ServiceVariant` table. All the data in the column will be lost.
  - You are about to drop the column `sortOrder` on the `ServiceVariant` table. All the data in the column will be lost.
  - Added the required column `durationMin` to the `ServiceVariant` table without a default value. This is not possible if the table is not empty.

*/
-- DropForeignKey
ALTER TABLE "ServiceCategory" DROP CONSTRAINT "ServiceCategory_businessId_fkey";

-- DropForeignKey
ALTER TABLE "ServiceStaff" DROP CONSTRAINT "ServiceStaff_serviceId_fkey";

-- DropForeignKey
ALTER TABLE "ServiceStaff" DROP CONSTRAINT "ServiceStaff_staffId_fkey";

-- DropIndex
DROP INDEX "ServiceAddon_serviceId_sortOrder_idx";

-- DropIndex
DROP INDEX "ServiceCategory_businessId_name_key";

-- DropIndex
DROP INDEX "ServiceCategory_businessId_sortOrder_idx";

-- DropIndex
DROP INDEX "ServiceVariant_serviceId_sortOrder_idx";

-- AlterTable
ALTER TABLE "ServiceAddon" DROP COLUMN "durationDeltaMin",
DROP COLUMN "isActive",
DROP COLUMN "priceDeltaCents",
DROP COLUMN "sortOrder",
ADD COLUMN     "archivedAt" TIMESTAMP(3),
ADD COLUMN     "durationMin" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "onlineBookingEnabled" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "position" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "priceCents" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "visibility" "ServiceVisibility" NOT NULL DEFAULT 'PUBLIC';

-- AlterTable
ALTER TABLE "ServiceCategory" DROP COLUMN "sortOrder",
ADD COLUMN     "archivedAt" TIMESTAMP(3),
ADD COLUMN     "isPinned" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "isVisible" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "position" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "ServiceStaff" ADD COLUMN     "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- AlterTable
ALTER TABLE "ServiceVariant" DROP COLUMN "durationDeltaMin",
DROP COLUMN "isActive",
DROP COLUMN "priceDeltaCents",
DROP COLUMN "sortOrder",
ADD COLUMN     "archivedAt" TIMESTAMP(3),
ADD COLUMN     "bufferAfterMin" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "bufferBeforeMin" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "durationMin" INTEGER NOT NULL,
ADD COLUMN     "onlineBookingEnabled" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "position" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "priceCents" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "visibility" "ServiceVisibility" NOT NULL DEFAULT 'PUBLIC';

-- CreateIndex
CREATE INDEX "ServiceAddon_serviceId_position_idx" ON "ServiceAddon"("serviceId", "position");

-- CreateIndex
CREATE INDEX "ServiceAddon_serviceId_archivedAt_idx" ON "ServiceAddon"("serviceId", "archivedAt");

-- CreateIndex
CREATE INDEX "ServiceCategory_businessId_position_idx" ON "ServiceCategory"("businessId", "position");

-- CreateIndex
CREATE INDEX "ServiceCategory_businessId_archivedAt_idx" ON "ServiceCategory"("businessId", "archivedAt");

-- CreateIndex
CREATE INDEX "ServiceVariant_serviceId_position_idx" ON "ServiceVariant"("serviceId", "position");

-- CreateIndex
CREATE INDEX "ServiceVariant_serviceId_archivedAt_idx" ON "ServiceVariant"("serviceId", "archivedAt");

-- AddForeignKey
ALTER TABLE "ServiceStaff" ADD CONSTRAINT "ServiceStaff_serviceId_fkey" FOREIGN KEY ("serviceId") REFERENCES "Service"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ServiceStaff" ADD CONSTRAINT "ServiceStaff_staffId_fkey" FOREIGN KEY ("staffId") REFERENCES "Staff"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ServiceCategory" ADD CONSTRAINT "ServiceCategory_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
