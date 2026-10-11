# Chrome Web Store listing assets (Task 11, beta 0.8.0)

> **Listing materials for a private, unpublished beta.** Nothing here has
> been uploaded to the Chrome Web Store, and nothing claims store approval,
> customers, results or commercial validation. Every screenshot shows made-up
> data, and each case is labelled `Synthetic`.

These assets are reproducible: one command builds them from the production
beta ZIP. The promotional tile and screenshots are listing images, kept in
`store-assets/` and never shipped in the extension. Only the 128 px icon is
a packaged file.

## Requirements (rechecked 2026-10-11)

Source: Chrome Web Store, [Supplying images](https://developer.chrome.com/docs/webstore/images).
The page footer reads "Last updated 2018-06-11 UTC". It was fetched again on
2026-10-11.

| Asset | The page says | This build |
| --- | --- | --- |
| Extension icon | "You must provide a 128x128-pixel extension icon image in the ZIP file"; "The actual icon size should be 96x96 (for square icons); an additional 16 pixels per side should be transparent padding"; "must be in PNG format"; "should work well on both light and dark backgrounds" | `public/icons/icon-128.png`: 128×128 PNG, artwork x/y 16–111 (96×96), every pixel outside it fully transparent (alpha 0) |
| Small promotional image | "You must provide one small, 440x280-pixel promotional image"; "Avoid text"; "Fill the entire region"; "Make sure the edges are well defined"; "Use saturated colors if possible" | `store-assets/small-promo-tile-440x280.png`, fully opaque, no text |
| Marquee | 1400×560, optional | **Not made** (skipped for now) |
| Screenshots | "at least 1 — and preferably the maximum allowed 5"; "1280x800 or 640x400 pixels"; "Square corners, no padding (full bleed)"; "should demonstrate the actual user experience" | Three 1280×800 PNGs, fully opaque, square, no border or padding |

## Files

| File | Kind | Source | Committed |
| --- | --- | --- | --- |
| `public/icons/icon-128.png` | Packaged icon (manifest `icons.128` and `action.default_icon.128`) | `assets-src/icon-store.svg` | yes |
| `public/icons/icon-{16,32,48}.png` | Toolbar icons, **unchanged** byte for byte | `assets-src/icon-16.svg`, `assets-src/icon.svg` | yes |
| `store-assets/small-promo-tile-440x280.png` | Small promotional tile | `store-assets/source/small-promo-tile.svg` | yes |
| `store-assets/screenshot-1-overview-1280x800.png` | Screenshot 1 | Captured from the extracted beta ZIP | yes |
| `store-assets/screenshot-2-item-evidence-1280x800.png` | Screenshot 2 | Captured from the extracted beta ZIP | yes |
| `store-assets/screenshot-3-case-summary-1280x800.png` | Screenshot 3 | Captured from the extracted beta ZIP | yes |
| `store-assets/store-assets-report.json` | Provenance report, labelled `local-precommit` | `npm run assets:promote` | yes |
| `store-assets/preview.html` | Offline contact sheet (icon on light, dark and grey backgrounds and at reduced sizes, tile at full and half size, screenshots at 640×400) | Generated | yes |
| `artifacts/store-assets/*` | Fresh output of each run, plus `capture.json` | `npm run assets:store` | no (git-ignored) |

The preview page loads only its neighbouring PNGs and one inline `data:`
image. Its Content-Security-Policy blocks everything else.

### Store icon

`assets-src/icon-store.svg` uses the existing document-and-return-arrow
artwork and blue (`#2456a6`), scaled from the 120 px tile to a 96 px tile at
x/y 16–112. A clip path at exactly that square keeps the rounded corners'
anti-aliasing out of the padding. Without it, Chromium left one pixel with
alpha 4 at x = 15. `npm run icons` renders it directly at 128×128 with
Playwright's bundled Chromium. The 16/32/48 sizes still come from
`icon-16.svg` and `icon.svg` and re-render identically.

Measured from the PNG (the generator, `npm run assets:store` and
`tests/unit/store-assets.test.ts` all repeat this check):

- 128×128 px, 2,760 bytes.
- Pixels with alpha > 0 span x 16–111 and y 16–111: 96×96 artwork.
- Fully transparent margin of at least 16 px on every side. Before this
  task the artwork spanned x/y 4–123, a 120×120 tile with a 4 px margin.
- Inspected at 128, 64, 48 and 32 px on white, `#202124` and grey (see
  `store-assets/preview.html`). The white page and blue tile stay distinct
  on all three backgrounds.

Regenerate with `npm run icons` after editing an icon SVG.

### Small promotional tile

`store-assets/source/small-promo-tile.svg` is original artwork: the
extension's icon, enlarged on a saturated blue gradient, next to three
abstract refund records, one per item. Each record has a coloured dot and
two bars. The tile has no text, numbers, currency signs, check marks, badges,
UI, customer figures or third-party logos. It is rendered directly at
440×280. It was inspected at full and half size (220×140) and stays legible.

## Commands

```sh
npm run assets:store      # package:beta, then the tile and 3 screenshots, validation, report and preview in artifacts/store-assets/
npm run assets:store -- --reuse-package   # use the verified ZIP already in artifacts/beta/ (as CI does)
npm run assets:promote    # copy the last local run into store-assets/ (labelled local-precommit)
npm run icons             # re-render public/icons/*.png from assets-src/*.svg
```

`npm run assets:store` does the following:

1. Runs `npm run package:beta` to make a fresh production build and a
   verified ZIP. With `--reuse-package` it uses the ZIP already in
   `artifacts/beta/`.
2. Runs `playwright test -c playwright.store.config.ts`
   (`tests/store/store-assets.spec.ts`):
   - It renders the tile SVG at 440×280.
   - It checks the ZIP against its `.sha256` and `.report.json`.
   - It extracts the ZIP into a new temporary directory and launches
     Playwright's bundled Chromium with a new profile in that directory. It
     never uses `dist/`, a test copy with extra host permissions or your own
     Chrome profile.
   - It deletes only that temporary directory at the end.
3. Validates the outputs:
   - Exact dimensions, the screenshot count and full-bleed opacity.
   - The ZIP's `icons/icon-128.png` alpha bounds and 16 px margin.
   - All four ZIP icons equal `public/icons`.
   - No listing material in the ZIP inventory.
   - The screenshots were captured from that same ZIP.
4. Writes `store-assets-report.json` and `preview.html`.

The beta ZIP's own allowlist (`scripts/beta/verify.ts`) rejects any file
that is not a production page, script, style or one of the four icons. It is
unchanged, and listing images, sources, reports and profiles cannot enter
the ZIP.

## How the screenshots are made

**Real UI only.** The capture goes through the real flow:

- **How Refund Reconciler handles your data** → **Agree and continue**.
- **Protect your records**, with a random throwaway passphrase created for
  that run. It is typed only into the password fields on the setup screen,
  which are never captured. It is never written to a file or committed, and
  the profile is deleted afterwards.
- **Create case** and the item buttons (**Record merchant report**,
  **Confirm money received**). The same forms a user fills in.

**What it never does.** No storage record is injected, and no ledger response
is faked. No DOM text, amount or CSS is changed, and no product warning is
hidden.

**Checks before each capture.**

- Before capture, the page is reloaded once. The dashboard stays unlocked in
  the same browser session, and the reload clears the "Entry saved." notice
  that ordinary use would have shown.
- Every pictured state is asserted in the UI first.
- The totals and per-item figures are cross-checked against the worker's own
  `read` command, using the production derivation functions.
- Each capture asserts there is no notice, no open form and no password
  field on the page.

**Size and scale.** Screenshots are taken from a 960×600 CSS-px viewport at
device scale factor 4/3, as on a high-density display, which gives exactly
1280×800 pixels. Locale and time zone are `en-US` and `America/New_York`.
This keeps text legible when the store shows the images at 640×400. The
layout is the product's own responsive layout at that width. Positioning
uses ordinary page scrolling and the visible viewport only, with no
full-page capture.

### Scenario data (all synthetic)

| Case | Items | Evidence entered | Resulting state |
| --- | --- | --- | --- |
| `SYNTHETIC-1001` | Synthetic wool blanket, expected $64.00 | Merchant report $64.00 dated 2026-09-21 (ref `SYNTHETIC-OBS-1`); money received $40.00 dated 2026-09-24 (ref `SYNTHETIC-STMT-1`) | Partially confirmed, $24.00 unresolved |
| `SYNTHETIC-1002` | Synthetic desk lamp, expected $35.00 | Money received $35.00 (2026-09-18); merchant report $30.00 (2026-09-19) | Needs review: merchant report conflicts with confirmed receipts |
| `SYNTHETIC-1003` | Synthetic phone case, expected $18.50; Synthetic cable bundle, unknown amount | Merchant report $18.50 (2026-09-27) | Open: $18.50 unresolved, 1 unknown |
| `SYNTHETIC-1004` | Synthetic headphones, expected $89.99 | Money received $89.99 (2026-09-15) | Settled |

The overview, verified in the UI and against the worker read, totals four
real (non-demo) cases and no demo cases:

- Unresolved expected amounts: **$42.50**
- Items with unknown amounts: **1**
- Cases needing attention: **3**
- Cases needing review: **1**

"Recorded" and "Generated" times are the real clock time of the run. Entry
dates are synthetic and precede it.

### Recommended order and captions

Captions are suggestions for the listing. They are not in the images.

1. `screenshot-1-overview-1280x800.png`. **Overview and case list.** It
   shows the overview figures above, the search box, the **Status** filter
   and **Clear filters**, plus three of the four case rows: Settled, Open
   with 1 unknown, and Needs review.
   Caption: *"See which returned items still have unresolved refund
   evidence. Totals come only from what you record."*
2. `screenshot-2-item-evidence-1280x800.png`. **One item's refund evidence.**
   Case `SYNTHETIC-1001`: Open, $24.00 unresolved, $40.00 confirmed net. The
   item card shows Expected $64.00, **Merchant reports issued** $64.00,
   **Confirmed received** $40.00 and Difference $24.00, the **Partially
   confirmed** badge, and the warning "Merchant reports more issued than you
   have confirmed received."
   Caption: *"Merchant reports and the money you confirmed are kept apart,
   item by item."*
3. `screenshot-3-case-summary-1280x800.png`. **Plain-text summary.** The real
   **Case summary preview** for `SYNTHETIC-1001`:
   - **Include evidence details** is unticked, with its note that details
     may contain private text.
   - The panel says the user sends or shares the text themselves and that
     the extension sends nothing.
   - The read-only text begins with `Evidence details: omitted`.

   The backup panel is not shown. It is a separate view.
   Caption: *"Prepare a plain-text case summary to share yourself. Details
   stay out unless you include them."*

Deliberately **not** pictured:

- **A capture or refund preview.** No validated real Amazon refund line
  exists, and fixture pages run only in a test copy with extra host
  permissions, which would misrepresent the production extension.
- **The toolbar popup or a toolbar grant.** The harness cannot click
  Chrome's real toolbar button, and the screenshots do not show that it
  works.
- **Recharge or void history, and the backup panel.** They would not fit
  legibly.

## Provenance

`store-assets-report.json` records:

- the generation label;
- the extension name, version, permissions and data-practices version;
- the production ZIP's file name, bytes and SHA-256, with its `sourceCommit`
  and `checkoutCommit`;
- the checkout and dirty-tree status of the run;
- the actual Chromium version;
- the capture viewport and scale;
- the verified scenario figures;
- the store icon's measurements;
- for each output, its dimensions, bytes, SHA-256 and scenario.

Generation labels:

- **`ci-final-head`**: written only by the Ubuntu CI job when
  `GITHUB_ACTIONS` and `BETA_SOURCE_COMMIT` are set.
  `BETA_SOURCE_COMMIT` follows the existing convention: the pull request's
  head commit, or the pushed commit. `checkoutCommit` is the merge commit
  that GitHub actually built for a pull request. CI runs
  `npm run assets:store -- --reuse-package` after the package and update
  checks, so the screenshots come from the same ZIP that is uploaded as
  `refund-reconciler-beta`. It then checks that the report's
  `package.sha256` equals that ZIP's `.sha256`, that `package.sourceCommit`
  equals the head, and that the label is `ci-final-head`. It uploads the
  PNGs, `store-assets-report.json`, `capture.json` and `preview.html` as a
  **separate** artifact, **`refund-reconciler-store-assets`** (kept 14
  days).
- **`local`**: any other run. It is written only to
  `artifacts/store-assets/`.
- **`local-precommit`**: the committed copies in `store-assets/`, produced
  by `npm run assets:promote` from a local run. They were generated before
  they were committed, from the checkout named in `generatedFrom`. They are
  **not** final-head output, and the commit that adds them is necessarily
  later. The CI artifact for the pull request head is the final-head
  record. Committed reports are not regenerated to chase their own commit
  hash.

**What the hashes mean.** They identify exact files for integrity. Text
rendering differs across operating systems and fonts, so no test compares
PNG hashes across runs or platforms. The checks are dimensions, count,
opacity, the icon's alpha bounds and the scenario assertions.

**Committed copies (local-precommit).** Generated in a Linux container from
the clean checkout `7dab474` (Task 11 tooling commit) with Chromium
141.0.7390.37 (Playwright 1.56.1), from
`refund-reconciler-beta-0.8.0.zip`:

- 85,563 bytes
- SHA-256 `79cc8f5ebae2780723ab4b4ba84b9d6a64f0462548b523476a3a46eb8365bfd8`
- `sourceCommit` `7dab474`

The exact bytes and hashes of each image are in
`store-assets/store-assets-report.json`.

## Still for the owner

These are not decided here (see [readiness.md](readiness.md#publisher-inputs-pending)):

- publisher name and contact;
- hosted policy URL and effective date;
- distribution choices;
- the exact Developer Dashboard privacy labels;
- an owner-operated toolbar check of 0.8.0;
- real refund wording;
- whether to add up to two more screenshots or a marquee;
- the store review itself.
