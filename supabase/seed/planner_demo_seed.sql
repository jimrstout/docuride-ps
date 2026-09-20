-- planner_demo_seed.sql
--
-- Demo data for the first Ownership Planner milestone, against the real
-- DocuRide session for the 2020 Can-Am Spyder RT.
--
-- ─────────────────────────────────────────────────────────────────────────
-- THE COPY BELOW IS A DRAFT AND HAS NOT BEEN REVIEWED.
--
-- Writing product_catalog copy is a content task, not an engineering one, and
-- it needs review against TecAssured's approved language before anything goes
-- live. This exists so the planner can be demonstrated end to end without
-- credentials; it is not the copy that ships. Ownership of the real copy is
-- still an open question in the build spec.
--
-- The pricing bands are likewise placeholders. The shape is right -- an
-- aggressive percentage on cheap products with a dollar ceiling that stops it
-- running away on expensive ones -- but the actual thresholds, percentages and
-- any state caps on GAP still need setting by the business.
-- ─────────────────────────────────────────────────────────────────────────

-- Prepaid Maintenance is in the catalog with its copy unwritten, not left out
-- of it. The rated offer includes PPM, so the planner still withholds it -- the
-- behaviour that stops a product being sold off a blank description -- but the
-- withholding is now a recorded decision rather than an absence.
--
-- That distinction is the whole point. A product missing from the catalog and a
-- product whose copy is not finished used to look identical from the outside:
-- both silently vanished from the customer's list. Registering PPM means an
-- absent row can only mean one thing, and that thing is a join failure worth
-- shouting about.

insert into fni.pricing_rules
  (tenant_id, store_id, product_code, cost_floor, cost_ceiling,
   markup_percent, markup_max_dollars, markup_min_dollars, round_to)
values
  ('881190a5-9bf5-49ae-91fd-752e546c8484', '7428435c-e47c-49f1-86c7-f42558a2ce23', null,    0,    400, 250,  600, 75, 5),
  ('881190a5-9bf5-49ae-91fd-752e546c8484', '7428435c-e47c-49f1-86c7-f42558a2ce23', null,  400,    900, 120,  800,  0, 5),
  ('881190a5-9bf5-49ae-91fd-752e546c8484', '7428435c-e47c-49f1-86c7-f42558a2ce23', null,  900,   5000,  65,  900,  0, 5)
on conflict do nothing;

insert into fni.product_catalog
  (tenant_id, store_id, product_code, display_name, goal,
   what_it_accomplishes, what_it_covers, coverage_duration, what_it_excludes,
   deductible_note, how_to_use, transferable, transfer_note, future_value_note,
   full_terms_url, relevance_tags, display_order)
values
  ('881190a5-9bf5-49ae-91fd-752e546c8484', '7428435c-e47c-49f1-86c7-f42558a2ce23',
   'VSC', 'Vehicle Service Contract', 'Keep ownership manageable',
   'Turns an unexpected mechanical repair into a known cost instead of a bill you did not plan for.',
   'Engine, transmission, final drive, fuel and electrical systems, and the sensors and electronics tied to them. Parts and the labor to fit them.',
   '48 months or 48,000 miles, whichever comes first',
   'Wear items you replace as a matter of course -- tires, brake pads, belts, filters, fluids. Damage from a crash, from riding it harder than it was built for, or from skipping the maintenance the manufacturer asks for. Anything already wrong with the machine when you bought it.',
   '$100 for each visit, not for each part replaced.',
   'Take it to any licensed repair shop. They call the number on your contract before starting work, and the plan pays them directly. You pay your deductible and nothing else.',
   true,
   'Transfers once to a private buyer for a small fee, which usually makes the machine easier to sell.',
   'If you sell before it runs out, the remaining coverage is part of what you are selling.',
   'https://docuride.com/terms/vsc', array['distance','weekend','work'], 10),

  ('881190a5-9bf5-49ae-91fd-752e546c8484', '7428435c-e47c-49f1-86c7-f42558a2ce23',
   'GAP', 'Guaranteed Asset Protection', 'Keep ownership manageable',
   'If the machine is totaled or stolen, this covers the gap between what your insurance pays and what you still owe the lender.',
   'The difference between your insurance settlement and your remaining loan balance, up to the limit in your contract.',
   'The life of your loan, up to 60 months',
   'Your insurance deductible beyond the amount stated in the contract. Missed payments and late fees added before the loss. Anything you financed on top of the machine itself, such as other protection plans.',
   'No deductible. It pays alongside your insurance settlement.',
   'Your lender files the claim with your insurance first. Once that settles, you send the settlement paperwork to the number on your contract and the remaining balance is paid to the lender.',
   false,
   'Tied to this loan, so it ends when the loan does.',
   'If you pay the loan off early, you may be owed a refund of the unused portion. Ask us.',
   'https://docuride.com/terms/gap', array['distance','local'], 20),

  ('881190a5-9bf5-49ae-91fd-752e546c8484', '7428435c-e47c-49f1-86c7-f42558a2ce23',
   'TW', 'Tire and Wheel Protection', 'Keep ownership manageable',
   'Covers repairing or replacing a tire or wheel damaged by something you hit on the road.',
   'Tires and wheels damaged by potholes, nails, glass, debris and other road hazards. Mounting, balancing and disposal are included.',
   '36 months from the date of sale',
   'Tires worn past the legal tread depth. Cosmetic scuffs and curb rash that do not affect how the wheel works. Damage from a crash, from vandalism, or from running the tire flat. Replacing a matching pair or set when only one is damaged.',
   'No deductible.',
   'Take it to any tire shop. They call the number on your contract before the work starts and the plan pays them directly.',
   true,
   'Transfers with the machine to a private buyer at no cost.',
   null,
   'https://docuride.com/terms/tire-wheel', array['trails','distance','work'], 30),

  ('881190a5-9bf5-49ae-91fd-752e546c8484', '7428435c-e47c-49f1-86c7-f42558a2ce23',
   'KEY', 'Key and Remote Replacement', 'Keep ownership enjoyable',
   'Replaces a lost, stolen or broken key or remote, including the programming, so a lost key is an errand rather than a day off work.',
   'The physical key or fob, cutting it, and programming it to your machine. Covers a set number of replacements per year, stated in your contract.',
   '60 months from the date of sale',
   'Keys locked inside a vehicle -- that is a lockout, not a replacement. Keys damaged on purpose. Replacements beyond the yearly limit in your contract.',
   'No deductible.',
   'Call the number on your contract. They arrange the replacement with a dealer or locksmith and pay them directly.',
   true,
   'Transfers with the machine to a private buyer at no cost.',
   null,
   'https://docuride.com/terms/key', array['local','weekend'], 40),

  -- Known product, copy not written yet. display_name and goal are NOT NULL so
  -- they are filled; everything the presentable view checks is left empty, so
  -- is_presentable computes false and the planner withholds it. Deliberately.
  ('881190a5-9bf5-49ae-91fd-752e546c8484', '7428435c-e47c-49f1-86c7-f42558a2ce23',
   'PPM', 'Planned Maintenance', 'Keep ownership manageable',
   null, null, null, null, null, null, null, null, null, null, array[]::text[], 50)
on conflict do nothing;


-- ─────────────────────────────────────────────────────────────────────────
-- Keep the demo session testable.
--
-- Session 44e41c35 is the only real session anchoring the verified payment
-- math, and fni-session-get returns 410 Gone once expires_at passes. It is not
-- created here -- fni-session-start made it from the live Zoho record -- so
-- this only pushes its expiry out when it is close to lapsing.
--
-- Scoped to that one id on purpose. Expiry is a privacy control on every other
-- session and nothing here should blunt it.
-- ─────────────────────────────────────────────────────────────────────────

update fni.sessions
set expires_at = greatest(expires_at, now() + interval '30 days'),
    updated_at = now()
where id = '44e41c35-c501-4ee8-84ed-8858b6b9101f'
  and expires_at < now() + interval '7 days';
