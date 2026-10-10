// The only code ever injected into a page. It is passed to
// chrome.scripting.executeScript as `func`, so it is serialised and must stay
// self-contained (no imports, no closures). It runs once, in the main frame's
// isolated world, after the user clicks Capture. It reads the current text
// selection and the page URL, and nothing else: no DOM walking, no clicks, no
// cookies, storage, screenshots or hidden state.

export type CollectorResult =
  | { status: 'ok'; href: string; text: string }
  | { status: 'empty'; href: string }
  | { status: 'editable'; href: string }
  | { status: 'too_long'; href: string; length: number };

export function collectSelection(maxChars: number): CollectorResult {
  const href = location.href;
  const active = document.activeElement;
  // Text selected inside a form field or an editable region is user input, not
  // a merchant record (and may be a password field).
  if (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement || active instanceof HTMLSelectElement) {
    if (active instanceof HTMLSelectElement || (active.selectionStart ?? 0) !== (active.selectionEnd ?? 0)) return { status: 'editable', href };
  }
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return { status: 'empty', href };
  for (const node of [selection.anchorNode, selection.focusNode]) {
    const el = node instanceof Element ? node : node?.parentElement;
    if (el && ((el instanceof HTMLElement && el.isContentEditable) || el.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"])'))) {
      return { status: 'editable', href };
    }
  }
  const text = selection.toString();
  // The over-limit text itself is never returned, so it cannot be parsed as if complete.
  if (text.length > maxChars) return { status: 'too_long', href, length: text.length };
  if (text.trim() === '') return { status: 'empty', href };
  return { status: 'ok', href, text };
}
