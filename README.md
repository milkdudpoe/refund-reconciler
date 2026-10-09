# Refund Reconciler

A local Chrome extension (Manifest V3) that helps you see which return/refund
records are unresolved or contradictory, item by item.

> **Status: Task 01 foundation — not a validated product.** Everything is
> entered manually or comes from clearly labelled synthetic examples.
> Automatic Amazon capture and any payment/commercial validation have **not**
> been built yet. The tool tracks evidence; it does not move money, file
> disputes, or establish legal entitlement to a refund.

Scope: Amazon US orders, USD only.

## Requirements

- Node.js **22.12 or newer** (developed with 22.22.0, see `.nvmrc`) and npm 10.
- Chrome/Chromium 120+ to load the extension.
- Browser tests use Playwright **1.56.1**'s bundled Chromium. If it is not
  already present, run `npx playwright install chromium` once.

## Commands

```sh
npm ci              # install exact versions from package-lock.json
npm run typecheck   # tsc --noEmit
npm run lint        # eslint
npm test            # Vitest unit tests (domain, validation, persistence, handler)
npm run build       # Vite build of the extension into dist/
npm run test:e2e    # build, then Playwright tests against the real unpacked extension
npm run check       # all of the above
```

## Install the unpacked extension

1. `npm ci && npm run build`
2. Open `chrome://extensions`, switch on **Developer mode**.
3. Click **Load unpacked** and choose the `dist/` folder.
4. Click the Refund Reconciler toolbar button (pin it from the puzzle-piece
   menu if needed). The dashboard opens in a new tab.

After rebuilding, press the reload icon on the extension's card.

## Permissions and data

| Permission | Why |
| --- | --- |
| `storage` | Saves your cases in `chrome.storage.local` in this browser profile. |

No host permissions, content scripts, network requests, analytics, remote code
or model calls. All JavaScript is bundled into `dist/`. The toolbar button uses
`chrome.action`/`chrome.tabs.create`, which need no extra permission.

**What is stored:** one key, `refundReconciler.store`, containing your cases:
optional order reference, item descriptions, expected amounts, and every
merchant report, receipt confirmation, recharge, void and expected-amount edit
you enter (amounts, optional dates, references, sources, notes and the time
each was recorded). Data stays in this browser profile and is **not
encrypted** by the extension; anyone with access to the profile can read it.
It is not synced (`chrome.storage.sync` is not used).

**What is deleted:**
- *Delete case…* → *Permanently delete* removes that case, its items and all
  its evidence from storage.
- *Remove synthetic demo* removes only the demo cases.
- If stored data is unreadable or from an unsupported version, the dashboard
  shows it read-only and blocks changes. *Erase stored data…* → *Permanently
  erase* removes the whole key; nothing is erased automatically.
- Removing the extension from Chrome deletes all of its stored data.

## Project layout

```
src/domain/       pure model, money parsing, derivations, ledger, runtime validation
src/persistence/  chrome.storage.local read/write (validated, never auto-reset)
src/background/   service worker: message validation + serialised writes
src/ui/           dashboard (plain TS + CSS, text-only rendering)
public/manifest.json
tests/unit/       Vitest
tests/e2e/        Playwright MV3 extension harness (persistent Chromium profile)
docs/             product scope and data model
```

See [docs/product-scope-and-data-model.md](docs/product-scope-and-data-model.md)
for the derivation rules, limitations and next milestone.

## Known dev-tooling advisories

`npm audit` reports advisories in Vitest 3.2's dev-only dependencies
(`tinypool`, `@vitest/mocker`). The fix requires a Vitest major upgrade that
npm 10.9 currently fails to resolve; nothing from these packages ships in
`dist/` (`npm audit --omit=dev` is clean). Revisit when upgrading Vitest.
