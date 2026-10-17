-- 0025_price_sheets.sql
--
-- Price sheets for Price Sheet providers. See docs/multi-provider.md, section 6.
--
-- An OEM program (BRP, Kawasaki, Honda, Indian Motorcycle, Polaris ORV) has no
-- API; its rates come from a sheet the dealer uploads. The file goes to the
-- private price-sheets bucket, Claude reads it into fni.price_sheet_rates, the
-- server checks flag what looks wrong, staff review, and a person publishes.
-- A parse always produces a Draft. Nothing is published automatically, and
-- nothing is deleted: a misread rate is left out on review, with a reason.
--
-- Stored values are the words people read: "Draft", "Published", "Retired",
-- "Not Parsed", "Parsing", "Parsed", "Parse Failed", "High", "Medium", "Low".

create table if not exists fni.price_sheets (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references public.tenants(id),
  provider_id     uuid not null references fni.providers(id),
  name            text not null,
  effective_from  date not null,
  -- Null means until replaced.
  effective_to    date,
  status          text not null default 'Draft',

  -- The uploaded file, in the private price-sheets bucket.
  file_path       text not null,
  file_name       text not null,
  file_type       text not null,

  parse_status    text not null default 'Not Parsed',
  parse_notes     text,
  model           text,
  input_tokens    integer,
  output_tokens   integer,
  parse_seconds   numeric(8, 1),
  parsed_at       timestamptz,

  uploaded_by     text not null,
  uploaded_at     timestamptz not null default now(),
  published_by    text,
  published_at    timestamptz,
  retired_at      timestamptz,
  retired_reason  text,
  updated_at      timestamptz not null default now(),

  constraint price_sheets_name_present check (btrim(name) <> ''),
  constraint price_sheets_status_known check (status in ('Draft', 'Published', 'Retired')),
  constraint price_sheets_file_type_known check (file_type in ('PDF', 'XLSX', 'XLS', 'CSV')),
  constraint price_sheets_parse_status_known
    check (parse_status in ('Not Parsed', 'Parsing', 'Parsed', 'Parse Failed')),
  constraint price_sheets_dates_in_order check (effective_to is null or effective_to >= effective_from),
  constraint price_sheets_published_has_who
    check (status <> 'Published' or (published_by is not null and published_at is not null))
);

create index if not exists price_sheets_provider_status
  on fni.price_sheets (provider_id, status);

create table if not exists fni.price_sheet_rates (
  id                    uuid primary key default gen_random_uuid(),
  sheet_id              uuid not null references fni.price_sheets(id) on delete cascade,

  product_code          text not null,
  product_name          text not null,
  family_code           text,
  plan                  text,
  category              text,

  -- Eligibility. An empty list or a null means any.
  makes                 text[] not null default '{}',
  model_contains        text[] not null default '{}',
  year_min              integer,
  year_max              integer,
  vehicle_types         text[] not null default '{}',
  conditions            text[] not null default '{}',
  max_age_years         integer,
  max_odometer          integer,
  engine_cc_min         integer,
  engine_cc_max         integer,
  max_months_in_service integer,

  -- The rate.
  term_months           integer,
  term_miles            integer,
  deductible            numeric(10, 2),
  dealer_cost           numeric(10, 2),
  suggested_retail      numeric(10, 2),
  options               jsonb not null default '[]',

  -- Where it came from, and how sure the reading was.
  source_ref            text,
  confidence            text not null default 'Medium',
  model_note            text,

  -- Set by the server checks and by staff review. A flagged row is never
  -- offered, and a sheet with any flagged row cannot be published.
  flagged               boolean not null default false,
  flag_reason           text,
  -- Left out on review: kept as the record of what was read, never offered,
  -- and not counted against publishing. Nothing here is ever deleted.
  left_out              boolean not null default false,
  left_out_reason       text,
  edited_by             text,
  edited_at             timestamptz,

  constraint price_sheet_rates_confidence_known check (confidence in ('High', 'Medium', 'Low')),
  constraint price_sheet_rates_conditions_known check (conditions <@ array['New', 'Used']::text[]),
  constraint price_sheet_rates_category_known check (category is null or category in (
    'Mechanical Protection', 'Maintenance', 'Tire and Wheel', 'Theft', 'Battery', 'Appearance', 'Other'
  )),
  constraint price_sheet_rates_flag_has_reason check (not flagged or btrim(coalesce(flag_reason, '')) <> ''),
  constraint price_sheet_rates_left_out_has_reason check (not left_out or btrim(coalesce(left_out_reason, '')) <> '')
);

create index if not exists price_sheet_rates_sheet on fni.price_sheet_rates (sheet_id);

alter table fni.price_sheets enable row level security;
alter table fni.price_sheet_rates enable row level security;
grant select, insert, update, delete on fni.price_sheets, fni.price_sheet_rates to service_role;
revoke all on fni.price_sheets, fni.price_sheet_rates from anon, authenticated;

comment on table fni.price_sheets is
  'A Price Sheet provider''s uploaded rates. A parse always produces a Draft; '
  'publishing is a person''s decision and retires the provider''s overlapping Published sheet.';
comment on table fni.price_sheet_rates is
  'One buyable rate read off a price sheet, with its eligibility, its source and '
  'how sure the reading was. Flagged rows are never offered.';

-- The private bucket the files live in. Not public: only the Edge Functions,
-- with the service role, read and write it.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'price-sheets', 'price-sheets', false, 26214400,
  array[
    'application/pdf',
    'text/csv',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/vnd.ms-excel'
  ]
)
on conflict (id) do nothing;
