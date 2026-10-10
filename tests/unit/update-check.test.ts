// Wiring of the same-installation update check (tests/update/): CI must fetch
// exactly the baseline commit the check builds, and run the check.

import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BASELINE_COMMIT, BASELINE_VERSION, FETCH_HINT } from '../update/baseline';

const ROOT = resolve(import.meta.dirname, '../..');

describe('update check wiring', () => {
  it('pins an immutable full commit id and the previous production version', () => {
    expect(BASELINE_COMMIT).toMatch(/^[0-9a-f]{40}$/);
    expect(BASELINE_VERSION).toBe('0.5.0');
  });

  it('CI fetches that exact commit and then runs npm run test:update', async () => {
    const ci = await readFile(join(ROOT, '.github', 'workflows', 'ci.yml'), 'utf8');
    const fetchAt = ci.indexOf(`run: ${FETCH_HINT}\n`);
    const runAt = ci.indexOf('run: npm run test:update');
    expect(fetchAt).toBeGreaterThan(0);
    expect(runAt).toBeGreaterThan(fetchAt);
  });

  it('npm run test:update packages the beta first and uses its own Playwright config', async () => {
    const pkg = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8')) as { scripts: Record<string, string> };
    expect(pkg.scripts['test:update']).toBe('npm run package:beta && playwright test -c playwright.update.config.ts');
    expect(pkg.scripts.check).toContain('npm run test:update');
  });
});
