// Renders the shared data-practices text (src/consent/practices.ts). Used by
// the consent screen before agreement and by "Data and privacy" in the
// dashboard header, which can be reread at any time. Static: rendering or
// reading it never reads or writes saved data.

import { DATA_PRACTICES } from '../consent/practices';
import { h } from './dom';

export const PRIVACY_ID = 'privacy-guide';

/** The explanation itself: one heading (at `level`) and a short list per section. */
export function renderPracticeSections(level: 'h3' | 'h4', idPrefix: string): Node[] {
  return DATA_PRACTICES.sections.map((s) =>
    h(
      'section',
      { class: 'practice', 'aria-labelledby': `${idPrefix}-${s.id}`, 'data-practice': s.id },
      h(level, { id: `${idPrefix}-${s.id}` }, s.title),
      h('ul', {}, ...s.points.map((p) => h('li', {}, p))),
    ),
  );
}

export function practicesVersionNote(): Node {
  return h('p', { class: 'muted small', 'data-testid': 'practices-version' }, `Data-practices version ${DATA_PRACTICES.version}. Agreement is stored only in this browser profile, separately from your records.`);
}

/**
 * "Data and privacy" in the dashboard header: the same text, to reread after
 * agreeing (or before). Built once, outside the app's render tree like the
 * guide, so opening it never closes a form, clears a draft, changes the
 * agreement or touches storage. It has no agreement button.
 */
export function buildPrivacy(): HTMLDetailsElement {
  return h(
    'details',
    { id: PRIVACY_ID, class: 'help', 'data-testid': 'privacy' },
    h('summary', { id: 'privacy-summary' }, 'Data and privacy'),
    h(
      'div',
      { class: 'help-body' },
      h('p', {}, h('strong', {}, `${DATA_PRACTICES.heading}. `), 'This is the explanation shown before you agree. Reading it here changes nothing.'),
      ...renderPracticeSections('h4', 'privacy'),
      practicesVersionNote(),
    ),
  );
}
