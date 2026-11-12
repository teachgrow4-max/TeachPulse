-- =============================================================================
-- Admin-operated employee QR attendance, part 1 of 2: the ADMIN_SCAN purpose
-- =============================================================================
-- Before an administrator or attendance operator may record attendance for somebody else, the
-- server checks that THEY are at the office, using the same location / network / QR / device layers
-- as a check-in. That proof is stored as an ordinary attendance_verifications row, with its own
-- purpose so it can never be mistaken for (or spent as) the scanner's own check-in.
--
-- A new enum value cannot be used by the transaction that adds it, so it is added here, alone.
-- Everything that refers to ADMIN_SCAN lives in the next migration.

alter type public.verification_purpose add value if not exists 'ADMIN_SCAN';
