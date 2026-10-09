// Message protocol between the dashboard and the service worker. Every
// incoming message is validated at runtime before it is acted on.

import type { ApplyOutcome, Command, CommandErrorCode } from '../domain/types';
import { parseCommand, type Validation } from '../domain/validate';

export const ERASE_CONFIRMATION = 'ERASE ALL REFUND RECONCILER DATA';

export type Request =
  | { kind: 'mutate'; command: Command }
  | { kind: 'eraseAll'; confirm: typeof ERASE_CONFIRMATION };

export type ResponseErrorCode =
  | CommandErrorCode
  | 'invalid_message'
  | 'storage_unreadable'
  | 'storage_unsupported'
  /** Reading stored data failed before any write was attempted. Nothing changed. */
  | 'storage_error'
  /** The change could not be applied before writing. Nothing was written. */
  | 'not_applied'
  /** chrome.storage rejected the write, so it was not committed. */
  | 'write_rejected'
  /**
   * Set only by the dashboard when no valid response arrived (for example the
   * message channel failed). The write may or may not have been committed.
   */
  | 'outcome_unknown';

export type Response =
  | { ok: true; outcome: ApplyOutcome; revision: number }
  | { ok: false; error: { code: ResponseErrorCode; message: string } };

export function parseRequest(raw: unknown): Validation<Request> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, error: 'message: expected an object' };
  }
  const o = raw as Record<string, unknown>;
  if (o.kind === 'mutate') {
    if (Object.keys(o).some((k) => k !== 'kind' && k !== 'command')) return { ok: false, error: 'message: unexpected field' };
    const cmd = parseCommand(o.command);
    return cmd.ok ? { ok: true, value: { kind: 'mutate', command: cmd.value } } : cmd;
  }
  if (o.kind === 'eraseAll') {
    if (o.confirm !== ERASE_CONFIRMATION || Object.keys(o).length !== 2) {
      return { ok: false, error: 'message: erase requires explicit confirmation' };
    }
    return { ok: true, value: { kind: 'eraseAll', confirm: ERASE_CONFIRMATION } };
  }
  return { ok: false, error: 'message: unknown kind' };
}

export function isResponse(v: unknown): v is Response {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Record<string, unknown>;
  if (o.ok === true) return typeof o.outcome === 'string' && typeof o.revision === 'number';
  if (o.ok === false) {
    const e = o.error as Record<string, unknown> | null | undefined;
    return typeof e === 'object' && e !== null && typeof e.code === 'string' && typeof e.message === 'string';
  }
  return false;
}
