// Wiring of the same-installation update check (tests/update/): CI must fetch
// exactly the baseline commit the check builds, and run the check.

import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BASELINE_COMMIT, BASELINE_VERSION, FETCH_HINT } from '../update/baseline';

const ROOT = resolve(import.meta.dirname, '../..');

/**
 * Index of the first workflow line that is exactly `step` (ignoring indentation
 * and a leading list marker), or -1. Splits on LF or CRLF, so the result does
 * not depend on how Git checked the workflow out.
 */
function stepIndex(workflow: string, step: string): number {
  return workflow.split(/\r?\n/).findIndex((line) => line.trim().replace(/^- /, '') === step);
}

describe('update check wiring', () => {
  it('pins an immutable full commit id and the previous production version', () => {
    expect(BASELINE_COMMIT).toMatch(/^[0-9a-f]{40}$/);
    expect(BASELINE_VERSION).toBe('0.5.0');
  });

  it('CI fetches that exact commit and then runs npm run test:update, in LF and CRLF checkouts', async () => {
    const ci = await readFile(join(ROOT, '.github', 'workflows', 'ci.yml'), 'utf8');
    const lf = ci.replace(/\r\n/g, '\n');
    for (const text of [lf, lf.replace(/\n/g, '\r\n')]) {
      const fetchAt = stepIndex(text, `run: ${FETCH_HINT}`);
      const runAt = stepIndex(text, 'run: npm run test:update');
      expect(fetchAt).toBeGreaterThan(0);
      expect(runAt).toBeGreaterThan(fetchAt);
    }
  });

  it('matches whole logical lines only', () => {
    const steps = `      - name: x\r\n        run: ${FETCH_HINT}\r\n      - run: npm run test:update\r\n`;
    expect(stepIndex(steps, `run: ${FETCH_HINT}`)).toBe(1);
    expect(stepIndex(steps, 'run: npm run test:update')).toBe(2);
    expect(stepIndex(`        run: ${FETCH_HINT} extra\n`, `run: ${FETCH_HINT}`)).toBe(-1);
    expect(stepIndex(`        run: ${FETCH_HINT.replace(BASELINE_COMMIT, BASELINE_COMMIT.slice(0, 7))}\n`, `run: ${FETCH_HINT}`)).toBe(-1);
  });

  it('npm run test:update packages the beta first and uses its own Playwright config', async () => {
    const pkg = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8')) as { scripts: Record<string, string> };
    expect(pkg.scripts['test:update']).toBe('npm run package:beta && playwright test -c playwright.update.config.ts');
    expect(pkg.scripts.check).toContain('npm run test:update');
  });
});
