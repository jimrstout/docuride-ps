-- 0007_fni_session_mode_title_case.sql
--
-- fni.sessions.mode was the only constrained column on the table written in
-- lowercase hyphenated values. Every other one reads as a human would write it:
--
--   buyer_type     Individual | Company
--   condition      New | Used
--   finance_type   Loan | Lease | Cash
--   status         Initiated | Rated | Presenting | Products Selected |
--                  Agreement Created | Finalized | Written Back | Cancelled
--
-- mode was added in this build, so it is the newcomer that is out of step,
-- not the convention. These values reach a buyer -- the acknowledgment document
-- states which mode the session ran in -- so they are written the way they read.
--
-- There is no data to migrate: mode is NULL on every row and nothing sends it
-- yet. The UPDATE below is here for any environment where that is not true.
--
-- This lands with its writers. A constraint ahead of the code fails the next
-- write, so fni-session-save, fni-session-get and the acknowledgment renderer
-- move to the same vocabulary in the same commit.

alter table fni.sessions drop constraint if exists sessions_mode_check;

update fni.sessions
set mode = case mode
             when 'self-guided'     then 'Self-Guided'
             when 'collaborative'   then 'Collaborative'
             when 'staff-presented' then 'Staff-Presented'
             else mode
           end
where mode is not null;

alter table fni.sessions
  add constraint sessions_mode_check
    check (mode is null or mode in ('Self-Guided', 'Collaborative', 'Staff-Presented'));

comment on column fni.sessions.mode is
  'How the session was run: Self-Guided | Collaborative | Staff-Presented. '
  'A presentation detail -- there is one application, not three -- but the '
  'acknowledgment document has to state which it was.';
