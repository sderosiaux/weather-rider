// Tiny DOM builder. Strings become text nodes (never parsed as HTML).
type Child = Node | string | null | undefined | false
type Attrs = Record<string, string | number | boolean | null | undefined>

export const h = <K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Attrs | string = {},
  ...children: (Child | Child[])[]
): HTMLElementTagNameMap[K] => {
  const el = document.createElement(tag)
  if (typeof attrs === 'string') el.className = attrs
  else
    for (const [k, v] of Object.entries(attrs)) {
      if (v === null || v === undefined || v === false) continue
      if (k === 'class') el.className = String(v)
      else if (v === true) el.setAttribute(k, '')
      else el.setAttribute(k, String(v))
    }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue
    el.append(c)
  }
  return el
}

const SVG_NS = 'http://www.w3.org/2000/svg'
export const svg = <K extends keyof SVGElementTagNameMap>(tag: K, attrs: Attrs = {}, ...children: SVGElement[]): SVGElementTagNameMap[K] => {
  const el = document.createElementNS(SVG_NS, tag)
  for (const [k, v] of Object.entries(attrs)) if (v !== null && v !== undefined && v !== false) el.setAttribute(k, String(v))
  el.append(...children)
  return el
}

/** Writes only when the value changed: keeps per-frame HUD updates free of redundant DOM work. */
export const createWriter = () => {
  const text = new WeakMap<Node, string>()
  const style = new WeakMap<HTMLElement | SVGElement, Map<string, string>>()
  const flags = new WeakMap<Element, Map<string, boolean>>()
  return {
    text(el: Node, value: string): void {
      if (text.get(el) === value) return
      text.set(el, value)
      el.textContent = value
    },
    style(el: HTMLElement | SVGElement, prop: string, value: string): void {
      let m = style.get(el)
      if (!m) style.set(el, (m = new Map()))
      if (m.get(prop) === value) return
      m.set(prop, value)
      el.style.setProperty(prop, value)
    },
    flag(el: Element, cls: string, on: boolean): void {
      let m = flags.get(el)
      if (!m) flags.set(el, (m = new Map()))
      if (m.get(cls) === on) return
      m.set(cls, on)
      el.classList.toggle(cls, on)
    },
    attr(el: Element, name: string, value: string): void {
      if (el.getAttribute(name) !== value) el.setAttribute(name, value)
    },
  }
}
export type Writer = ReturnType<typeof createWriter>
