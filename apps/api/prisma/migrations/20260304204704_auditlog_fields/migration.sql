-- AlterTable
ALTER TABLE "AuditLog" ADD COLUMN     "durationMs" INTEGER,
ADD COLUMN     "entityType" TEXT,
ADD COLUMN     "ip" TEXT,
ADD COLUMN     "requestId" TEXT,
ADD COLUMN     "statusCode" INTEGER,
ADD COLUMN     "userAgent" TEXT;
