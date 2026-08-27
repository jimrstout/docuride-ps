-- 0004_no_web_owned_fields
--
-- Removes Other_Stipulation from field_ownership, leaving zero web-owned
-- fields for now.
--
-- 0001 seeded it as the single owner='web' field, on the assumption it was a
-- text field the web could write. It is not: getFields reports Other_Stipulation
-- as data_type 'fileupload' / json_type 'jsonarray' (max 5 files), so the
-- intended write — a string — would be rejected by Zoho. The DocuRide module
-- has no text stipulation field to use instead.
--
-- field_ownership is therefore empty, which is a valid state and the safe
-- default: ownership defaults to Zoho (CLAUDE.md), so /api/deals/:id now
-- rejects every PATCH with 403 rather than writing a field Zoho owns. The
-- endpoint needs no code change — it is driven by this table, not by a
-- hardcoded field list. Adding a row here re-opens the write path.

delete from public.field_ownership
 where zoho_field = 'Other_Stipulation';
