-- CreateEnum
CREATE TYPE "RequestCategory" AS ENUM ('PLUMBING', 'ELECTRICAL', 'LIFT', 'GENERATOR', 'WATER_SUPPLY', 'GAS', 'CLEANING', 'SECURITY', 'COMMON_AREA', 'OTHER');

-- CreateEnum
CREATE TYPE "RequestLocation" AS ENUM ('UNIT', 'COMMON_AREA');

-- CreateEnum
CREATE TYPE "RequestPriority" AS ENUM ('LOW', 'MEDIUM', 'HIGH');

-- CreateEnum
CREATE TYPE "RequestStatus" AS ENUM ('SUBMITTED', 'UNDER_REVIEW', 'IN_PROGRESS', 'RESOLVED', 'CLOSED', 'REJECTED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "UpdateKind" AS ENUM ('NOTE', 'STATUS_CHANGE', 'PRIORITY_CHANGE', 'ASSIGNMENT');

-- CreateTable
CREATE TABLE "maintenance_requests" (
    "id" UUID NOT NULL,
    "number" SERIAL NOT NULL,
    "submittedById" UUID NOT NULL,
    "unitId" UUID NOT NULL,
    "location" "RequestLocation" NOT NULL,
    "category" "RequestCategory" NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "priority" "RequestPriority",
    "status" "RequestStatus" NOT NULL DEFAULT 'SUBMITTED',
    "assignedToId" UUID,
    "dueAt" TIMESTAMPTZ NOT NULL,
    "resolvedAt" TIMESTAMPTZ,
    "closedAt" TIMESTAMPTZ,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "maintenance_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "request_updates" (
    "id" UUID NOT NULL,
    "requestId" UUID NOT NULL,
    "authorId" UUID,
    "kind" "UpdateKind" NOT NULL,
    "fromValue" TEXT,
    "toValue" TEXT,
    "note" TEXT,
    "isInternal" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "request_updates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "attachments" (
    "id" UUID NOT NULL,
    "storedName" TEXT NOT NULL,
    "originalName" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "uploadedById" UUID NOT NULL,
    "requestId" UUID,
    "requestUpdateId" UUID,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "attachments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "maintenance_requests_number_key" ON "maintenance_requests"("number");

-- CreateIndex
CREATE INDEX "maintenance_requests_status_idx" ON "maintenance_requests"("status");

-- CreateIndex
CREATE INDEX "maintenance_requests_submittedById_idx" ON "maintenance_requests"("submittedById");

-- CreateIndex
CREATE INDEX "maintenance_requests_assignedToId_idx" ON "maintenance_requests"("assignedToId");

-- CreateIndex
CREATE INDEX "maintenance_requests_unitId_idx" ON "maintenance_requests"("unitId");

-- CreateIndex
CREATE INDEX "request_updates_requestId_idx" ON "request_updates"("requestId");

-- CreateIndex
CREATE UNIQUE INDEX "attachments_storedName_key" ON "attachments"("storedName");

-- CreateIndex
CREATE INDEX "attachments_requestId_idx" ON "attachments"("requestId");

-- CreateIndex
CREATE INDEX "attachments_requestUpdateId_idx" ON "attachments"("requestUpdateId");

-- AddForeignKey
ALTER TABLE "maintenance_requests" ADD CONSTRAINT "maintenance_requests_submittedById_fkey" FOREIGN KEY ("submittedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "maintenance_requests" ADD CONSTRAINT "maintenance_requests_assignedToId_fkey" FOREIGN KEY ("assignedToId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "maintenance_requests" ADD CONSTRAINT "maintenance_requests_unitId_fkey" FOREIGN KEY ("unitId") REFERENCES "units"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "request_updates" ADD CONSTRAINT "request_updates_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "maintenance_requests"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "request_updates" ADD CONSTRAINT "request_updates_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_uploadedById_fkey" FOREIGN KEY ("uploadedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "maintenance_requests"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_requestUpdateId_fkey" FOREIGN KEY ("requestUpdateId") REFERENCES "request_updates"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ============================================================
-- Hand-written rules (Prisma cannot express these). See SRS FR-16..FR-21, BR-16..BR-19.
-- ============================================================

-- FR-16: a request needs a real title and description
ALTER TABLE "maintenance_requests" ADD CONSTRAINT requests_title_chk CHECK (char_length("title") BETWEEN 5 AND 120);
ALTER TABLE "maintenance_requests" ADD CONSTRAINT requests_description_chk CHECK (char_length("description") BETWEEN 10 AND 2000);

-- A resolved request always says when, and a closed one too
ALTER TABLE "maintenance_requests" ADD CONSTRAINT requests_resolved_chk CHECK ("status" <> 'RESOLVED' OR "resolvedAt" IS NOT NULL);
ALTER TABLE "maintenance_requests" ADD CONSTRAINT requests_closed_chk CHECK ("status" <> 'CLOSED' OR "closedAt" IS NOT NULL);

-- An attachment belongs to exactly one thing: a request or one of its updates (BR-19)
ALTER TABLE "attachments" ADD CONSTRAINT attachments_one_owner_chk CHECK (num_nonnulls("requestId", "requestUpdateId") = 1);
ALTER TABLE "attachments" ADD CONSTRAINT attachments_size_chk CHECK ("sizeBytes" > 0 AND "sizeBytes" <= 5242880);

-- Who shares a household with whom (BR-27): the resident of an occupancy and its household members.
-- Includes each person paired with themselves. Used so a household sees its own requests and nobody else's.
CREATE VIEW household_peers AS
  WITH members AS (
    SELECT o.id AS "occupancyId", o."residentId" AS "userId" FROM "occupancies" o
    UNION
    SELECT hm."occupancyId", hm."userId" FROM "household_members" hm
  )
  SELECT a."userId", b."userId" AS "peerId"
  FROM members a JOIN members b ON a."occupancyId" = b."occupancyId"
  UNION
  SELECT u.id, u.id FROM "users" u;
