-- CreateEnum
CREATE TYPE "DepositResolvedFromScope" AS ENUM ('NONE', 'BUSINESS_DEFAULT', 'SERVICE_OVERRIDE', 'STAFF_DEFAULT', 'STAFF_SERVICE_OVERRIDE');

-- CreateEnum
CREATE TYPE "BookingPaymentStatus" AS ENUM ('NONE', 'DEPOSIT_PENDING', 'DEPOSIT_PAID', 'REMAINING_DUE_IN_SALON', 'PAID', 'DEPOSIT_WAIVED', 'DEPOSIT_FORFEITED', 'REFUNDED');

-- CreateEnum
CREATE TYPE "DepositServiceScopeMode" AS ENUM ('ALL_SERVICES', 'SELECTED_SERVICES');

-- AlterTable
ALTER TABLE "Booking" ADD COLUMN     "amountDepositCentsSnapshot" INTEGER,
ADD COLUMN     "amountRemainingCentsSnapshot" INTEGER,
ADD COLUMN     "amountTotalCentsSnapshot" INTEGER,
ADD COLUMN     "depositExpiresAt" TIMESTAMP(3),
ADD COLUMN     "depositPercentSnapshot" INTEGER,
ADD COLUMN     "depositResolvedFromScope" "DepositResolvedFromScope" NOT NULL DEFAULT 'NONE',
ADD COLUMN     "paymentStatus" "BookingPaymentStatus" NOT NULL DEFAULT 'NONE';

-- AlterTable
ALTER TABLE "Business" ADD COLUMN     "depositPercentDefault" INTEGER,
ADD COLUMN     "depositScopeMode" "DepositServiceScopeMode" NOT NULL DEFAULT 'ALL_SERVICES';

-- AlterTable
ALTER TABLE "Service" ADD COLUMN     "depositPercent" INTEGER,
ADD COLUMN     "useBusinessDepositDefault" BOOLEAN NOT NULL DEFAULT true;

-- AlterTable
ALTER TABLE "ServiceStaff" ADD COLUMN     "depositPercent" INTEGER,
ADD COLUMN     "useStaffDepositDefault" BOOLEAN NOT NULL DEFAULT true;

-- AlterTable
ALTER TABLE "Staff" ADD COLUMN     "depositPercentDefault" INTEGER,
ADD COLUMN     "depositScopeMode" "DepositServiceScopeMode" NOT NULL DEFAULT 'SELECTED_SERVICES';
