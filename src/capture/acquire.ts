// Acquisition: reads the user's selection from one fixed source tab. It only
// returns text; interpretation is in parse.ts and nothing here touches the
// ledger. The tab id is resolved once, when the toolbar UI opens, and every
// step targets that id, so the dashboard or another tab is never captured.

import { collectSelection, type CollectorResult } from './collector';
import { EXCERPT_MAX_CHARS } from './parse';
import { analyzeSourceUrl, checkSourceUrl, type SourceProblem } from './source';
import type { OrderContext } from './order';
import type { CaptureOrigin } from '../domain/types';

export type AcquireProblem =
  | SourceProblem
  | 'no_tab'
  | 'tab_closed'
  | 'navigated'
  | 'empty'
  | 'editable'
  | 'too_long'
  | 'injection_failed';

export type AcquireResult =
  | { ok: true; text: string; sourceOrigin: CaptureOrigin; sourcePath: string | null; sourceOrder: OrderContext }
  | { ok: false; problem: AcquireProblem; length?: number };

export interface AcquireDeps {
  /** chrome.tabs.get: rejects if the tab no longer exists. `url` is only visible with access. */
  getTab(tabId: number): Promise<{ url?: string | undefined }>;
  /** chrome.scripting.executeScript for one function in the main frame's isolated world. */
  inject(tabId: number, maxChars: number): Promise<unknown>;
}

export function chromeAcquireDeps(): AcquireDeps {
  return {
    getTab: (tabId) => chrome.tabs.get(tabId),
    async inject(tabId, maxChars) {
      const results = await chrome.scripting.executeScript({
        target: { tabId, frameIds: [0] },
        world: 'ISOLATED',
        func: collectSelection,
        args: [maxChars],
      });
      return results.find((r) => r.frameId === 0)?.result;
    },
  };
}

function isCollectorResult(v: unknown): v is CollectorResult {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Record<string, unknown>;
  if (typeof o.href !== 'string') return false;
  switch (o.status) {
    case 'ok':
      return typeof o.text === 'string';
    case 'too_long':
      return typeof o.length === 'number';
    case 'empty':
    case 'editable':
      return true;
    default:
      return false;
  }
}

function classifyInjectionError(err: unknown): AcquireProblem {
  const message = err instanceof Error ? err.message : String(err);
  if (/No tab with id/i.test(message)) return 'tab_closed';
  if (/frame.*(removed|not found)|document.*(unloaded|removed)|navigat/i.test(message)) return 'navigated';
  if (/Cannot access|permission|host/i.test(message)) return 'no_access';
  if (/chrome:\/\/|extensions gallery|cannot be scripted/i.test(message)) return 'restricted';
  return 'injection_failed';
}

/**
 * Reads the selection from `tabId`. `expectedOrigin` is the origin seen when the
 * toolbar UI opened; a different origin now means the tab navigated away.
 */
export async function acquireSelection(deps: AcquireDeps, tabId: number | null, expectedOrigin: string | null): Promise<AcquireResult> {
  if (tabId === null) return { ok: false, problem: 'no_tab' };
  let tab: { url?: string | undefined };
  try {
    tab = await deps.getTab(tabId);
  } catch {
    return { ok: false, problem: 'tab_closed' };
  }
  const before = checkSourceUrl(tab.url);
  if (!before.ok) return { ok: false, problem: before.problem };
  if (expectedOrigin !== null && before.origin !== expectedOrigin) return { ok: false, problem: 'navigated' };

  let raw: unknown;
  try {
    raw = await deps.inject(tabId, EXCERPT_MAX_CHARS);
  } catch (err) {
    return { ok: false, problem: classifyInjectionError(err) };
  }
  // Page-side output is untrusted: validate its shape and re-check the origin
  // of the document that actually ran the collector.
  if (!isCollectorResult(raw)) return { ok: false, problem: 'injection_failed' };
  const actual = checkSourceUrl(raw.href);
  if (!actual.ok) return { ok: false, problem: actual.problem === 'no_access' ? 'injection_failed' : 'navigated' };
  if (actual.origin !== before.origin) return { ok: false, problem: 'navigated' };
  switch (raw.status) {
    case 'empty':
    case 'editable':
      return { ok: false, problem: raw.status };
    case 'too_long':
      return { ok: false, problem: 'too_long', length: raw.length };
    case 'ok': {
      if (raw.text.length > EXCERPT_MAX_CHARS) return { ok: false, problem: 'too_long', length: raw.text.length };
      // The order context comes from the URL of the document that actually ran the collector.
      const source = analyzeSourceUrl(raw.href);
      return { ok: true, text: raw.text, sourceOrigin: actual.origin, sourcePath: source.path, sourceOrder: source.order };
    }
  }
}
