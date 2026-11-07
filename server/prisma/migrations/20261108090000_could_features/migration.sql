-- AlterEnum
ALTER TYPE "AudienceType" ADD VALUE 'GROUP';

-- AlterEnum
ALTER TYPE "NotificationType" ADD VALUE 'REQUEST_SCHEDULED';

-- DropForeignKey
ALTER TABLE "maintenance_requests" DROP CONSTRAINT "maintenance_requests_submittedById_fkey";

-- DropForeignKey
ALTER TABLE "maintenance_requests" DROP CONSTRAINT "maintenance_requests_unitId_fkey";

-- AlterTable
ALTER TABLE "announcement_audience" ADD COLUMN     "groupId" UUID,
ADD COLUMN     "groupName" TEXT;

-- AlterTable
ALTER TABLE "announcements" ADD COLUMN     "endsAt" TIMESTAMPTZ,
ADD COLUMN     "recipientsResolvedAt" TIMESTAMPTZ;

-- AlterTable
ALTER TABLE "maintenance_requests" ADD COLUMN     "scheduledTaskId" UUID,
ALTER COLUMN "submittedById" DROP NOT NULL,
ALTER COLUMN "unitId" DROP NOT NULL;

-- CreateTable
CREATE TABLE "request_ratings" (
    "requestId" UUID NOT NULL,
    "stars" INTEGER NOT NULL,
    "comment" TEXT,
    "ratedById" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "request_ratings_pkey" PRIMARY KEY ("requestId")
);

-- CreateTable
CREATE TABLE "scheduled_tasks" (
    "id" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "category" "RequestCategory" NOT NULL,
    "intervalMonths" INTEGER NOT NULL,
    "nextDueDate" DATE NOT NULL,
    "defaultAssigneeId" UUID,
    "isPaused" BOOLEAN NOT NULL DEFAULT false,
    "createdById" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "scheduled_tasks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "resident_groups" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "resident_groups_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "resident_group_members" (
    "groupId" UUID NOT NULL,
    "userId" UUID NOT NULL,

    CONSTRAINT "resident_group_members_pkey" PRIMARY KEY ("groupId","userId")
);

-- CreateTable
CREATE TABLE "emergency_contacts" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "hours" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL,

    CONSTRAINT "emergency_contacts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "scheduled_tasks_nextDueDate_idx" ON "scheduled_tasks"("nextDueDate");

-- CreateIndex
CREATE UNIQUE INDEX "resident_groups_name_key" ON "resident_groups"("name");

-- CreateIndex
CREATE INDEX "resident_group_members_userId_idx" ON "resident_group_members"("userId");

-- CreateIndex
CREATE INDEX "emergency_contacts_sortOrder_idx" ON "emergency_contacts"("sortOrder");

-- CreateIndex
CREATE INDEX "announcements_recipientsResolvedAt_idx" ON "announcements"("recipientsResolvedAt");

-- CreateIndex
CREATE UNIQUE INDEX "maintenance_requests_scheduledTaskId_dueAt_key" ON "maintenance_requests"("scheduledTaskId", "dueAt");

-- AddForeignKey
ALTER TABLE "maintenance_requests" ADD CONSTRAINT "maintenance_requests_submittedById_fkey" FOREIGN KEY ("submittedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "maintenance_requests" ADD CONSTRAINT "maintenance_requests_unitId_fkey" FOREIGN KEY ("unitId") REFERENCES "units"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "maintenance_requests" ADD CONSTRAINT "maintenance_requests_scheduledTaskId_fkey" FOREIGN KEY ("scheduledTaskId") REFERENCES "scheduled_tasks"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "request_ratings" ADD CONSTRAINT "request_ratings_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "maintenance_requests"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "request_ratings" ADD CONSTRAINT "request_ratings_ratedById_fkey" FOREIGN KEY ("ratedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scheduled_tasks" ADD CONSTRAINT "scheduled_tasks_defaultAssigneeId_fkey" FOREIGN KEY ("defaultAssigneeId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scheduled_tasks" ADD CONSTRAINT "scheduled_tasks_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "announcement_audience" ADD CONSTRAINT "announcement_audience_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "resident_groups"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "resident_group_members" ADD CONSTRAINT "resident_group_members_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "resident_groups"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "resident_group_members" ADD CONSTRAINT "resident_group_members_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Announcements that already exist have gone out.
UPDATE "announcements" SET "recipientsResolvedAt" = "publishedAt";

-- BR-26 and BR-25, kept by the database as well as the API.
ALTER TABLE "request_ratings" ADD CONSTRAINT request_ratings_stars_chk CHECK (stars BETWEEN 1 AND 5);
ALTER TABLE "scheduled_tasks" ADD CONSTRAINT scheduled_tasks_interval_chk CHECK ("intervalMonths" BETWEEN 1 AND 24);

-- BR-26: a rating cannot be changed.
CREATE FUNCTION request_ratings_read_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'request ratings cannot be changed';
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER request_ratings_no_change BEFORE UPDATE OR DELETE ON "request_ratings"
  FOR EACH ROW EXECUTE FUNCTION request_ratings_read_only();
