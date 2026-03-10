-- AlterTable
ALTER TABLE "Booking" ADD COLUMN     "addonIdsSnapshot" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "addonsSnapshot" JSONB,
ADD COLUMN     "bufferAfterMinSnapshot" INTEGER,
ADD COLUMN     "bufferBeforeMinSnapshot" INTEGER,
ADD COLUMN     "currencySnapshot" TEXT,
ADD COLUMN     "durationMinSnapshot" INTEGER,
ADD COLUMN     "priceCentsSnapshot" INTEGER,
ADD COLUMN     "serviceNameSnapshot" TEXT,
ADD COLUMN     "serviceVariantId" TEXT,
ADD COLUMN     "serviceVariantNameSnapshot" TEXT,
ADD COLUMN     "totalMinSnapshot" INTEGER;

-- CreateIndex
CREATE INDEX "Booking_serviceVariantId_idx" ON "Booking"("serviceVariantId");

-- AddForeignKey
ALTER TABLE "Booking" ADD CONSTRAINT "Booking_serviceVariantId_fkey" FOREIGN KEY ("serviceVariantId") REFERENCES "ServiceVariant"("id") ON DELETE SET NULL ON UPDATE CASCADE;
