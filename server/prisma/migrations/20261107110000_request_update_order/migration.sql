-- Rows written in one transaction share a timestamp, so the history needs its own insertion order.
ALTER TABLE "request_updates" ADD COLUMN "seq" SERIAL NOT NULL;
CREATE UNIQUE INDEX "request_updates_seq_key" ON "request_updates"("seq");
