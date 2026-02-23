/*
  Warnings:

  - A unique constraint covering the columns `[userId,businessId]` on the table `Staff` will be added. If there are existing duplicate values, this will fail.

*/
-- DropIndex
DROP INDEX "Staff_userId_key";

-- CreateIndex
CREATE UNIQUE INDEX "Staff_userId_businessId_key" ON "Staff"("userId", "businessId");
