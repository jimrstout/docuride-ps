-- 0016_staff_edits.sql
--
-- Every rating input becomes editable on the Verify screen, including the ones
-- the CRM owns. This is where those edits live.
--
-- ── Why a separate column and not the session's own columns ──────────────
-- The obvious implementation is to write the corrected price straight into
-- fni.sessions.sale_price. fni-rate-vehicle's `overrides` parameter did exactly
-- that, and it is the wrong shape for what Jim asked for, on four counts:
--
--   The original is gone.  The screen has to show what the value was and where
--   it came from, beside the new one. Overwriting the column destroys the only
--   copy of the CRM figure we hold.
--
--   "Differs from CRM" becomes unanswerable.  The warning has to stay up until
--   the CRM deal matches, which means comparing the edit against whatever CRM
--   says NOW, on every read. That comparison needs two values, not one.
--
--   Refresh would wipe the edits.  A refresh writes the CRM columns. If edits
--   lived there too, every refresh would silently undo them, and the rule is
--   that a refresh keeps them.
--
--   Nobody's name is attached.  Who changed what, from what, to what, and when
--   is part of the compliance record, and a bare column holds none of it.
--
-- So the session columns stay as the CRM's record, unedited, and this column
-- holds the layer on top. Rating and the screen both read the session with the
-- layer applied; nothing writes the layer back into the columns, and nothing
-- writes it back to Zoho.
--
-- Shape, keyed by the Verify screen's own field key:
--
--   {
--     "sale_price": {
--       "value": "25500",
--       "original": "$24,000.00",
--       "original_source": "CRM",
--       "edited_by": "jim@example.com",
--       "edited_at": "2026-09-27T14:02:11.000Z"
--     }
--   }
--
-- `value` is the raw text a person typed, because that is what they meant; it is
-- cast to the column's type when the layer is applied. `original` is as the
-- sheet displayed it at the moment of the edit, which is what makes the
-- "was / now" line on the screen true rather than reconstructed.

alter table fni.sessions
  add column if not exists staff_edits jsonb;

comment on column fni.sessions.staff_edits is
  'Staff corrections to rating inputs, keyed by Verify screen field key. Each '
  'entry records value, original, original_source, edited_by, edited_at. The '
  'session''s own columns stay as the CRM''s record; this layer is applied over '
  'them when rating and when the Verify sheet is built. Never written back to '
  'Zoho, and never merged down into the columns.';

-- An object, never an array or a scalar. Keeps a malformed write from reaching
-- the code that applies it.
alter table fni.sessions
  drop constraint if exists sessions_staff_edits_is_object;

alter table fni.sessions
  add constraint sessions_staff_edits_is_object
  check (staff_edits is null or jsonb_typeof(staff_edits) = 'object');
