-- A unit or person with requests cannot be deleted: the requests must not lose them silently.
ALTER TABLE "maintenance_requests" DROP CONSTRAINT "maintenance_requests_submittedById_fkey";
ALTER TABLE "maintenance_requests" ADD CONSTRAINT "maintenance_requests_submittedById_fkey" FOREIGN KEY ("submittedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "maintenance_requests" DROP CONSTRAINT "maintenance_requests_unitId_fkey";
ALTER TABLE "maintenance_requests" ADD CONSTRAINT "maintenance_requests_unitId_fkey" FOREIGN KEY ("unitId") REFERENCES "units"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
