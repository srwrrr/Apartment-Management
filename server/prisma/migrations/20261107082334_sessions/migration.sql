-- DropIndex
DROP INDEX "users_full_name_trgm";

-- DropIndex
DROP INDEX "users_phone_trgm";

-- CreateTable
CREATE TABLE "session" (
    "sid" TEXT NOT NULL,
    "sess" JSONB NOT NULL,
    "expire" TIMESTAMP(6) NOT NULL,
    "userId" UUID,

    CONSTRAINT "session_pkey" PRIMARY KEY ("sid")
);

-- CreateIndex
CREATE INDEX "session_expire_idx" ON "session"("expire");

-- CreateIndex
CREATE INDEX "session_userId_idx" ON "session"("userId");
