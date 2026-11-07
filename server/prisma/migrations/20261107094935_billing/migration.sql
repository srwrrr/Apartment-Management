-- CreateEnum
CREATE TYPE "BillKind" AS ENUM ('REGULAR', 'OPENING_BALANCE');

-- CreateEnum
CREATE TYPE "ChargeType" AS ENUM ('SERVICE', 'RENT', 'WATER', 'GAS', 'ELECTRICITY', 'OPENING_BALANCE', 'OTHER');

-- CreateEnum
CREATE TYPE "PaymentMethod" AS ENUM ('CASH', 'BANK', 'BKASH', 'NAGAD', 'ROCKET', 'OTHER');

-- CreateTable
CREATE TABLE "unit_fees" (
    "id" UUID NOT NULL,
    "unitId" UUID,
    "chargeType" "ChargeType" NOT NULL,
    "amount" INTEGER NOT NULL,
    "description" TEXT NOT NULL,

    CONSTRAINT "unit_fees_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bills" (
    "id" UUID NOT NULL,
    "unitId" UUID NOT NULL,
    "kind" "BillKind" NOT NULL DEFAULT 'REGULAR',
    "billingMonth" DATE NOT NULL,
    "dueDate" DATE NOT NULL,
    "billingContactId" UUID,
    "note" TEXT,
    "createdById" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "bills_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "charges" (
    "id" UUID NOT NULL,
    "billId" UUID NOT NULL,
    "type" "ChargeType" NOT NULL,
    "amount" INTEGER NOT NULL,
    "description" TEXT NOT NULL,

    CONSTRAINT "charges_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payments" (
    "id" UUID NOT NULL,
    "billId" UUID NOT NULL,
    "amount" INTEGER NOT NULL,
    "paidOn" DATE NOT NULL,
    "method" "PaymentMethod" NOT NULL,
    "reference" TEXT,
    "receiptNo" TEXT NOT NULL,
    "recordedById" UUID NOT NULL,
    "voidedAt" TIMESTAMPTZ,
    "voidedById" UUID,
    "voidReason" TEXT,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "counters" (
    "kind" TEXT NOT NULL,
    "year" INTEGER NOT NULL,
    "value" INTEGER NOT NULL,

    CONSTRAINT "counters_pkey" PRIMARY KEY ("kind","year")
);

-- CreateIndex
CREATE INDEX "unit_fees_unitId_idx" ON "unit_fees"("unitId");

-- CreateIndex
CREATE INDEX "bills_billingMonth_idx" ON "bills"("billingMonth");

-- CreateIndex
CREATE UNIQUE INDEX "bills_unitId_billingMonth_key" ON "bills"("unitId", "billingMonth");

-- CreateIndex
CREATE INDEX "charges_billId_idx" ON "charges"("billId");

-- CreateIndex
CREATE UNIQUE INDEX "payments_receiptNo_key" ON "payments"("receiptNo");

-- CreateIndex
CREATE INDEX "payments_billId_idx" ON "payments"("billId");

-- CreateIndex
CREATE INDEX "payments_method_reference_idx" ON "payments"("method", "reference");

-- AddForeignKey
ALTER TABLE "unit_fees" ADD CONSTRAINT "unit_fees_unitId_fkey" FOREIGN KEY ("unitId") REFERENCES "units"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bills" ADD CONSTRAINT "bills_unitId_fkey" FOREIGN KEY ("unitId") REFERENCES "units"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bills" ADD CONSTRAINT "bills_billingContactId_fkey" FOREIGN KEY ("billingContactId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bills" ADD CONSTRAINT "bills_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "charges" ADD CONSTRAINT "charges_billId_fkey" FOREIGN KEY ("billId") REFERENCES "bills"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_billId_fkey" FOREIGN KEY ("billId") REFERENCES "bills"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_recordedById_fkey" FOREIGN KEY ("recordedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_voidedById_fkey" FOREIGN KEY ("voidedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ============================================================
-- Hand-written rules (Prisma cannot express these). See SRS BR-xx.
-- ============================================================

-- BR-15: money is a positive whole number of poisha (at most 10,000,000 taka per item)
ALTER TABLE "charges"   ADD CONSTRAINT charges_amount_chk   CHECK ("amount" > 0 AND "amount" <= 1000000000);
ALTER TABLE "payments"  ADD CONSTRAINT payments_amount_chk  CHECK ("amount" > 0 AND "amount" <= 1000000000);
ALTER TABLE "unit_fees" ADD CONSTRAINT unit_fees_amount_chk CHECK ("amount" > 0 AND "amount" <= 1000000000);

-- FR-32: only recurring charge types can be set up as fees
ALTER TABLE "unit_fees" ADD CONSTRAINT unit_fees_type_chk
  CHECK ("chargeType" IN ('SERVICE', 'RENT', 'WATER', 'GAS', 'ELECTRICITY'));

-- FR-32: one default per type for the building, and one override per type for a unit
CREATE UNIQUE INDEX unit_fees_default_key ON "unit_fees" ("chargeType") WHERE "unitId" IS NULL;
CREATE UNIQUE INDEX unit_fees_unit_key ON "unit_fees" ("unitId", "chargeType") WHERE "unitId" IS NOT NULL;

-- BR-07: billing months are the 1st of the month (one bill per unit per month is the unique index above)
ALTER TABLE "bills" ADD CONSTRAINT bills_month_chk CHECK (date_trunc('month', "billingMonth") = "billingMonth");

-- BR-22: at most one opening balance per unit
CREATE UNIQUE INDEX bills_one_opening_balance ON "bills" ("unitId") WHERE "kind" = 'OPENING_BALANCE';

-- BR-07: within one bill each charge type appears once, except "Other"
CREATE UNIQUE INDEX charges_one_per_type ON "charges" ("billId", "type") WHERE "type" <> 'OTHER';

-- BR-13: a payment is voided with a reason, and a reason only exists on a voided payment
ALTER TABLE "payments" ADD CONSTRAINT payments_void_chk
  CHECK (("voidedAt" IS NULL) = ("voidReason" IS NULL) AND ("voidedAt" IS NULL) = ("voidedById" IS NULL));

-- ------------------------------------------------------------
-- Who can see which unit's records (BR-08, BR-22, BR-27): one definition, used by every query.
-- Occupants, plus household members for as long as both the stay and their membership last.
-- endDate NULL means "still ongoing".
-- ------------------------------------------------------------
CREATE VIEW unit_access AS
  SELECT o."residentId" AS "userId", o."unitId", o."startDate", o."endDate", o.id AS "occupancyId"
  FROM "occupancies" o
  UNION ALL
  SELECT hm."userId", o."unitId",
         GREATEST(o."startDate", hm."addedAt") AS "startDate",
         NULLIF(LEAST(COALESCE(o."endDate", 'infinity'::date), COALESCE(hm."removedAt", 'infinity'::date)), 'infinity'::date) AS "endDate",
         o.id AS "occupancyId"
  FROM "household_members" hm
  JOIN "occupancies" o ON o.id = hm."occupancyId";

-- Every (user, bill) pair where the user may see the bill.
--  * regular bill: they had access to the unit at some point during the bill's month (BR-08)
--  * opening balance: they have access on the go-live date (BR-22)
CREATE VIEW bill_access AS
  SELECT DISTINCT ua."userId", b.id AS "billId"
  FROM "bills" b
  JOIN unit_access ua ON ua."unitId" = b."unitId"
  CROSS JOIN LATERAL (
    SELECT COALESCE((SELECT value::date FROM "settings" WHERE key = 'goLiveDate'), CURRENT_DATE) AS d
  ) gl
  WHERE (b.kind = 'REGULAR'
         AND ua."startDate" <= (b."billingMonth" + INTERVAL '1 month' - INTERVAL '1 day')::date
         AND (ua."endDate" IS NULL OR ua."endDate" >= b."billingMonth"))
     OR (b.kind = 'OPENING_BALANCE'
         AND ua."startDate" <= gl.d
         AND (ua."endDate" IS NULL OR ua."endDate" >= gl.d));

-- ------------------------------------------------------------
-- Total, paid, balance and status of every bill (BR-09). Never stored, so they cannot drift.
-- Voided payments do not count. "Today" is today in Dhaka. Used by every list, report and dashboard.
-- ------------------------------------------------------------
CREATE VIEW bill_summary AS
  SELECT b.id AS "billId", b."unitId", b.kind, b."billingMonth", b."dueDate",
         COALESCE(c.total, 0)::bigint AS total,
         COALESCE(p.paid, 0)::bigint AS paid,
         (COALESCE(c.total, 0) - COALESCE(p.paid, 0))::bigint AS balance,
         CASE
           WHEN COALESCE(c.total, 0) - COALESCE(p.paid, 0) <= 0 THEN 'PAID'
           WHEN b."dueDate" < (now() AT TIME ZONE 'Asia/Dhaka')::date THEN 'OVERDUE'
           WHEN COALESCE(p.paid, 0) > 0 THEN 'PARTIALLY_PAID'
           ELSE 'UNPAID'
         END AS status
  FROM "bills" b
  LEFT JOIN (SELECT "billId", SUM(amount) AS total FROM "charges" GROUP BY "billId") c ON c."billId" = b.id
  LEFT JOIN (SELECT "billId", SUM(amount) AS paid FROM "payments" WHERE "voidedAt" IS NULL GROUP BY "billId") p ON p."billId" = b.id;
