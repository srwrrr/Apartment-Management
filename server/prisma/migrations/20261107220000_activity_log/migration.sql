-- CreateTable
CREATE TABLE "activity_logs" (
    "id" UUID NOT NULL,
    "actorId" UUID,
    "action" TEXT NOT NULL,
    "entityType" TEXT,
    "entityId" UUID,
    "details" JSONB NOT NULL DEFAULT '{}',
    "ip" TEXT,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "activity_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "activity_logs_createdAt_idx" ON "activity_logs"("createdAt");

-- CreateIndex
CREATE INDEX "activity_logs_actorId_createdAt_idx" ON "activity_logs"("actorId", "createdAt");

-- CreateIndex
CREATE INDEX "activity_logs_action_createdAt_idx" ON "activity_logs"("action", "createdAt");

-- AddForeignKey
ALTER TABLE "activity_logs" ADD CONSTRAINT "activity_logs_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- FR-34: entries cannot be edited or deleted, whatever the application does.
CREATE FUNCTION activity_logs_read_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'activity log entries cannot be changed';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER activity_logs_no_change BEFORE UPDATE OR DELETE ON "activity_logs"
  FOR EACH ROW EXECUTE FUNCTION activity_logs_read_only();
