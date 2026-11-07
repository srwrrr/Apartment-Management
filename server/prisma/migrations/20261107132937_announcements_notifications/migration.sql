-- CreateEnum
CREATE TYPE "AnnouncementCategory" AS ENUM ('GENERAL', 'MAINTENANCE', 'MEETING', 'SERVICE_INTERRUPTION', 'RULES');

-- CreateEnum
CREATE TYPE "AudienceType" AS ENUM ('ALL', 'UNITS', 'FLOORS', 'OWNERS', 'TENANTS');

-- CreateEnum
CREATE TYPE "NotificationType" AS ENUM ('ANNOUNCEMENT', 'BILL_NEW', 'BILL_DUE_SOON', 'BILL_OVERDUE', 'PAYMENT_RECORDED', 'REQUEST_NEW', 'REQUEST_UPDATE', 'REQUEST_ASSIGNED');

-- CreateTable
CREATE TABLE "announcements" (
    "id" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "category" "AnnouncementCategory" NOT NULL DEFAULT 'GENERAL',
    "isImportant" BOOLEAN NOT NULL DEFAULT false,
    "audienceType" "AudienceType" NOT NULL,
    "publishedById" UUID NOT NULL,
    "publishedAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "editedAt" TIMESTAMPTZ,
    "archivedAt" TIMESTAMPTZ,

    CONSTRAINT "announcements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "announcement_audience" (
    "id" UUID NOT NULL,
    "announcementId" UUID NOT NULL,
    "unitId" UUID,
    "floor" INTEGER,

    CONSTRAINT "announcement_audience_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "announcement_recipients" (
    "announcementId" UUID NOT NULL,
    "userId" UUID NOT NULL,

    CONSTRAINT "announcement_recipients_pkey" PRIMARY KEY ("announcementId","userId")
);

-- CreateTable
CREATE TABLE "notifications" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "type" "NotificationType" NOT NULL,
    "params" JSONB NOT NULL DEFAULT '{}',
    "link" TEXT NOT NULL,
    "entityId" UUID,
    "readAt" TIMESTAMPTZ,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "announcements_publishedAt_idx" ON "announcements"("publishedAt");

-- CreateIndex
CREATE INDEX "announcement_audience_announcementId_idx" ON "announcement_audience"("announcementId");

-- CreateIndex
CREATE INDEX "announcement_recipients_userId_idx" ON "announcement_recipients"("userId");

-- CreateIndex
CREATE INDEX "notifications_userId_readAt_idx" ON "notifications"("userId", "readAt");

-- CreateIndex
CREATE INDEX "notifications_userId_createdAt_idx" ON "notifications"("userId", "createdAt");

-- AddForeignKey
ALTER TABLE "announcements" ADD CONSTRAINT "announcements_publishedById_fkey" FOREIGN KEY ("publishedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "announcement_audience" ADD CONSTRAINT "announcement_audience_announcementId_fkey" FOREIGN KEY ("announcementId") REFERENCES "announcements"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "announcement_audience" ADD CONSTRAINT "announcement_audience_unitId_fkey" FOREIGN KEY ("unitId") REFERENCES "units"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "announcement_recipients" ADD CONSTRAINT "announcement_recipients_announcementId_fkey" FOREIGN KEY ("announcementId") REFERENCES "announcements"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "announcement_recipients" ADD CONSTRAINT "announcement_recipients_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ============================================================
-- Hand-written rules (Prisma cannot express these). See SRS FR-23..FR-26, BR-20.
-- ============================================================

-- FR-23: a real title and message
ALTER TABLE "announcements" ADD CONSTRAINT announcements_title_chk CHECK (char_length("title") BETWEEN 3 AND 150);
ALTER TABLE "announcements" ADD CONSTRAINT announcements_body_chk CHECK (char_length("body") BETWEEN 1 AND 5000);

-- FR-24: each audience row names either one unit or one floor, never both and never neither
ALTER TABLE "announcement_audience" ADD CONSTRAINT audience_one_target_chk CHECK (num_nonnulls("unitId", "floor") = 1);

-- BR-20: a bill reminder is sent once per person per bill, so the daily job can safely run again (or after downtime)
CREATE UNIQUE INDEX notifications_reminder_once
  ON "notifications" ("userId", "type", "entityId") WHERE "type" IN ('BILL_DUE_SOON', 'BILL_OVERDUE');
