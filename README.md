# docuride.com

Marketing site for DocuRide. Static HTML/CSS — no framework, no build step.
Deployed on Vercel.

## Structure

```
index.html      Homepage (the whole pitch)
terms.html      Terms — PLACEHOLDER, needs legal review
privacy.html    Privacy — PLACEHOLDER, needs legal review
404.html        Not found
styles.css      All styling for every page
vercel.json     Clean URLs + security headers
robots.txt      Legal pages excluded from indexing
sitemap.xml     Single entry; add pages as they appear
assets/logos/   Dealer logos — see the README in that folder
```

## Run it locally

Any static server works. No install needed if you have Python:

```bash
python3 -m http.server 3000
```

Then open http://localhost:3000

## Deploy

Import this repo at [vercel.com/new](https://vercel.com/new). Vercel detects a
static site automatically — **framework preset: Other**, no build command, no
output directory. Every push to `main` deploys to production; every pull request
gets its own preview URL.

## Before launch

Four things are unfinished, in rough order of how much they matter.

**1. The demo form doesn't submit anywhere.**
`index.html` has `action="#"`. Right now a dealer fills it out and nothing
happens, which is worse than having no form. Point it at a real endpoint —
Zoho Forms, or a webhook into the CRM so a submission lands as a lead.

**2. Legal pages are shells.**
`terms.html` and `privacy.html` have headings and a loud placeholder banner.
Given DocuRide handles credit applications under GLBA, the privacy page in
particular needs an attorney, not a template.

**3. Dealer logos aren't in the repo yet.**
See `assets/logos/README.md`. Download them from the current Zoho Sites domain
*before* DNS cuts over to Vercel.

**4. No social proof beyond logos.**
There are no stats and no testimonials on the page, on purpose — inventing them
would be worse than omitting them. One real number ("average deal time dropped
from X to Y") and one real quote from a dealer would lift this page more than
any further design work.

## Notes for later

- Brand mark is a wordmark in Archivo plus a red dot. Swap in the real logo when
  it's available — see `.brand` in `styles.css`.
- No analytics installed. Vercel Web Analytics is one toggle in the dashboard if
  you want traffic numbers without adding a script tag.
- Type: Archivo (display), Public Sans (body), IBM Plex Mono (form/utility),
  all from Google Fonts.
- The hero form animation respects `prefers-reduced-motion` and renders in its
  completed state for anyone who's asked for less motion.
