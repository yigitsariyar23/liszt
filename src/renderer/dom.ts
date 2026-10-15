export function h<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  if (text !== undefined) el.textContent = text;
  return el;
}

export function iconEl(svg: string, cls: string): HTMLElement {
  const el = h('span', cls);
  el.innerHTML = svg;
  return el;
}
