-- FR-36: an audience row can also name a group. The name stays after the group is deleted, so the record still reads correctly.
ALTER TABLE "announcement_audience" DROP CONSTRAINT audience_one_target_chk;
ALTER TABLE "announcement_audience" ADD CONSTRAINT audience_one_target_chk
  CHECK (num_nonnulls("unitId", floor, "groupName") = 1);
