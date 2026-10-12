# Refund Reconciler {{VERSION}}: start here

This folder prepares the first **unlisted free beta** submission to the
Chrome Web Store. It is **prepared** only: nothing has been uploaded,
submitted, approved or published. You do every dashboard step yourself.

## What to upload

**Upload only `extension/{{PACKAGE_FILE}}`**
({{PACKAGE_BYTES}} bytes, SHA-256 `{{PACKAGE_SHA256}}`).
Do not unzip it for upload. This outer handoff archive (`{{OUTER_FILE}}`)
is **not** an extension; never upload it.

Check the inner ZIP before using it:

- macOS/Linux: `shasum -a 256 extension/{{PACKAGE_FILE}}`
- Windows PowerShell: `Get-FileHash extension\{{PACKAGE_FILE}}`

The result must equal the SHA-256 above. `inventory.json` lists every other
file here with its size and SHA-256.

## Contents

| File | Use |
| --- | --- |
| `extension/{{PACKAGE_FILE}}` | The package to upload (with its `.sha256` and build report) |
| `listing-description.txt` | Paste into the Store listing **Description** field |
| `images/` | Store icon, promo tile and three screenshots, in order; see `images/README.txt` |
| `privacy-and-permissions.md` | Privacy tab answers and the decisions left to you |
| `reviewer-instructions.txt` | Optional test instructions for reviewers |
| `inventory.json` | Sizes, SHA-256 and provenance of every file except itself |

## Comes from the ZIP vs. typed in the dashboard

Chrome takes these from the manifest inside the ZIP; they cannot be edited in
the dashboard without a new ZIP and version
([Prepare your extension](https://developer.chrome.com/docs/webstore/prepare)):

- Name: **{{EXTENSION_NAME}}**
- Short description ({{MANIFEST_DESCRIPTION_LENGTH}} characters): "{{MANIFEST_DESCRIPTION}}"
- Version **{{VERSION}}**, the 128 px icon, and the permissions `storage`,
  `activeTab`, `scripting`.

Typed or uploaded in the dashboard: the detailed description, category,
language, images, homepage and support URLs, privacy answers, distribution
and test instructions. The alternative summary drafted in
`docs/store/listing.md` is **not** used: the dashboard shows the manifest
description above.

## Steps, in order

1. **Run the desktop Chrome check below** and send the reply. It has
   **not been run** for {{VERSION}}; the old 0.6.0 result does not count.
2. **Decide on the known limitation.** Capture from real Amazon refund pages
   is **untested**: it has only been tested on example text. The listing and
   reviewer text say so. Submitting with that limitation is your explicit
   decision after step 1. (Testing a real refund line of your own is
   optional; never send its text or screenshots to anyone.)
3. **Developer account.** Sign in to the Chrome Web Store Developer
   Dashboard and finish any registration it asks for. Account setup,
   publisher display name ({{PUBLISHER}}) and contact email have not been
   inspected; a working policy URL does not make you a verified publisher.
4. **Add new item** and upload `extension/{{PACKAGE_FILE}}`. Confirm the
   Package tab shows **{{EXTENSION_NAME}}**, version **{{VERSION}}**.
5. **Store listing**
   ([listing fields](https://developer.chrome.com/docs/webstore/cws-dashboard-listing)):
   - Description: paste `listing-description.txt` unchanged.
   - Category: **Productivity** recommended (or the closest Productivity
     sub-category the dashboard offers). *Recommendation, not your choice
     yet.*
   - Language: English.
   - Images: `images/icon-128.png` (if asked), `images/small-promo-tile-440x280.png`,
     then screenshots 1, 2, 3 in that order.
   - Homepage URL: {{HOMEPAGE_URL}}
   - Support URL: {{SUPPORT_URL}}
   - Leave "Official URL" alone: it needs a verified site.
6. **Privacy tab**: follow `privacy-and-permissions.md`. Policy URL:
   {{POLICY_URL}}. You decide the data-type mapping and the certifications
   after reading the dashboard's own definitions.
7. **Distribution**
   ([distribution](https://developer.chrome.com/docs/webstore/cws-dashboard-distribution)):
   - Visibility: **Unlisted** (your choice). No public listing; anyone with
     the store link can install. Unlisted items get the same review as
     public ones.
   - Free: no payment or in-app purchases. If the dashboard asks, choose
     the free option.
   - Regions: **United States only** recommended, because the extension
     supports Amazon US orders in US dollars. *Recommendation; confirm in
     the dashboard.*
8. **Test instructions** (optional;
   [test instructions](https://developer.chrome.com/docs/webstore/cws-dashboard-test-instructions)):
   no credentials are needed. If the tab has a free-text field, you may
   paste `reviewer-instructions.txt`.
9. **Submit for review** when steps 1–8 are done
   ([publish](https://developer.chrome.com/docs/webstore/publish)). To control
   when it goes live, untick automatic publishing in the confirmation dialog
   (deferred publishing); after approval you then have 30 days to publish.
   Google reviews **after** you submit; approval is a later outcome, not a
   step before submitting.
10. **Tell me the outcome** (submitted / approved / rejected, with the
    general reason). The website keeps saying "not in the Chrome Web Store"
    until a separate release task after actual publication.

Chrome documentation read on {{DOCS_CHECKED}}. The account-specific screens
were not seen; labels in your dashboard may differ.

## Desktop Chrome check ({{VERSION}})

Use a **fresh throwaway Chrome profile** (profile menu → Add → continue
without an account). No sign-in, no real orders, no private data.

Setup: unzip `extension/{{PACKAGE_FILE}}` into a new empty folder. Open
`chrome://extensions`, turn on **Developer mode**, choose **Load unpacked**
and pick that folder.

1. **Before agreement.** The card must show version **{{VERSION}}**. Pin the
   icon from the puzzle-piece menu. Open the public `https://www.amazon.com`
   homepage and click the **toolbar icon**. Expected: **Open dashboard to
   review** and no Capture control.
2. **Agree and protect.** Click **Open dashboard to review** → **Agree and
   continue**. On **Protect your records**, type a throwaway passphrase
   twice, tick the acknowledgment, **Protect my records**. Do not create
   cases or load the demo.
3. **Selection check.** On the Amazon tab, highlight ordinary text (for
   example a product name), click the toolbar icon, choose **Capture
   selected refund text**.
   - Pass: **Cannot propose a report from this selection**. Choose
     **Discard**. Reload the dashboard: it must still have no cases.
   - **No text is selected** (highlight lost): try once more; if it repeats,
     the result is *inconclusive*.
   - Fail: **Refund Reconciler has no access to this tab** after a real
     toolbar click, or a preview offering to save a refund report from
     ordinary text.
4. **Locked.** In the dashboard choose **Lock now**. On the Amazon tab click
   the toolbar icon. Expected: **Open dashboard to unlock** and no Capture
   control. Unlock in the dashboard; then the toolbar popup on the Amazon tab
   must offer **Capture selected refund text** again.

Afterwards you can delete the throwaway profile.

### Reply template

Do **not** send the selected text, your passphrase, the profile, a backup,
order screenshots or any account details.

```
Extension version: 
Chrome version (chrome://version): 
Before-agreement gate: pass / fail / inconclusive
Selection check: pass / fail / inconclusive
General outcome (popup heading or message, no selected text): 
Dashboard empty afterwards: yes / no
Locked gate: pass / fail / inconclusive
```

## Still open (your decisions)

- Desktop Chrome check result (above).
- Submitting with real Amazon refund wording untested.
- Developer account setup and publisher details.
- Category and regions (recommendations above).
- Privacy data-type mapping and certifications.
- Whether to paste the reviewer instructions.
