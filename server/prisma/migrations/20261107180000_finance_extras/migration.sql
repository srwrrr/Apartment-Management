-- CreateEnum
CREATE TYPE "PaymentReportStatus" AS ENUM ('PENDING', 'VERIFIED', 'REJECTED');

-- CreateEnum
CREATE TYPE "ExpenseCategory" AS ENUM ('STAFF_SALARY', 'GENERATOR_FUEL', 'COMMON_ELECTRICITY', 'WATER', 'CLEANING', 'LIFT', 'SECURITY', 'REPAIRS', 'OTHER');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "NotificationType" ADD VALUE 'PAYMENT_REPORT_NEW';
ALTER TYPE "NotificationType" ADD VALUE 'PAYMENT_REPORT_VERIFIED';
ALTER TYPE "NotificationType" ADD VALUE 'PAYMENT_REPORT_REJECTED';
ALTER TYPE "NotificationType" ADD VALUE 'CERTIFICATE_ISSUED';
ALTER TYPE "NotificationType" ADD VALUE 'MOVE_OUT_RECORDED';

-- AlterTable
ALTER TABLE "attachments" ADD COLUMN     "expenseId" UUID,
ADD COLUMN     "paymentReportId" UUID;

-- AlterTable
ALTER TABLE "occupancies" ADD COLUMN     "moveOutNote" TEXT;

-- CreateTable
CREATE TABLE "payment_reports" (
    "id" UUID NOT NULL,
    "billId" UUID NOT NULL,
    "reportedById" UUID NOT NULL,
    "amount" INTEGER NOT NULL,
    "paidOn" DATE NOT NULL,
    "method" "PaymentMethod" NOT NULL,
    "reference" TEXT NOT NULL,
    "status" "PaymentReportStatus" NOT NULL DEFAULT 'PENDING',
    "reviewedById" UUID,
    "reviewedAt" TIMESTAMPTZ,
    "rejectReason" TEXT,
    "paymentId" UUID,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payment_reports_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "no_dues_certificates" (
    "id" UUID NOT NULL,
    "number" TEXT NOT NULL,
    "unitId" UUID NOT NULL,
    "issuedToId" UUID NOT NULL,
    "coversThroughMonth" DATE NOT NULL,
    "issuedById" UUID NOT NULL,
    "issuedAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "no_dues_certificates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "expenses" (
    "id" UUID NOT NULL,
    "spentOn" DATE NOT NULL,
    "category" "ExpenseCategory" NOT NULL,
    "amount" INTEGER NOT NULL,
    "payee" TEXT NOT NULL,
    "description" TEXT,
    "recordedById" UUID NOT NULL,
    "voidedAt" TIMESTAMPTZ,
    "voidedById" UUID,
    "voidReason" TEXT,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "expenses_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "payment_reports_paymentId_key" ON "payment_reports"("paymentId");

-- CreateIndex
CREATE INDEX "payment_reports_status_createdAt_idx" ON "payment_reports"("status", "createdAt");

-- CreateIndex
CREATE INDEX "payment_reports_billId_idx" ON "payment_reports"("billId");

-- CreateIndex
CREATE INDEX "payment_reports_method_reference_idx" ON "payment_reports"("method", "reference");

-- CreateIndex
CREATE UNIQUE INDEX "no_dues_certificates_number_key" ON "no_dues_certificates"("number");

-- CreateIndex
CREATE INDEX "no_dues_certificates_unitId_idx" ON "no_dues_certificates"("unitId");

-- CreateIndex
CREATE INDEX "no_dues_certificates_issuedToId_idx" ON "no_dues_certificates"("issuedToId");

-- CreateIndex
CREATE INDEX "expenses_spentOn_idx" ON "expenses"("spentOn");

-- CreateIndex
CREATE INDEX "expenses_category_idx" ON "expenses"("category");

-- CreateIndex
CREATE UNIQUE INDEX "attachments_paymentReportId_key" ON "attachments"("paymentReportId");

-- CreateIndex
CREATE UNIQUE INDEX "attachments_expenseId_key" ON "attachments"("expenseId");

-- AddForeignKey
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_paymentReportId_fkey" FOREIGN KEY ("paymentReportId") REFERENCES "payment_reports"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_expenseId_fkey" FOREIGN KEY ("expenseId") REFERENCES "expenses"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_reports" ADD CONSTRAINT "payment_reports_billId_fkey" FOREIGN KEY ("billId") REFERENCES "bills"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_reports" ADD CONSTRAINT "payment_reports_reportedById_fkey" FOREIGN KEY ("reportedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_reports" ADD CONSTRAINT "payment_reports_reviewedById_fkey" FOREIGN KEY ("reviewedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_reports" ADD CONSTRAINT "payment_reports_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "payments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "no_dues_certificates" ADD CONSTRAINT "no_dues_certificates_unitId_fkey" FOREIGN KEY ("unitId") REFERENCES "units"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "no_dues_certificates" ADD CONSTRAINT "no_dues_certificates_issuedToId_fkey" FOREIGN KEY ("issuedToId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "no_dues_certificates" ADD CONSTRAINT "no_dues_certificates_issuedById_fkey" FOREIGN KEY ("issuedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_recordedById_fkey" FOREIGN KEY ("recordedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_voidedById_fkey" FOREIGN KEY ("voidedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- Rules Prisma cannot express --------------------------------------------------

-- An attachment belongs to exactly one thing.
ALTER TABLE "attachments" DROP CONSTRAINT attachments_one_owner_chk;
ALTER TABLE "attachments" ADD CONSTRAINT attachments_one_owner_chk
  CHECK (num_nonnulls("requestId", "requestUpdateId", "paymentReportId", "expenseId") = 1);

-- BR-21: a report needs an amount and a reference. A decision records who made it; a rejection says why;
-- only a verified report has a payment, and every verified report has one.
ALTER TABLE "payment_reports" ADD CONSTRAINT payment_reports_amount_chk CHECK ("amount" > 0);
ALTER TABLE "payment_reports" ADD CONSTRAINT payment_reports_reference_chk CHECK (length(btrim("reference")) > 0);
ALTER TABLE "payment_reports" ADD CONSTRAINT payment_reports_review_chk
  CHECK (("status" = 'PENDING') = ("reviewedById" IS NULL) AND ("status" = 'PENDING') = ("reviewedAt" IS NULL));
ALTER TABLE "payment_reports" ADD CONSTRAINT payment_reports_reject_chk
  CHECK (("status" = 'REJECTED') = ("rejectReason" IS NOT NULL));
ALTER TABLE "payment_reports" ADD CONSTRAINT payment_reports_payment_chk
  CHECK (("status" = 'VERIFIED') = ("paymentId" IS NOT NULL));

-- BR-23: an amount above zero; a void records who, when and why, or nothing at all.
ALTER TABLE "expenses" ADD CONSTRAINT expenses_amount_chk CHECK ("amount" > 0);
ALTER TABLE "expenses" ADD CONSTRAINT expenses_payee_chk CHECK (length(btrim("payee")) > 0);
ALTER TABLE "expenses" ADD CONSTRAINT expenses_void_chk
  CHECK (num_nonnulls("voidedAt", "voidedById", "voidReason") IN (0, 3));
