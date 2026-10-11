// The local consent receipt (consent format 1) and its strict validation.
// Pure: no storage. It holds only nonprivate metadata: which version of the
// data practices was agreed to and when the service worker recorded it. No
// ledger data, passphrase, key, identifier, selected text, address or device
// detail belongs here. See docs/consent.md.

import { isIsoTimestamp } from '../domain/validate';
import { DATA_PRACTICES_VERSION } from './practices';

export const CONSENT_FORMAT = 'refund-reconciler-consent';

export interface ConsentReceipt {
  readonly format: typeof CONSENT_FORMAT;
  readonly formatVersion: 1;
  /** The DATA_PRACTICES_VERSION shown when the user chose Agree and continue. */
  readonly dataPracticesVersion: number;
  /** Written by the service worker at the moment it stored the agreement. */
  readonly acceptedAt: string;
}

/**
 * missing: never agreed in this profile (or erased). invalid: something is
 * stored but it is not a valid receipt. obsolete: a valid receipt for a
 * different data-practices version. Only `accepted` lets data features run.
 */
export type ConsentStatus =
  | { readonly status: 'accepted'; readonly receipt: ConsentReceipt }
  | { readonly status: 'missing' }
  | { readonly status: 'invalid' }
  | { readonly status: 'obsolete'; readonly version: number };

export function makeReceipt(acceptedAt: string): ConsentReceipt {
  return { format: CONSENT_FORMAT, formatVersion: 1, dataPracticesVersion: DATA_PRACTICES_VERSION, acceptedAt };
}

/** Strict: exact keys and types. Never repairs, migrates or defaults anything, and never treats damage as agreement. */
export function parseConsent(raw: unknown, required: number = DATA_PRACTICES_VERSION): ConsentStatus {
  if (raw === undefined) return { status: 'missing' };
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return { status: 'invalid' };
  const o = raw as Record<string, unknown>;
  const keys = ['format', 'formatVersion', 'dataPracticesVersion', 'acceptedAt'];
  if (Object.keys(o).length !== keys.length || !keys.every((k) => k in o)) return { status: 'invalid' };
  if (o.format !== CONSENT_FORMAT || o.formatVersion !== 1 || !isIsoTimestamp(o.acceptedAt)) return { status: 'invalid' };
  const v = o.dataPracticesVersion;
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 1) return { status: 'invalid' };
  if (v !== required) return { status: 'obsolete', version: v };
  return { status: 'accepted', receipt: { format: CONSENT_FORMAT, formatVersion: 1, dataPracticesVersion: v, acceptedAt: o.acceptedAt } };
}
