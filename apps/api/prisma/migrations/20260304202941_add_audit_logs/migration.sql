-- CreateTable
CREATE TABLE "BookingHistory" (
    "id" TEXT NOT NULL,
    "bookingId" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "staffId" TEXT,
    "customerId" TEXT,
    "action" TEXT NOT NULL,
    "status" TEXT,
    "fromStartAt" TIMESTAMP(3),
    "fromEndAt" TIMESTAMP(3),
    "toStartAt" TIMESTAMP(3),
    "toEndAt" TIMESTAMP(3),
    "actorUserId" TEXT,
    "actorRole" TEXT,
    "meta" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BookingHistory_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "BookingHistory_bookingId_createdAt_idx" ON "BookingHistory"("bookingId", "createdAt");

-- CreateIndex
CREATE INDEX "BookingHistory_businessId_createdAt_idx" ON "BookingHistory"("businessId", "createdAt");

-- CreateIndex
CREATE INDEX "BookingHistory_staffId_createdAt_idx" ON "BookingHistory"("staffId", "createdAt");

-- CreateIndex
CREATE INDEX "BookingHistory_customerId_createdAt_idx" ON "BookingHistory"("customerId", "createdAt");

-- AddForeignKey
ALTER TABLE "BookingHistory" ADD CONSTRAINT "BookingHistory_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "Booking"("id") ON DELETE CASCADE ON UPDATE CASCADE;
