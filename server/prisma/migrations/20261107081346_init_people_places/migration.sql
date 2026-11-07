-- CreateEnum
CREATE TYPE "Role" AS ENUM ('RESIDENT', 'STAFF', 'ADMIN');

-- CreateEnum
CREATE TYPE "Language" AS ENUM ('EN', 'BN');

-- CreateEnum
CREATE TYPE "TextSize" AS ENUM ('NORMAL', 'LARGE');

-- CreateEnum
CREATE TYPE "OccupancyType" AS ENUM ('OWNER', 'TENANT');

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL,
    "loginId" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "role" "Role" NOT NULL,
    "fullName" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "language" "Language" NOT NULL DEFAULT 'EN',
    "textSize" "TextSize" NOT NULL DEFAULT 'NORMAL',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "mustChangePassword" BOOLEAN NOT NULL DEFAULT true,
    "failedLoginCount" INTEGER NOT NULL DEFAULT 0,
    "lockedUntil" TIMESTAMPTZ,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "resident_profiles" (
    "userId" UUID NOT NULL,
    "altPhone" TEXT,
    "emergencyContactName" TEXT,
    "emergencyContactPhone" TEXT,

    CONSTRAINT "resident_profiles_pkey" PRIMARY KEY ("userId")
);

-- CreateTable
CREATE TABLE "staff_permissions" (
    "userId" UUID NOT NULL,
    "permission" TEXT NOT NULL,

    CONSTRAINT "staff_permissions_pkey" PRIMARY KEY ("userId","permission")
);

-- CreateTable
CREATE TABLE "units" (
    "id" UUID NOT NULL,
    "unitNumber" TEXT NOT NULL,
    "floor" INTEGER NOT NULL,
    "sizeSqft" INTEGER,
    "bedrooms" INTEGER,
    "isAvailable" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "units_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "occupancies" (
    "id" UUID NOT NULL,
    "unitId" UUID NOT NULL,
    "residentId" UUID NOT NULL,
    "type" "OccupancyType" NOT NULL,
    "startDate" DATE NOT NULL,
    "endDate" DATE,
    "isBillingContact" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "occupancies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "household_members" (
    "id" UUID NOT NULL,
    "occupancyId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "relation" TEXT NOT NULL,
    "addedAt" DATE NOT NULL,
    "removedAt" DATE,

    CONSTRAINT "household_members_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "settings" (
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,

    CONSTRAINT "settings_pkey" PRIMARY KEY ("key")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_loginId_key" ON "users"("loginId");

-- CreateIndex
CREATE INDEX "occupancies_unitId_idx" ON "occupancies"("unitId");

-- CreateIndex
CREATE INDEX "occupancies_residentId_idx" ON "occupancies"("residentId");

-- AddForeignKey
ALTER TABLE "resident_profiles" ADD CONSTRAINT "resident_profiles_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "staff_permissions" ADD CONSTRAINT "staff_permissions_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "occupancies" ADD CONSTRAINT "occupancies_unitId_fkey" FOREIGN KEY ("unitId") REFERENCES "units"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "occupancies" ADD CONSTRAINT "occupancies_residentId_fkey" FOREIGN KEY ("residentId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "household_members" ADD CONSTRAINT "household_members_occupancyId_fkey" FOREIGN KEY ("occupancyId") REFERENCES "occupancies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "household_members" ADD CONSTRAINT "household_members_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ============================================================
-- Hand-written rules (Prisma cannot express these). See SRS BR-xx.
-- ============================================================
CREATE EXTENSION IF NOT EXISTS btree_gist;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- BR-04: unit numbers are unique, case-insensitive
CREATE UNIQUE INDEX units_unit_number_ci_key ON "units" (upper("unitNumber"));

-- Sensible unit values
ALTER TABLE "units" ADD CONSTRAINT units_floor_chk CHECK ("floor" BETWEEN -2 AND 100);

-- BR-06: end date cannot be before start date
ALTER TABLE "occupancies" ADD CONSTRAINT occupancies_dates_chk
  CHECK ("endDate" IS NULL OR "endDate" >= "startDate");

-- BR-06: the same resident cannot have overlapping occupancies of the same unit
ALTER TABLE "occupancies" ADD CONSTRAINT occupancies_no_overlap
  EXCLUDE USING gist (
    "residentId" WITH =,
    "unitId" WITH =,
    daterange("startDate", COALESCE("endDate", 'infinity'::date), '[]') WITH &&
  );

-- BR-06: at most one active billing contact per unit
CREATE UNIQUE INDEX occupancies_one_billing_contact
  ON "occupancies" ("unitId") WHERE "isBillingContact" AND "endDate" IS NULL;

-- Household member dates
ALTER TABLE "household_members" ADD CONSTRAINT household_dates_chk
  CHECK ("removedAt" IS NULL OR "removedAt" >= "addedAt");

-- FR-08 / NFR-18: fast partial-text search on names and phone numbers
CREATE INDEX users_full_name_trgm ON "users" USING gin ("fullName" gin_trgm_ops);
CREATE INDEX users_phone_trgm ON "users" USING gin ("phone" gin_trgm_ops);
