import { defineConfig } from '@playwright/test';

// Extension tests launch bundled Chromium with the built dist/ loaded as an
// unpacked MV3 extension (see tests/e2e/fixtures.ts). Run `npm run build` first.
export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 30_000,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  outputDir: 'test-results',
  use: { trace: 'retain-on-failure' },
});
