-- Needed for GiST equality
CREATE EXTENSION IF NOT EXISTS btree_gist;

-- Ensure valid range
ALTER TABLE "Booking"
ADD CONSTRAINT "Booking_start_before_end"
CHECK ("startAt" < "endAt");

-- Anti double booking (no overlap per staff for active states)
ALTER TABLE "Booking"
ADD CONSTRAINT "Booking_no_overlap_per_staff"
EXCLUDE USING gist
(
  "staffId" WITH =,
  tsrange("startAt", "endAt", '[)') WITH &&
)
WHERE ("status" IN ('PENDING', 'CONFIRMED'));
