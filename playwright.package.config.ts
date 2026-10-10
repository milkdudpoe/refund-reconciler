import { defineConfig } from '@playwright/test';

// Archive smoke test: extracts the real beta ZIP from artifacts/beta/ and loads
// that extracted copy (not dist/) as an unpacked MV3 extension. Run through
// `npm run test:package`, which builds and verifies the package first.
export default defineConfig({
  testDir: 'tests/package',
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  outputDir: 'test-results/package',
  use: { trace: 'retain-on-failure' },
});
