import { defineConfig } from '@playwright/test';

// Chrome Web Store listing images: renders the promotional tile and captures
// screenshots from the extracted beta ZIP (not dist/) in a disposable profile.
// Run through `npm run assets:store`, which packages the beta first and then
// validates the outputs and writes the provenance report (docs/store/assets.md).
export default defineConfig({
  testDir: 'tests/store',
  timeout: 120_000,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  outputDir: 'test-results/store',
  use: { trace: 'retain-on-failure' },
});
