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

function toNode(child: Node | string | number): Node {
  return typeof child === 'string' || typeof child === 'number' ? document.createTextNode(String(child)) : child;
}

/**
 * Makes `parent`'s children exactly `children`, in order. Nodes that are
 * already in place stay attached (they are never removed and re-inserted), so a
 * reused element keeps its focus, caret and in-progress input.
 */
export function syncChildren(parent: Node, children: readonly Child[]): void {
  const nodes = children.filter((c): c is Node | string | number => c !== null && c !== undefined && c !== false).map(toNode);
  const keep = new Set(nodes);
  for (const c of [...parent.childNodes]) if (!keep.has(c)) parent.removeChild(c);
  let ref = parent.firstChild;
  for (const n of nodes) {
    if (n === ref) {
      ref = ref.nextSibling;
      continue;
    }
    parent.insertBefore(n, ref);
  }
}

/**
 * Replaces a container's content while keeping keyboard focus on the same
 * control. A reused element that stays attached keeps focus by itself; a
 * rebuilt one is re-focused by id with its selection restored.
 */
export function replaceContent(container: HTMLElement, children: readonly Child[]): void {
  const active = document.activeElement;
  const focusId = active instanceof HTMLElement && container.contains(active) ? active.id : '';
  let selection: [number | null, number | null, 'forward' | 'backward' | 'none' | null] | null = null;
  if (active instanceof HTMLInputElement && ['text', 'search'].includes(active.type)) {
    selection = [active.selectionStart, active.selectionEnd, active.selectionDirection];
  }
  syncChildren(container, children);
  if (focusId && !(active instanceof HTMLElement && active.isConnected && document.activeElement === active)) {
    const next = document.getElementById(focusId);
    if (next) {
      next.focus();
      if (selection && next instanceof HTMLInputElement) next.setSelectionRange(selection[0], selection[1], selection[2] ?? undefined);
    }
  }
}
