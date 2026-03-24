/*
  Warnings:

  - You are about to drop the column `amountDepositCentsSnapshot` on the `Booking` table. All the data in the column will be lost.
  - You are about to drop the column `amountRemainingCentsSnapshot` on the `Booking` table. All the data in the column will be lost.
  - You are about to drop the column `depositExpiresAt` on the `Booking` table. All the data in the column will be lost.
  - You are about to drop the column `depositPercentSnapshot` on the `Booking` table. All the data in the column will be lost.
  - You are about to drop the column `depositResolvedFromScope` on the `Booking` table. All the data in the column will be lost.
  - You are about to drop the column `paymentStatus` on the `Booking` table. All the data in the column will be lost.
  - You are about to drop the column `depositPercentDefault` on the `Business` table. All the data in the column will be lost.
  - You are about to drop the column `depositScopeMode` on the `Business` table. All the data in the column will be lost.
  - You are about to drop the column `depositPercent` on the `Service` table. All the data in the column will be lost.
  - You are about to drop the column `useBusinessDepositDefault` on the `Service` table. All the data in the column will be lost.
  - You are about to drop the column `depositPercent` on the `ServiceStaff` table. All the data in the column will be lost.
  - You are about to drop the column `useStaffDepositDefault` on the `ServiceStaff` table. All the data in the column will be lost.
  - You are about to drop the column `depositPercentDefault` on the `Staff` table. All the data in the column will be lost.
  - You are about to drop the column `depositScopeMode` on the `Staff` table. All the data in the column will be lost.
  - You are about to drop the `PaymentProviderEvent` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `PaymentSession` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `PaymentTransaction` table. If the table is not empty, all the data it contains will be lost.

*/
-- DropForeignKey
ALTER TABLE "PaymentSession" DROP CONSTRAINT "PaymentSession_bookingId_fkey";

-- DropForeignKey
ALTER TABLE "PaymentTransaction" DROP CONSTRAINT "PaymentTransaction_bookingId_fkey";

-- AlterTable
ALTER TABLE "Booking" DROP COLUMN "amountDepositCentsSnapshot",
DROP COLUMN "amountRemainingCentsSnapshot",
DROP COLUMN "depositExpiresAt",
DROP COLUMN "depositPercentSnapshot",
DROP COLUMN "depositResolvedFromScope",
DROP COLUMN "paymentStatus";

-- AlterTable
ALTER TABLE "Business" DROP COLUMN "depositPercentDefault",
DROP COLUMN "depositScopeMode";

-- AlterTable
ALTER TABLE "Service" DROP COLUMN "depositPercent",
DROP COLUMN "useBusinessDepositDefault";

-- AlterTable
ALTER TABLE "ServiceStaff" DROP COLUMN "depositPercent",
DROP COLUMN "useStaffDepositDefault";

-- AlterTable
ALTER TABLE "Staff" DROP COLUMN "depositPercentDefault",
DROP COLUMN "depositScopeMode";

-- DropTable
DROP TABLE "PaymentProviderEvent";

-- DropTable
DROP TABLE "PaymentSession";

-- DropTable
DROP TABLE "PaymentTransaction";

-- DropEnum
DROP TYPE "BookingPaymentStatus";

-- DropEnum
DROP TYPE "DepositResolvedFromScope";

-- DropEnum
DROP TYPE "DepositServiceScopeMode";

-- DropEnum
DROP TYPE "PaymentSessionStatus";

-- DropEnum
DROP TYPE "PaymentTransactionType";
