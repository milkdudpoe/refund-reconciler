// Minimal DOM builder. Children are appended as text nodes or elements only;
// user-provided strings can never become markup.

type Child = Node | string | number | null | undefined | false;
type Listeners = { [K in keyof HTMLElementEventMap]?: (ev: HTMLElementEventMap[K]) => void };
type AttrValue = string | number | boolean | null | undefined;
type Attrs = { on?: Listeners } & { [name: string]: AttrValue | Listeners };

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Attrs = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  const { on, ...rest } = attrs;
  for (const [name, value] of Object.entries(rest) as [string, AttrValue][]) {
    if (value === false || value === null || value === undefined) continue;
    if (name === 'value' && (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement)) {
      el.value = String(value);
      continue;
    }
    if (name === 'checked' && el instanceof HTMLInputElement) {
      el.checked = value === true;
      continue;
    }
    el.setAttribute(name, value === true ? '' : String(value));
  }
  if (on) {
    for (const [event, fn] of Object.entries(on)) {
      el.addEventListener(event, fn as EventListener);
    }
  }
  append(el, children);
  return el;
}

export function append(parent: Node, children: readonly Child[]): void {
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    parent.appendChild(typeof child === 'string' || typeof child === 'number' ? document.createTextNode(String(child)) : child);
  }
}

/** Replaces a container's content while keeping keyboard focus on the same control. */
export function replaceContent(container: HTMLElement, children: readonly Child[]): void {
  const active = document.activeElement;
  const focusId = active instanceof HTMLElement && container.contains(active) ? active.id : '';
  let selection: [number | null, number | null] | null = null;
  if (active instanceof HTMLInputElement && ['text', 'search'].includes(active.type)) {
    selection = [active.selectionStart, active.selectionEnd];
  }
  container.replaceChildren();
  append(container, children);
  if (focusId) {
    const next = document.getElementById(focusId);
    if (next) {
      next.focus();
      if (selection && next instanceof HTMLInputElement) next.setSelectionRange(selection[0], selection[1]);
    }
  }
}
