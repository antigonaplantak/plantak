-- AlterTable
ALTER TABLE "AuditLog" ADD COLUMN     "actorUserId" TEXT;

-- CreateIndex
CREATE INDEX "AuditLog_actorUserId_idx" ON "AuditLog"("actorUserId");
