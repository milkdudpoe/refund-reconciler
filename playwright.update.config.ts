import { defineConfig } from '@playwright/test';

// Same-installation update check (0.5.0 -> current beta). Builds the baseline
// from its own source in a temporary folder and uses the real beta ZIP from
// artifacts/beta/. Run through `npm run test:update`, which packages first.
export default defineConfig({
  testDir: 'tests/update',
  timeout: 240_000,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  outputDir: 'test-results/update',
  use: { trace: 'retain-on-failure' },
});
