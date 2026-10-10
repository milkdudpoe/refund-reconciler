// Wiring of the same-installation update check (tests/update/): CI must fetch
// exactly the baseline commit the check builds, and run the check.

import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BASELINES, BASELINE_050, BASELINE_060, fetchHint } from '../update/baseline';

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
  it('pins immutable full commit ids of the two earlier production versions', () => {
    expect(BASELINES.map((b) => b.version)).toEqual(['0.5.0', '0.6.0']);
    expect(BASELINE_050.commit).toBe('b323930f7d9580f426e7e8fee39b4242143c4844');
    expect(BASELINE_060.commit).toBe('60e330b12d195908a44ad341a73e34678a5a697d');
    for (const b of BASELINES) expect(b.commit).toMatch(/^[0-9a-f]{40}$/);
  });

  it('CI fetches every baseline commit before each npm run test:update, in LF and CRLF checkouts', async () => {
    const ci = await readFile(join(ROOT, '.github', 'workflows', 'ci.yml'), 'utf8');
    const lf = ci.replace(/\r\n/g, '\n');
    for (const text of [lf, lf.replace(/\n/g, '\r\n')]) {
      const lines = text.split(/\r?\n/);
      const runs = lines.flatMap((l, i) => (l.trim().replace(/^- /, '') === 'run: npm run test:update' ? [i] : []));
      // Ubuntu and Windows jobs both run the check.
      expect(runs).toHaveLength(2);
      for (const b of BASELINES) {
        const fetches = lines.flatMap((l, i) => (l.trim().replace(/^- /, '') === `run: ${fetchHint(b)}` ? [i] : []));
        expect(fetches, b.version).toHaveLength(2);
        expect(fetches[0]!).toBeLessThan(runs[0]!);
        expect(fetches[1]!).toBeGreaterThan(runs[0]!);
        expect(fetches[1]!).toBeLessThan(runs[1]!);
      }
      expect(stepIndex(text, 'run: npm run test:update')).toBeGreaterThan(0);
    }
  });

  it('matches whole logical lines only', () => {
    const hint = fetchHint(BASELINE_060);
    const steps = `      - name: x\r\n        run: ${hint}\r\n      - run: npm run test:update\r\n`;
    expect(stepIndex(steps, `run: ${hint}`)).toBe(1);
    expect(stepIndex(steps, 'run: npm run test:update')).toBe(2);
    expect(stepIndex(`        run: ${hint} extra\n`, `run: ${hint}`)).toBe(-1);
    expect(stepIndex(`        run: ${hint.replace(BASELINE_060.commit, BASELINE_060.commit.slice(0, 7))}\n`, `run: ${hint}`)).toBe(-1);
  });

  it('npm run test:update packages the beta first and uses its own Playwright config', async () => {
    const pkg = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8')) as { scripts: Record<string, string> };
    expect(pkg.scripts['test:update']).toBe('npm run package:beta && playwright test -c playwright.update.config.ts');
    expect(pkg.scripts.check).toContain('npm run test:update');
  });
});
