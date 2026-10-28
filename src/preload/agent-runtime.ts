// The page side of the agent tools (src/main/agent). Not a preload: main
// injects it into an isolated world of a page only when an agent calls a tool
// on that tab, so ordinary browsing never runs it. The page's own scripts
// cannot see or tamper with anything here (separate JS world); it only shares
// the DOM.
//
// Its job is to turn a page into something a language model can act on:
// - `snapshot`: the page as a compact accessibility tree. Elements an agent
//   can act on carry refs (`[e12]`) that main resolves back to elements.
// - `readPage`: the page's main content as Markdown, for reading and
//   summarizing.
// - `find`: elements by text, when the snapshot is too big to scan.
// - geometry for main's trusted mouse and keyboard input (`target`), and
//   the agent's cursor drawn over the page while the user watches.
//
// Refs are numbered per tab across documents (main passes the next number
// when this is injected into a new document), so a ref from a page the tab
// has since left is never silently reused for an element of the new one.
//
// Everything inside one function: main reads this file's build output as
// text and evaluates it, then calls `__arcAgentCreate(nextRef)`.

export {}

type Box = { x: number; y: number; width: number; height: number }

interface TreeNode {
  /** `fold`: off-screen nodes folded into one summary line (its `text`). */
  kind: 'el' | 'text' | 'fold'
  el: Element
  role: string
  name: string
  ref: string | null
  props: string[]
  /** Where a link goes, shortened; shown with urls: true, or when the link has no name. */
  href: string
  text: string
  children: TreeNode[]
  /** The modal dialog, listed first. */
  modal?: boolean
}

interface RenderOptions {
  textMax: number
  urls: boolean
}

interface Reply {
  value?: unknown
  error?: string
  next: number
}

declare global {
  var __arcAgentCreate: ((start: number) => { call(method: string, args: Record<string, unknown>): Promise<Reply> }) | undefined
}

globalThis.__arcAgentCreate = (start: number) => {
  // ---------------------------------------------------------------------------
  // Refs
  // ---------------------------------------------------------------------------

  let next = start
  const ids = new WeakMap<Element, number>()
  const byId = new Map<number, WeakRef<Element>>()

  function refOf(el: Element): string {
    let id = ids.get(el)
    if (id === undefined) {
      id = next++
      ids.set(el, id)
      byId.set(id, new WeakRef(el))
    }
    return `e${id}`
  }

  function resolve(ref: unknown): Element {
    const match = typeof ref === 'string' ? /^\[?e(\d+)\]?$/.exec(ref.trim()) : null
    if (!match) throw new Error(`"${String(ref)}" is not a ref; refs look like e12`)
    const id = Number(match[1])
    const el = byId.get(id)?.deref()
    if (!el || !el.isConnected) {
      if (id < start) throw new Error(`Ref e${id} belongs to a page this tab has since left. Take a new snapshot.`)
      throw new Error(`Ref e${id} is no longer on the page. Take a new snapshot.`)
    }
    return el
  }

  function pruneRefs(): void {
    for (const [id, weak] of byId) if (!weak.deref()?.isConnected) byId.delete(id)
  }

  // ---------------------------------------------------------------------------
  // Element facts
  // ---------------------------------------------------------------------------

  const SKIP = new Set(['script', 'style', 'noscript', 'template', 'head', 'meta', 'link', 'title', 'base', 'param', 'source', 'track'])
  const INLINE = new Set([
    'a', 'abbr', 'b', 'bdi', 'bdo', 'cite', 'code', 'data', 'del', 'dfn', 'em', 'font', 'i', 'ins', 'kbd', 'label',
    'mark', 'q', 's', 'samp', 'small', 'span', 'strong', 'sub', 'sup', 'time', 'u', 'var', 'wbr', 'br'
  ])
  const INTERACTIVE = new Set([
    'link', 'button', 'textbox', 'searchbox', 'combobox', 'listbox', 'option', 'checkbox', 'radio', 'switch', 'slider',
    'spinbutton', 'tab', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'treeitem'
  ])
  /** Roles whose name is their text, so the text is not repeated underneath. */
  const NAME_FROM_CONTENT = new Set([
    'button', 'link', 'heading', 'tab', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'option', 'treeitem',
    'checkbox', 'radio', 'switch', 'cell', 'columnheader', 'rowheader', 'tooltip', 'clickable'
  ])
  /** Roles that only group: dropped when they wrap a single child. */
  const WRAPPERS = new Set(['listitem', 'group', 'generic', 'region', 'article', 'form', 'row', 'cell'])
  const TEXT_INPUT = new Set(['', 'text', 'email', 'password', 'search', 'tel', 'url', 'number'])
  const MAX_ELEMENTS = 40_000

  const view = (el: Element): Window => el.ownerDocument.defaultView ?? window
  /** The focused element while a tree is being built. */
  let focusedNow: Element | null = null
  const styleOf = (el: Element): CSSStyleDeclaration => view(el).getComputedStyle(el)

  function clean(text: string | null | undefined, max = 160): string {
    const s = (text ?? '').replace(/\s+/g, ' ').trim()
    return s.length > max ? `${s.slice(0, max - 1)}…` : s
  }

  function hidden(el: Element): boolean {
    if (el === overlay.host) return true
    if (el.getAttribute('aria-hidden') === 'true') return true
    if ((el as HTMLElement).inert) return true
    if (el.checkVisibility({ visibilityProperty: true })) return false
    // display: contents has no box of its own, but its children may.
    return styleOf(el).display !== 'contents'
  }

  function inputRole(input: HTMLInputElement): string | null {
    switch (input.type) {
      case 'hidden':
        return null
      case 'button':
      case 'submit':
      case 'reset':
      case 'image':
      case 'file':
        return 'button'
      case 'checkbox':
        return input.getAttribute('role') === 'switch' ? 'switch' : 'checkbox'
      case 'radio':
        return 'radio'
      case 'range':
        return 'slider'
      case 'number':
        return 'spinbutton'
      case 'search':
        return input.hasAttribute('list') ? 'combobox' : 'searchbox'
      default:
        return input.hasAttribute('list') ? 'combobox' : 'textbox'
    }
  }

  /** Inside an article or section, header/footer are not page landmarks. */
  function inSectioning(el: Element): boolean {
    return el.parentElement?.closest('article, aside, main, nav, section') != null
  }

  function roleOf(el: Element): string | null {
    const explicit = el.getAttribute('role')?.trim().split(/\s+/)[0]?.toLowerCase()
    if (explicit === 'none' || explicit === 'presentation') return null
    if (explicit && explicit !== 'generic') return explicit
    switch (el.localName) {
      case 'a':
      case 'area':
        return el.hasAttribute('href') ? 'link' : null
      case 'button':
      case 'summary':
        return 'button'
      case 'input':
        return inputRole(el as HTMLInputElement)
      case 'textarea':
        return 'textbox'
      case 'select': {
        const select = el as HTMLSelectElement
        return select.multiple || select.size > 1 ? 'listbox' : 'combobox'
      }
      case 'option':
        return 'option'
      case 'h1':
      case 'h2':
      case 'h3':
      case 'h4':
      case 'h5':
      case 'h6':
        return 'heading'
      case 'img':
        return el.getAttribute('alt') === '' && !el.hasAttribute('aria-label') ? null : 'img'
      case 'svg':
        return el.hasAttribute('aria-label') || el.querySelector(':scope > title') ? 'img' : null
      case 'nav':
        return 'navigation'
      case 'main':
        return 'main'
      case 'header':
        return inSectioning(el) ? null : 'banner'
      case 'footer':
        return inSectioning(el) ? null : 'contentinfo'
      case 'aside':
        return 'complementary'
      case 'form':
        return 'form'
      case 'dialog':
        return 'dialog'
      case 'ul':
      case 'ol':
      case 'menu':
        return 'list'
      case 'li':
        return 'listitem'
      case 'table':
        return 'table'
      case 'tr':
        return 'row'
      case 'th':
        return 'columnheader'
      case 'td':
        return 'cell'
      case 'details':
      case 'fieldset':
        return 'group'
      case 'article':
        return 'article'
      case 'section':
        return el.hasAttribute('aria-label') || el.hasAttribute('aria-labelledby') ? 'region' : null
      case 'iframe':
      case 'frame':
        return 'iframe'
      case 'video':
        return 'video'
      case 'audio':
        return 'audio'
      case 'canvas':
        return 'canvas'
      case 'progress':
        return 'progressbar'
      case 'meter':
        return 'meter'
    }
    if ((el as HTMLElement).isContentEditable && el.hasAttribute('contenteditable')) return 'textbox'
    return null
  }

  function textOf(el: Element, max = 160): string {
    const text = (el as HTMLElement).innerText ?? el.textContent
    return clean(text, max)
  }

  /** A label's own words: controls inside it (`<label>Plan <select>…`) do not name it. */
  function labelText(label: Element): string {
    let text = ''
    const visit = (node: Node) => {
      for (const child of node.childNodes) {
        if (child.nodeType === Node.TEXT_NODE) text += child.textContent ?? ''
        else if (child.nodeType === Node.ELEMENT_NODE) {
          const el = child as Element
          if (['input', 'select', 'textarea', 'button'].includes(el.localName) || SKIP.has(el.localName) || hidden(el)) continue
          text += ' '
          visit(el)
        }
      }
    }
    visit(label)
    return clean(text)
  }

  function byIdIn(el: Element, id: string): Element | null {
    const root = el.getRootNode() as Document | ShadowRoot
    return root.getElementById?.(id) ?? el.ownerDocument.getElementById(id)
  }

  function nameOf(el: Element, role: string | null): string {
    const labelledBy = el.getAttribute('aria-labelledby')
    if (labelledBy) {
      const text = labelledBy
        .split(/\s+/)
        .map((id) => {
          const target = byIdIn(el, id)
          return target ? target.getAttribute('aria-label') || textOf(target) : ''
        })
        .join(' ')
      if (clean(text)) return clean(text)
    }
    const aria = clean(el.getAttribute('aria-label'))
    if (aria) return aria
    const tag = el.localName
    if (tag === 'input' || tag === 'textarea' || tag === 'select') {
      const field = el as HTMLInputElement
      const labels = field.labels ? clean([...field.labels].map((l) => labelText(l)).join(' ')) : ''
      if (labels) return labels
      if (tag === 'input') {
        if (field.type === 'submit' || field.type === 'button' || field.type === 'reset') {
          return clean(field.value) || (field.type === 'submit' ? 'Submit' : field.type === 'reset' ? 'Reset' : '')
        }
        if (field.type === 'image') return clean(field.alt)
      }
      return clean(el.getAttribute('placeholder') || el.getAttribute('title'))
    }
    if (tag === 'img' || tag === 'area') return clean(el.getAttribute('alt') || el.getAttribute('title'))
    if (tag === 'svg') return clean(el.querySelector(':scope > title')?.textContent)
    if (tag === 'iframe' || tag === 'frame') return clean(el.getAttribute('title') || el.getAttribute('name'))
    if (tag === 'fieldset') return clean(el.querySelector(':scope > legend')?.textContent)
    if (tag === 'table') return clean((el as HTMLTableElement).caption?.textContent)
    if (tag === 'dialog' || role === 'dialog' || role === 'alertdialog') {
      const heading = el.querySelector('h1, h2, h3, [role="heading"]')
      if (heading) return textOf(heading, 80)
    }
    // A cell holding links or a whole table is a container; its children speak for it.
    if ((role === 'cell' || role === 'columnheader' || role === 'rowheader') && el.querySelector('a[href], button, input, select, textarea, table, [role]')) {
      return ''
    }
    if (role && NAME_FROM_CONTENT.has(role)) {
      const text = textOf(el)
      if (text) return text
      // Icon-only buttons and links: their image's alt, label or title.
      const inner = el.querySelector('img[alt], [aria-label], svg title, [title]')
      if (inner) return clean(inner.getAttribute('alt') || inner.getAttribute('aria-label') || inner.getAttribute('title') || inner.textContent)
    }
    return clean(el.getAttribute('title'))
  }

  function checkedState(el: Element): string | null {
    const aria = el.getAttribute('aria-checked')
    if (aria === 'mixed') return 'mixed'
    if (el.localName === 'input') return (el as HTMLInputElement).checked ? 'checked' : 'unchecked'
    if (aria !== null) return aria === 'true' ? 'checked' : 'unchecked'
    return null
  }

  function shortUrl(href: string, base: Location): string {
    const raw = href.trim()
    // "#" is a script-driven link; "#id" stays on this page.
    if (!raw || raw === '#') return ''
    if (raw.startsWith('#')) return raw.length > 120 ? `${raw.slice(0, 119)}…` : raw
    try {
      const url = new URL(href, base.href)
      if (url.protocol === 'javascript:') return ''
      const s = url.origin === base.origin ? url.pathname + url.search + url.hash : url.href
      return s.length > 120 ? `${s.slice(0, 119)}…` : s
    } catch {
      return ''
    }
  }

  function propsOf(el: Element, role: string, name: string): string[] {
    const props: string[] = []
    const tag = el.localName
    if (role === 'checkbox' || role === 'radio' || role === 'switch' || role === 'menuitemcheckbox' || role === 'menuitemradio') {
      const state = checkedState(el)
      if (state) props.push(state)
    }
    if (role === 'heading') {
      const level = /^h([1-6])$/.exec(tag)?.[1] ?? el.getAttribute('aria-level')
      if (level) props.push(`level=${level}`)
    }
    const field = el as HTMLInputElement
    if (role === 'textbox' || role === 'searchbox' || role === 'combobox' || role === 'spinbutton' || role === 'slider') {
      if (tag === 'select') {
        const select = el as HTMLSelectElement
        const chosen = select.selectedOptions[0]
        if (chosen) props.push(`value=${JSON.stringify(clean(chosen.textContent, 60))}`)
        const options = [...select.options].slice(0, 12).map((o) => clean(o.textContent, 40))
        props.push(`options=[${options.map((o) => JSON.stringify(o)).join(', ')}${select.options.length > 12 ? ', …' : ''}]`)
      } else if (tag === 'input' || tag === 'textarea') {
        if (field.value) props.push(field.type === 'password' ? 'value=•••' : `value=${JSON.stringify(clean(field.value, 100))}`)
        const placeholder = el.getAttribute('placeholder')
        if (!field.value && placeholder && clean(placeholder) !== name) props.push(`placeholder=${JSON.stringify(clean(placeholder, 60))}`)
        if (tag === 'input' && !TEXT_INPUT.has(field.type) && field.type !== 'range') props.push(`type=${field.type}`)
      } else if ((el as HTMLElement).isContentEditable) {
        const text = textOf(el, 100)
        if (text && text !== name) props.push(`value=${JSON.stringify(text)}`)
      }
    }
    if (tag === 'input' && field.type === 'file') props.push('type=file')
    const expanded = el.getAttribute('aria-expanded')
    if (expanded !== null) props.push(`expanded=${expanded}`)
    else if (tag === 'details') props.push(`expanded=${(el as HTMLDetailsElement).open}`)
    if (el.getAttribute('aria-selected') === 'true' || (tag === 'option' && (el as HTMLOptionElement).selected)) props.push('selected')
    if (el.getAttribute('aria-pressed') === 'true') props.push('pressed')
    const current = el.getAttribute('aria-current')
    if (current && current !== 'false') props.push('current')
    if ((el as HTMLButtonElement).disabled || el.getAttribute('aria-disabled') === 'true') props.push('disabled')
    if ((el as HTMLInputElement).required || el.getAttribute('aria-required') === 'true') props.push('required')
    if ((el as HTMLInputElement).readOnly && (tag === 'input' || tag === 'textarea')) props.push('readonly')
    if (el.getAttribute('aria-invalid') === 'true' || safeMatches(el, ':user-invalid')) props.push('invalid')
    if (focusedNow === el) props.push('focused')
    return props
  }

  function safeMatches(el: Element, selector: string): boolean {
    try {
      return el.matches(selector)
    } catch {
      return false
    }
  }

  /** The focused element, following focus into shadow roots and same-origin frames. */
  function deepActive(): Element | null {
    let el: Element | null = document.activeElement
    for (let depth = 0; el && depth < 16; depth += 1) {
      if (el.shadowRoot?.activeElement) {
        el = el.shadowRoot.activeElement
        continue
      }
      if (el.localName === 'iframe') {
        const inner = frameDocument(el)?.activeElement
        if (inner && inner !== inner.ownerDocument.body) {
          el = inner
          continue
        }
      }
      break
    }
    return el
  }

  function frameDocument(el: Element): Document | null {
    try {
      return (el as HTMLIFrameElement).contentDocument
    } catch {
      return null
    }
  }

  /** Elements a user can act on beyond their role: script-driven widgets. */
  function clickable(el: Element, parentPointer: boolean, cursor: string): boolean {
    const pointer = cursor === 'pointer' && !parentPointer
    const tabindex = el.getAttribute('tabindex')
    if (!pointer && !el.hasAttribute('onclick') && !(tabindex !== null && Number(tabindex) >= 0)) return false
    if (el.localName === 'iframe' || el.localName === 'body' || el.localName === 'html') return false
    // A page-sized container with a hand cursor is styling, not a control.
    const box = firstBox(el)
    return box !== null && box.width * box.height < innerWidth * innerHeight * 0.5
  }

  /** Light children as rendered: shadow trees, slots, same-origin frames. */
  function childrenOf(node: Node): Node[] {
    if (node.nodeType === Node.ELEMENT_NODE) {
      const el = node as Element
      if (el.shadowRoot) return [...el.shadowRoot.childNodes]
      if (el.localName === 'slot') {
        const assigned = (el as HTMLSlotElement).assignedNodes({ flatten: true })
        if (assigned.length > 0) return assigned
      }
      if (el.localName === 'iframe' || el.localName === 'frame') {
        const body = frameDocument(el)?.body
        return body ? [body] : []
      }
    }
    return [...node.childNodes]
  }

  // ---------------------------------------------------------------------------
  // The accessibility-style tree
  // ---------------------------------------------------------------------------

  interface WalkState {
    count: number
    truncated: boolean
    skip: Element | null
  }

  function element(el: Element, role: string, name: string, interactive: boolean): TreeNode {
    return {
      kind: 'el',
      el,
      role,
      name,
      ref: interactive ? refOf(el) : null,
      props: propsOf(el, role, name),
      href: role === 'link' ? shortUrl(el.getAttribute('href') ?? '', view(el).location) : '',
      text: '',
      children: []
    }
  }

  /** Append the visible tree of `nodes` to `out`; generic elements dissolve into their children. */
  function walk(nodes: Node[], out: TreeNode[], state: WalkState, inInteractive: boolean, parentPointer: boolean): void {
    for (const child of nodes) {
      if (child.nodeType === Node.TEXT_NODE) {
        // Runs of inline text join as written ("snapshots," not "snapshots ,"); render trims them.
        const text = (child.textContent ?? '').replace(/\s+/g, ' ')
        const last = out[out.length - 1]
        const joins = last !== undefined && last.kind === 'text' && !breakAfter.has(last)
        if (joins) last.text += text
        else if (text.trim()) out.push(textNode(child.parentElement!, text))
        continue
      }
      if (child.nodeType !== Node.ELEMENT_NODE) continue
      const el = child as Element
      if (SKIP.has(el.localName) || el === state.skip) continue
      if (++state.count > MAX_ELEMENTS) {
        state.truncated = true
        return
      }
      if (hidden(el)) continue
      const style = styleOf(el)
      const role = roleOf(el)
      const pointer = style.cursor === 'pointer'
      let interactive = role !== null && INTERACTIVE.has(role)
      let effectiveRole = role
      if (!interactive && !inInteractive && role !== 'iframe' && clickable(el, parentPointer, style.cursor)) {
        interactive = true
        effectiveRole = role ?? 'clickable'
      }
      if (effectiveRole === null) {
        // Generic element: its content joins the parent's; blocks end runs of text.
        const block = !INLINE.has(el.localName)
        if (block) markBreak(out)
        walk(childrenOf(el), out, state, inInteractive, pointer)
        if (block) markBreak(out)
        continue
      }
      const name = nameOf(el, effectiveRole)
      const node2 = element(el, effectiveRole, name, interactive)
      if (effectiveRole === 'iframe' && childrenOf(el).length === 0) {
        const src = (el as HTMLIFrameElement).src
        node2.children.push(textNode(el, src ? `(cross-origin frame: ${shortUrl(src, location)})` : '(empty frame)'))
      } else if (el.localName !== 'select' && effectiveRole !== 'img') {
        walk(childrenOf(el), node2.children, state, inInteractive || interactive, pointer)
      }
      markBreak(out)
      out.push(node2)
      markBreak(out)
    }
  }

  const breakAfter = new WeakSet<TreeNode>()
  function markBreak(out: TreeNode[]): void {
    const last = out[out.length - 1]
    if (last) breakAfter.add(last)
  }

  function textNode(el: Element, text: string): TreeNode {
    return { kind: 'text', el, role: '', name: '', ref: null, props: [], href: '', text, children: [] }
  }

  function modalElement(): Element | null {
    const candidates = [...document.querySelectorAll('dialog, [aria-modal="true"]')]
    return candidates.find((el) => !hidden(el) && (el.localName !== 'dialog' || safeMatches(el, ':modal')) && el.getAttribute('aria-modal') !== 'false') ?? null
  }

  function buildTree(root: Element | null): { nodes: TreeNode[]; truncated: boolean } {
    const state: WalkState = { count: 0, truncated: false, skip: null }
    const nodes: TreeNode[] = []
    focusedNow = deepActive()
    if (root) {
      walk([root], nodes, state, false, false)
      return { nodes, truncated: state.truncated }
    }
    const modal = modalElement()
    if (modal) {
      const holder: TreeNode[] = []
      walk([modal], holder, state, false, false)
      for (const n of holder) if (n.kind === 'el') n.modal = true
      nodes.push(...holder)
      state.skip = modal
    }
    walk(childrenOf(document.body ?? document.documentElement), nodes, state, false, false)
    return { nodes, truncated: state.truncated }
  }

  /**
   * Drop what says nothing: images that repeat their parent's name (avatars
   * inside "@name" links, logos inside "Home" links), text a control's name
   * already says, and elements left with no name, ref, state or content.
   * Wrappers around what is left then collapse.
   */
  function compact(nodes: TreeNode[], parent: TreeNode | null): TreeNode[] {
    const out: TreeNode[] = []
    for (const n of nodes) {
      if (n.kind !== 'el') {
        out.push(n)
        continue
      }
      if (n.role === 'img' && parent?.name && (!n.name || parent.name.includes(n.name))) continue
      let children = compact(n.children, n)
      // A name taken from the content already says what the text would.
      if (n.name && NAME_FROM_CONTENT.has(n.role)) children = children.filter((c) => c.kind !== 'text')
      if (!n.name && !n.ref && n.props.length === 0 && children.length === 0) continue
      // Icons in a named control join its line: `link "35,846" [e29] img "star"`.
      if (n.name && n.ref && children.length > 0 && children.every((c) => c.kind === 'el' && c.role === 'img' && c.children.length === 0)) {
        out.push({ ...n, props: [...n.props, ...children.map((c) => `img ${JSON.stringify(c.name)}`)], children: [] })
        continue
      }
      out.push({ ...n, children })
    }
    return out
  }

  /** Keep interactive elements, plus headings and the landmarks that contain them. */
  function prune(nodes: TreeNode[]): TreeNode[] {
    const out: TreeNode[] = []
    for (const n of nodes) {
      if (n.kind === 'text') continue
      const children = prune(n.children)
      if (n.ref || n.role === 'heading' || children.length > 0) out.push({ ...n, children })
    }
    return out
  }

  function inViewport(el: Element): boolean {
    const box = topRect(el)
    return box !== null && box.y + box.height > 0 && box.y < innerHeight && box.x + box.width > 0 && box.x < innerWidth
  }

  function onlyVisible(nodes: TreeNode[]): TreeNode[] {
    const out: TreeNode[] = []
    for (const n of nodes) {
      const children = onlyVisible(n.children)
      if (children.length > 0) out.push({ ...n, children })
      else if ((n.kind === 'text' || n.ref || n.role === 'heading' || n.children.length === 0) && inViewport(n.el)) out.push({ ...n, children })
    }
    return out
  }

  // -- folding: big pages keep what is on screen, and an outline of the rest --

  /** Smallest part worth a fold line (characters it would take). */
  const FOLD_MIN = 240
  /** What a fold line itself costs, roughly. */
  const FOLD_LINE = 110
  /** Off-screen landmarks that fold before the content does. */
  const FOLD_FIRST = new Set(['navigation', 'contentinfo', 'complementary', 'banner'])

  interface FoldRun {
    list: TreeNode[]
    start: number
    nodes: TreeNode[]
    /** Elements this run sits in, outermost first. */
    path: TreeNode[]
    where: 'above' | 'below' | 'beside'
  }

  /** Where an element is relative to the viewport; null when any of it shows (or it has no box). */
  function offscreen(el: Element): 'above' | 'below' | 'beside' | null {
    const r = el.getBoundingClientRect()
    if (r.width === 0 && r.height === 0) return null
    const off = frameOffset(el)
    const top = r.top + off.y
    const left = r.left + off.x
    if (top >= innerHeight) return 'below'
    if (top + r.height <= 0) return 'above'
    if (left >= innerWidth || left + r.width <= 0) return 'beside'
    return null
  }

  /**
   * Fold off-screen parts into one-line summaries until the snapshot fits in
   * `budget` characters: menus, footers and sidebars first, then the part
   * that just covers what is over the budget, else the biggest, so most of
   * the page keeps its detail and folded parts still say what is in them.
   * Returns how many were folded.
   */
  function fold(nodes: TreeNode[], budget: number, o: RenderOptions): number {
    const sizes = new Map<TreeNode, number>()
    const measure = (n: TreeNode, depth: number): number => {
      let size = depth * 2 + 3 + (n.kind === 'el' ? line(n, o.urls).length : Math.min(n.text.length, o.textMax))
      for (const c of n.children) size += measure(c, depth + 1)
      sizes.set(n, size)
      return size
    }
    let total = 0
    for (const n of nodes) total += measure(n, 0)
    if (total <= budget) return 0

    const focused = focusedNow
    const runs: FoldRun[] = []
    const collect = (list: TreeNode[], path: TreeNode[]) => {
      let run: FoldRun | null = null
      const close = () => {
        if (run && run.nodes.reduce((sum, n) => sum + sizes.get(n)!, 0) >= FOLD_MIN) runs.push(run)
        run = null
      }
      for (let i = 0; i < list.length; i += 1) {
        const n = list[i]!
        const where = n.modal || (focused && n.el.contains(focused)) ? null : offscreen(n.el)
        // Menus, footers and sidebars fold on their own (they go first).
        const alone = FOLD_FIRST.has(n.role)
        if (!where || alone || (run && (run.where !== where || FOLD_FIRST.has(run.nodes[0]!.role)))) close()
        if (where) {
          run ??= { list, start: i, nodes: [], path, where }
          run.nodes.push(n)
        }
        // On screen: parts of it may not be. Off screen: a part of it may be enough to fold.
        if (n.children.length > 0 && (!where || sizes.get(n)! >= FOLD_MIN * 2)) collect(n.children, [...path, n])
      }
      close()
    }
    collect(nodes, [])

    const folded = new Set<TreeNode>()
    const chosen: FoldRun[] = []
    const sizeOf = (r: FoldRun) => r.nodes.reduce((sum, n) => sum + sizes.get(n)!, 0)
    const boilerplate = (r: FoldRun) => r.nodes.length === 1 && FOLD_FIRST.has(r.nodes[0]!.role)
    while (total > budget && chosen.length < 30) {
      const need = total - budget
      const open = runs.filter((r) => !chosen.includes(r) && !r.path.some((p) => folded.has(p)) && !r.nodes.some((n) => folded.has(n)))
      const candidates = open.some(boilerplate) ? open.filter(boilerplate) : open
      let best: FoldRun | null = null
      let bestSaving = 0
      for (const r of candidates) {
        const saving = sizeOf(r) - FOLD_LINE
        if (saving <= 0) continue
        const better = best === null || (saving >= need ? bestSaving < need || saving < bestSaving : bestSaving < need && saving > bestSaving)
        if (better) {
          best = r
          bestSaving = saving
        }
      }
      if (!best) break
      chosen.push(best)
      for (const n of best.nodes) folded.add(n)
      for (const p of best.path) sizes.set(p, sizes.get(p)! - bestSaving)
      total -= bestSaving
    }

    // A part folded inside a part folded later goes with the outer one.
    const applied = chosen.filter((r) => !r.path.some((p) => folded.has(p)))
    // Summaries first (they read the nodes), then splice from the back so earlier indexes stay put.
    const lines = applied.map((r) => [r, foldNode(r)] as const)
    lines.sort((a, b) => b[0].start - a[0].start)
    for (const [r, node] of lines) r.list.splice(r.start, r.nodes.length, node)
    return applied.length
  }

  function foldNode(r: FoldRun): TreeNode {
    const roles = new Map<string, number>()
    const headings: string[] = []
    let first = ''
    let lines = 0
    const visit = (n: TreeNode) => {
      lines += 1
      if (n.kind === 'text') first ||= clean(n.text, 60)
      else {
        if (n.ref) roles.set(n.role, (roles.get(n.role) ?? 0) + 1)
        if (n.role === 'heading' && n.name && headings.length < 6) headings.push(JSON.stringify(clean(n.name, 50)))
        if (!first && n.name && n.ref) first = clean(n.name, 60)
      }
      n.children.forEach(visit)
    }
    r.nodes.forEach(visit)
    const counts = [...roles]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 4)
      .map(([role, count]) => `${count} ${role}${count === 1 ? '' : role.endsWith('x') ? 'es' : 's'}`)
    const single = r.nodes.length === 1 && r.nodes[0]!.kind === 'el' ? r.nodes[0]! : null
    const head = single ? `${line({ ...single, ref: single.ref ?? refOf(single.el), props: [], href: '' })} folded` : `${r.nodes.length} items folded`
    let text = `${head} ${r.where} the viewport (~${lines} lines)`
    if (counts.length) text += `: ${counts.join(', ')}`
    text += headings.length ? `; headings ${headings.join(', ')}` : first ? `; starts with ${JSON.stringify(first)}` : ''
    // All of an element's children: that element's ref shows them.
    const parent = r.path[r.path.length - 1]
    if (!single && parent && r.nodes.length === r.list.length) text += `; snapshot ref=${parent.ref ?? refOf(parent.el)} shows them`
    return { kind: 'fold', el: r.nodes[0]!.el, role: '', name: '', ref: null, props: [], href: '', text, children: [] }
  }

  // -- rendering --

  function line(n: TreeNode, urls = false): string {
    let s = n.role
    if (n.name) s += ` ${JSON.stringify(n.name)}`
    if (n.ref) s += ` [${n.ref}]`
    if (n.props.length > 0) s += ` ${n.props.join(' ')}`
    if (n.href && (urls || !n.name)) s += ` → ${n.href}`
    return s
  }

  /** Wrappers around a single thing say nothing on their own. */
  function unwrap(n: TreeNode): TreeNode {
    while (n.kind === 'el' && WRAPPERS.has(n.role) && !n.name && !n.ref && n.children.length === 1 && n.children[0]!.kind === 'el') {
      n = n.children[0]!
    }
    return n
  }

  /** A named link or button with nothing else to say: neighbours like it share one line. */
  function plain(n: TreeNode, o: RenderOptions): boolean {
    return (n.role === 'link' || n.role === 'button') && n.ref !== null && n.name !== '' && n.props.length === 0 && n.children.length === 0 && !(o.urls && n.href)
  }

  function render(nodes: TreeNode[], depth: number, lines: string[], o: RenderOptions): void {
    const indent = '  '.repeat(depth)
    const list = nodes.map(unwrap)
    for (let i = 0; i < list.length; i += 1) {
      const n = list[i]!
      if (n.kind === 'fold') {
        lines.push(`${indent}- ${n.text}`)
        continue
      }
      if (n.kind === 'text') {
        // `<label><input> Remember me</label>`: the control already carries the text;
        // separators between links ("|", "·") say nothing.
        const text = clean(n.text, o.textMax)
        if (text === list[i - 1]?.name || text === list[i + 1]?.name || /^[\s|·•,;:/\\()[\]–—-]*$/.test(text)) continue
        lines.push(`${indent}- text: ${text}`)
        continue
      }
      // Nav bars, tag lists, avatar rows: `- links: "Docs" [e3], "Blog" [e4], "About" [e5]`.
      if (plain(n, o)) {
        let j = i
        while (j + 1 < list.length && list[j + 1]!.role === n.role && plain(list[j + 1]!, o)) j += 1
        if (j - i >= 2) {
          lines.push(`${indent}- ${n.role}s: ${list.slice(i, j + 1).map((m) => `${JSON.stringify(m.name)} [${m.ref}]`).join(', ')}`)
          i = j
          continue
        }
      }
      const children = n.children
      // Nothing to say and nothing inside (spacer cells, unnamed images).
      if (!n.name && !n.ref && n.props.length === 0 && children.length === 0) continue
      if (n.role === 'row' && children.every((c) => c.kind === 'el' && c.children.every((g) => g.kind === 'text'))) {
        const cells = children.map((c) => c.name || clean(c.children.map((g) => g.text).join(' '), 80))
        if (cells.some(Boolean)) lines.push(`${indent}- row: ${cells.join(' | ')}`)
        continue
      }
      if (children.length === 1 && children[0]!.kind === 'text') {
        lines.push(`${indent}- ${line(n, o.urls)}: ${clean(children[0]!.text, o.textMax)}`)
        continue
      }
      // `- heading level=2 > link "Repo" [e28]`: a heading that is a link, said once.
      const only = children.length === 1 ? unwrap(children[0]!) : null
      if (n.role === 'heading' && only?.kind === 'el' && only.ref && only.name === n.name) {
        lines.push(`${indent}- ${line({ ...n, name: '' }, o.urls)} > ${line(only, o.urls)}`)
        render(only.children, depth + 1, lines, o)
        continue
      }
      lines.push(`${indent}- ${line(n, o.urls)}`)
      render(children, depth + 1, lines, o)
    }
  }

  function pageHeader(): string[] {
    const lines = [`Page: ${JSON.stringify(clean(document.title, 120))} ${location.href}`]
    const docHeight = Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight ?? 0)
    lines.push(
      `Viewport: ${innerWidth}×${innerHeight}, scrolled to y=${Math.round(scrollY)} of ${docHeight}` +
        (docHeight > innerHeight ? ` (${Math.round((100 * (scrollY + innerHeight)) / docHeight)}% seen)` : '')
    )
    return lines
  }

  /** Default size budget of a snapshot, in characters (about 3k tokens); twice that for one part (ref=). */
  const SNAPSHOT_BUDGET = 12_000

  function snapshot(args: Record<string, unknown>): string {
    pruneRefs()
    const root = args.ref ? resolve(args.ref) : null
    const built = buildTree(root)
    let nodes = compact(built.nodes, null)
    if (args.interactiveOnly) nodes = prune(nodes)
    if (args.viewportOnly) nodes = onlyVisible(nodes)
    const o: RenderOptions = { textMax: args.interactiveOnly ? 80 : 200, urls: args.urls === true }
    const budget = typeof args.maxChars === 'number' ? args.maxChars : root ? SNAPSHOT_BUDGET * 2 : SNAPSHOT_BUDGET
    const folds = args.viewportOnly ? 0 : fold(nodes, budget, o)
    const lines: string[] = root ? [] : pageHeader()
    const focused = deepActive()
    if (!root && focused && focused !== document.body && ids.has(focused)) lines.push(`Focused: ${describe(focused)}`)
    const modal = nodes.find((n) => n.modal)
    if (!root && modal) lines.push(`A modal ${line(modal).split(' [')[0]} is open; it is listed first and the page behind it is likely inert.`)
    lines.push('')
    render(nodes, 0, lines, o)
    if (folds > 0) {
      lines.push(
        '',
        `(${folds} off-screen part${folds === 1 ? '' : 's'} folded to save space. snapshot ref= expands one; scroll, then viewportOnly, shows what is there; find searches the whole page; maxChars raises the budget.)`
      )
    }
    if (built.truncated) lines.push(`(page too large: stopped after ${MAX_ELEMENTS} elements; use ref= to snapshot a part of it)`)
    return lines.join('\n')
  }

  // ---------------------------------------------------------------------------
  // Finding things
  // ---------------------------------------------------------------------------

  const STOP_WORDS = new Set(['the', 'a', 'an', 'to', 'of', 'on', 'in', 'for', 'and', 'or', 'with', 'that', 'this', 'element', 'field'])
  const ROLE_WORDS: Record<string, string[]> = {
    button: ['button'],
    link: ['link'],
    input: ['textbox', 'searchbox', 'combobox', 'spinbutton'],
    textbox: ['textbox', 'searchbox'],
    box: ['textbox', 'searchbox', 'combobox', 'checkbox'],
    search: ['searchbox', 'textbox'],
    checkbox: ['checkbox', 'switch'],
    radio: ['radio'],
    dropdown: ['combobox', 'listbox'],
    select: ['combobox', 'listbox'],
    tab: ['tab'],
    heading: ['heading'],
    image: ['img'],
    menu: ['menuitem']
  }

  function find(args: Record<string, unknown>): string {
    pruneRefs()
    const query = String(args.query ?? '').toLowerCase()
    const words = query.split(/[^\p{L}\p{N}]+/u).filter((w) => w && !STOP_WORDS.has(w))
    const roleHints = new Set(words.flatMap((w) => ROLE_WORDS[w] ?? []))
    const roleFilter = typeof args.role === 'string' && args.role ? args.role : null
    const limit = typeof args.limit === 'number' ? args.limit : 20
    const results: Array<{ node: TreeNode; score: number; context: string }> = []

    const visit = (nodes: TreeNode[], context: string) => {
      for (const n of nodes) {
        if (n.kind === 'el') {
          const ctx = ['navigation', 'banner', 'main', 'contentinfo', 'complementary', 'dialog', 'form', 'region'].includes(n.role) && n.name
            ? `${n.role} ${JSON.stringify(n.name)}`
            : ['navigation', 'banner', 'main', 'contentinfo', 'complementary', 'dialog'].includes(n.role)
              ? n.role
              : context
          if (!roleFilter || n.role === roleFilter) {
            const haystack = [n.name, ...n.props, n.href].join(' ').toLowerCase()
            const score = matchScore(haystack, query, words) + (roleHints.has(n.role) ? 0.5 : 0) + (n.ref ? 0.2 : 0)
            if (score > 0.7 || (words.length === 0 && roleHints.has(n.role))) results.push({ node: n, score, context: ctx })
          }
          visit(n.children, ctx)
        } else if (!roleFilter) {
          const score = matchScore(n.text.toLowerCase(), query, words)
          if (score > 0.5) {
            const target: TreeNode = { ...n, kind: 'el', role: 'text', name: clean(n.text, 120), ref: refOf(n.el), props: [], children: [] }
            results.push({ node: target, score, context })
          }
        }
      }
    }
    visit(buildTree(null).nodes, '')
    if (results.length === 0) return `Nothing on the page matches ${JSON.stringify(args.query)}. Try other words, or take a snapshot.`
    results.sort((a, b) => b.score - a.score || Number(inViewport(b.node.el)) - Number(inViewport(a.node.el)))
    const shown = results.slice(0, limit)
    const lines = shown.map((r) => `- ${line(r.node, true)}${r.context ? `  (in ${r.context})` : ''}`)
    if (results.length > shown.length) lines.push(`(${results.length - shown.length} more; narrow the query or pass role)`)
    return lines.join('\n')
  }

  function matchScore(haystack: string, query: string, words: string[]): number {
    if (!haystack) return 0
    if (query && haystack.includes(query)) return 2
    if (words.length === 0) return 0
    let hits = 0
    for (const w of words) if (haystack.includes(w)) hits += 1
    return hits / words.length
  }

  // ---------------------------------------------------------------------------
  // Reading: main content as Markdown
  // ---------------------------------------------------------------------------

  const BOILERPLATE_TAGS = new Set(['nav', 'aside', 'dialog', 'button', 'select', 'input', 'textarea', 'svg', 'canvas'])
  const BOILERPLATE_ROLES = new Set(['navigation', 'banner', 'contentinfo', 'complementary', 'search', 'dialog', 'alertdialog', 'menu', 'menubar', 'toolbar'])
  const BOILERPLATE_WORDS = new Set([
    'cookie', 'cookies', 'consent', 'gdpr', 'newsletter', 'subscribe', 'share', 'sharing', 'social', 'advert',
    'advertisement', 'ad', 'ads', 'promo', 'sponsored', 'related', 'recommended', 'breadcrumb', 'breadcrumbs', 'sidebar', 'comments'
  ])
  const BLOCK = new Set([
    'address', 'article', 'aside', 'div', 'dl', 'fieldset', 'figure', 'footer', 'form', 'header', 'main', 'nav',
    'section', 'details', 'summary', 'dialog', 'center', 'hgroup', 'search'
  ])

  interface MdState {
    full: boolean
    pre: string[]
    /** Write link targets (off: just the link text). */
    links: boolean
    /** Write images as ![alt](src) (off: an image says its alt where that adds something). */
    images: boolean
    /** Some same-site link was written as a path. */
    shortened: boolean
  }

  /** Query parameters that only track the click. */
  const TRACKING = /^(utm_\w+|fbclid|gclid|dclid|gbraid|wbraid|msclkid|yclid|mc_cid|mc_eid|_hsenc|_hsmi|igshid|ref_src|spm)$/i

  /** A link target as short as it can be: same-site links as paths, without tracking parameters. */
  function linkUrl(raw: string | null, el: Element, s: MdState): string {
    const abs = absUrl(raw, el)
    if (!abs) return ''
    const url = new URL(abs)
    for (const key of [...url.searchParams.keys()]) if (TRACKING.test(key)) url.searchParams.delete(key)
    if (url.origin !== location.origin) return url.href
    s.shortened = true
    return url.pathname + url.search + url.hash
  }

  function isBoilerplate(el: Element, root: Element): boolean {
    if (el === root) return false
    if (BOILERPLATE_TAGS.has(el.localName)) return true
    // An article's own header holds its title and byline; the page's does not.
    if ((el.localName === 'header' || el.localName === 'footer') && !inSectioning(el)) return true
    const role = el.getAttribute('role')
    if (role && BOILERPLATE_ROLES.has(role)) return true
    const words = `${el.id} ${typeof el.className === 'string' ? el.className : ''}`.toLowerCase().split(/[\s_-]+/)
    return words.some((w) => BOILERPLATE_WORDS.has(w))
  }

  function absUrl(raw: string | null, el: Element): string {
    if (!raw) return ''
    try {
      const url = new URL(raw, view(el).location.href)
      return url.protocol === 'javascript:' || url.protocol === 'data:' ? '' : url.href
    } catch {
      return ''
    }
  }

  function mdChildren(node: Node, s: MdState, root: Element): string {
    let out = ''
    for (const child of childrenOf(node)) out += md(child, s, root)
    return out
  }

  function md(node: Node, s: MdState, root: Element): string {
    if (node.nodeType === Node.TEXT_NODE) return (node.textContent ?? '').replace(/\s+/g, ' ')
    if (node.nodeType !== Node.ELEMENT_NODE) return ''
    const el = node as Element
    const tag = el.localName
    if (SKIP.has(tag) || hidden(el)) return ''
    if (!s.full && isBoilerplate(el, root)) return ''
    switch (tag) {
      case 'h1':
      case 'h2':
      case 'h3':
      case 'h4':
      case 'h5':
      case 'h6': {
        const text = inline(mdChildren(el, s, root))
        return text ? `\n\n${'#'.repeat(Number(tag[1]))} ${text}\n\n` : ''
      }
      case 'p':
        return `\n\n${mdChildren(el, s, root)}\n\n`
      case 'br':
        return '\n'
      case 'hr':
        return '\n\n---\n\n'
      case 'strong':
      case 'b':
        return wrap(mdChildren(el, s, root), '**')
      case 'em':
      case 'i':
        return wrap(mdChildren(el, s, root), '*')
      case 'del':
      case 's':
        return wrap(mdChildren(el, s, root), '~~')
      case 'code': {
        const text = el.textContent ?? ''
        return text.includes('\n') ? fence(text, el, s) : text.trim() ? `\`${text.replace(/`/g, 'ˋ')}\`` : ''
      }
      case 'pre':
        return fence(el.textContent ?? '', el.querySelector('code') ?? el, s)
      case 'a': {
        const text = inline(mdChildren(el, s, root))
        const href = el.getAttribute('href') ?? ''
        if (!text) return ''
        if (href.startsWith('#') || !s.links) return text
        const url = linkUrl(href, el, s)
        return url ? `[${text}](${url})` : text
      }
      case 'img': {
        const alt = clean(el.getAttribute('alt'), 200)
        if (!alt) return ''
        if (s.images) {
          const src = linkUrl((el as HTMLImageElement).currentSrc || el.getAttribute('src'), el, s)
          return src ? `![${alt}](${src})` : ''
        }
        // An image inside a link names it ("@ada", a logo); a picture in the text says what it shows; icons say nothing.
        if (el.closest('a[href]')) return ` ${alt} `
        const box = firstBox(el)
        return box && box.width >= 64 && box.height >= 64 ? `\n\n[image: ${alt}]\n\n` : ''
      }
      case 'ul':
      case 'ol':
      case 'menu':
        return list(el, tag === 'ol', s, root)
      case 'blockquote': {
        const body = tidy(mdChildren(el, s, root))
        return body ? `\n\n${body.replace(/^/gm, '> ')}\n\n` : ''
      }
      case 'table':
        return table(el as HTMLTableElement, s, root)
      case 'dt':
        return `\n\n**${inline(mdChildren(el, s, root))}**\n`
      case 'dd':
        return `: ${inline(mdChildren(el, s, root))}\n`
      case 'figcaption': {
        const text = inline(mdChildren(el, s, root))
        return text ? `\n\n*${text}*\n\n` : ''
      }
      case 'iframe':
      case 'frame': {
        const body = frameDocument(el)?.body
        if (body) return `\n\n${mdChildren(body, s, body)}\n\n`
        const src = absUrl(el.getAttribute('src'), el)
        return src ? `\n\n[embedded frame: ${src}]\n\n` : ''
      }
      case 'video':
      case 'audio': {
        const src = absUrl((el as HTMLMediaElement).currentSrc || el.getAttribute('src'), el)
        return src ? `\n\n[${tag}: ${src}]\n\n` : ''
      }
      case 'input':
      case 'select':
      case 'textarea':
      case 'svg':
      case 'canvas':
        return ''
      case 'button':
        return s.full ? ` ${inline(mdChildren(el, s, root))} ` : ''
    }
    const inner = mdChildren(el, s, root)
    return BLOCK.has(tag) || (!INLINE.has(tag) && tag !== 'span') ? `\n\n${inner}\n\n` : inner
  }

  function wrap(text: string, mark: string): string {
    const t = text.trim()
    return t ? ` ${mark}${t}${mark} ` : ''
  }

  function inline(text: string): string {
    return text.replace(/\s+/g, ' ').trim()
  }

  /** Code blocks keep their whitespace: stashed now, put back after tidying. */
  function fence(text: string, el: Element, s: MdState): string {
    const body = text.replace(/\n+$/, '')
    if (!body.trim()) return ''
    const classes = `${el.className} ${el.parentElement?.className ?? ''}`
    const lang = /(?:^|\s)(?:language|lang)-([\w+#-]+)/.exec(classes)?.[1] ?? /\bbrush:\s*([\w+#-]+)/.exec(classes)?.[1] ?? ''
    s.pre.push(`\`\`\`${lang}\n${body}\n\`\`\``)
    return `\n\n\u0000${s.pre.length - 1}\u0000\n\n`
  }

  function list(el: Element, ordered: boolean, s: MdState, root: Element): string {
    let n = ordered ? Number(el.getAttribute('start') ?? 1) || 1 : 1
    const items: string[] = []
    for (const li of el.children) {
      if (li.localName !== 'li' || hidden(li)) continue
      const body = tidy(mdChildren(li, s, root)).replace(/\n{2,}/g, '\n')
      if (!body) continue
      const marker = ordered ? `${n++}. ` : '- '
      items.push(marker + body.replace(/\n/g, `\n${' '.repeat(marker.length)}`))
    }
    return items.length ? `\n\n${items.join('\n')}\n\n` : ''
  }

  function table(el: HTMLTableElement, s: MdState, root: Element): string {
    const rows = [...el.rows].filter((r) => !hidden(r))
    // Layout tables (nested tables, long blocks in cells) read better as text.
    if (rows.length === 0 || el.querySelector('table')) return `\n\n${mdChildren(el, s, root)}\n\n`
    // Rows of empty cells (spacers, image-only rows without images) say nothing.
    const cells = rows.map((r) => [...r.cells].map((c) => inline(mdChildren(c, s, root)).replace(/\|/g, '\\|'))).filter((r) => r.some(Boolean))
    if (cells.length === 0) return ''
    const width = Math.max(...cells.map((r) => r.length))
    if (width === 0) return ''
    if (width === 1) return `\n\n${cells.map((r) => r[0]).join('\n\n')}\n\n`
    const pad = (r: string[]) => `| ${[...r, ...Array(width - r.length).fill('')].join(' | ')} |`
    const [head, ...body] = cells
    return `\n\n${[pad(head!), `|${' --- |'.repeat(width)}`, ...body.map(pad)].join('\n')}\n\n`
  }

  function tidy(text: string): string {
    return text
      .split('\n')
      .map((l) => l.replace(/[ \t]+/g, ' ').trim())
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim()
  }

  function textLength(el: Element): number {
    return ((el as HTMLElement).innerText ?? el.textContent ?? '').length
  }

  /** Where the content is: the dominant article, else main, else the body. */
  function contentRoot(): Element {
    const body = document.body ?? document.documentElement
    const total = textLength(body)
    const largest = (selector: string, scope: Element) => {
      let best: Element | null = null
      let bestLength = 0
      for (const el of scope.querySelectorAll(selector)) {
        if (hidden(el)) continue
        const length = textLength(el)
        if (length > bestLength) {
          best = el
          bestLength = length
        }
      }
      return { el: best, length: bestLength }
    }
    const main = largest('main, [role="main"]', body)
    const scope = main.el && main.length > total * 0.3 ? main.el : body
    const scopeLength = scope === body ? total : main.length
    const article = largest(
      'article, [itemprop="articleBody"], .markdown-body, .post-content, .entry-content, .article-body, .article-content',
      scope
    )
    return article.el && article.length > scopeLength * 0.5 ? article.el : scope
  }

  function meta(selector: string): string {
    return clean(document.querySelector(selector)?.getAttribute('content'), 200)
  }

  /** Put the code blocks stashed by `fence` back. */
  function unstash(text: string, s: MdState): string {
    return text.replace(/\u0000(\d+)\u0000/g, (_m, i: string) => s.pre[Number(i)] ?? '')
  }

  /** Headings of a Markdown text and where they start. */
  function sectionsOf(text: string): Array<{ title: string; offset: number }> {
    const out: Array<{ title: string; offset: number }> = []
    for (const m of text.matchAll(/^#{1,4} .+$/gm)) out.push({ title: clean(m[0], 90), offset: m.index })
    return out
  }

  /**
   * Just the passages about `query`, under their headings, in page order: the
   * blocks (paragraphs, lists, tables, code) that mention most of its words
   * fill `max` characters, best first. A matching heading brings its section's
   * opening blocks along.
   */
  function passages(body: string, query: string, s: MdState, max: number): string {
    const phrase = query.toLowerCase()
    const words = phrase.split(/[^\p{L}\p{N}]+/u).filter((w) => w && !STOP_WORDS.has(w))
    const blocks = body.split(/\n{2,}/).map((b) => unstash(b, s))
    const heading: string[] = []
    let current = ''
    const scores = blocks.map((b, i) => {
      if (/^#{1,6} /.test(b)) current = b
      heading[i] = current
      const text = b.toLowerCase()
      if (phrase && text.includes(phrase)) return words.length + 1
      return words.filter((w) => text.includes(w)).length
    })
    const need = words.length > 2 ? 2 : 1
    const picked = new Set<number>()
    let size = 0
    const order = scores.map((score, i) => ({ score, i })).filter((x) => x.score >= need).sort((a, b) => b.score - a.score || a.i - b.i)
    for (const { i } of order) {
      // A heading that matches stands for its section: take the blocks under it too.
      const take = /^#{1,6} /.test(blocks[i]!) ? [i, i + 1, i + 2].filter((k) => k < blocks.length && (k === i || !/^#{1,6} /.test(blocks[k]!))) : [i]
      for (const k of take) {
        if (picked.has(k)) continue
        if (size + blocks[k]!.length > max && picked.size > 0) break
        picked.add(k)
        size += blocks[k]!.length + 2
      }
      if (size >= max) break
    }
    if (picked.size === 0) {
      const outline = sectionsOf(unstash(body, s)).slice(0, 30).map((h) => h.title)
      return `Nothing on the page mentions ${JSON.stringify(query)}.${outline.length ? `\nSections:\n${outline.join('\n')}` : ''}`
    }
    const out: string[] = [`Passages about ${JSON.stringify(query)} (${picked.size} of ${blocks.length} blocks):`]
    let shown = ''
    let last = -2
    for (const i of [...picked].sort((a, b) => a - b)) {
      if (heading[i] && heading[i] !== shown && heading[i] !== blocks[i]) out.push(heading[i]!)
      else if (i !== last + 1) out.push('…')
      shown = heading[i] ?? ''
      out.push(blocks[i]!)
      last = i
    }
    return out.join('\n\n')
  }

  function readPage(args: Record<string, unknown>): { text: string; total: number; sections: Array<{ title: string; offset: number }> } {
    const full = args.full === true
    const root = full ? (document.body ?? document.documentElement) : contentRoot()
    const state: MdState = { full, pre: [], links: args.links !== false, images: args.images === true, shortened: false }
    const body = tidy(md(root, state, root))
    const offset = typeof args.offset === 'number' ? args.offset : 0
    const max = typeof args.maxChars === 'number' ? args.maxChars : 20_000
    const query = typeof args.query === 'string' ? args.query.trim() : ''
    const content = !body ? '(no readable text on this page)' : query ? passages(body, query, state, max) : unstash(body, state)
    const head = [`# ${clean(document.title, 200) || location.hostname}`, `URL: ${location.href}${state.shortened ? ' (links on this site are written as paths)' : ''}`]
    const author = meta('meta[name="author"]') || meta('meta[property="article:author"]')
    const published = meta('meta[property="article:published_time"]') || document.querySelector('time[datetime]')?.getAttribute('datetime')
    if (author) head.push(`Author: ${author}`)
    if (published) head.push(`Published: ${published}`)
    const selection = clean(getSelection()?.toString(), 4000)
    if (selection) head.push('', `The user has selected this text:`, `> ${selection}`)
    const text = `${head.join('\n')}\n\n${content}`
    const end = offset + max
    // What is past the cut, so the next call can jump to the part that matters.
    const sections = end < text.length && !query ? sectionsOf(text).filter((h) => h.offset >= end).slice(0, 30) : []
    return { text: text.slice(offset, end), total: text.length, sections }
  }

  // ---------------------------------------------------------------------------
  // Geometry and hit testing (top-level viewport CSS pixels)
  // ---------------------------------------------------------------------------

  /** Offset of a same-origin frame's viewport inside the top viewport. */
  function frameOffset(el: Element): { x: number; y: number } {
    let x = 0
    let y = 0
    let win: Window | null = view(el)
    for (let depth = 0; win && win !== window && depth < 16; depth += 1) {
      const frame = win.frameElement
      if (!frame) break
      const r = frame.getBoundingClientRect()
      const cs = styleOf(frame)
      x += r.left + frame.clientLeft + parseFloat(cs.paddingLeft)
      y += r.top + frame.clientTop + parseFloat(cs.paddingTop)
      win = view(frame)
    }
    return { x, y }
  }

  function firstBox(el: Element): DOMRect | null {
    for (const r of el.getClientRects()) if (r.width > 0 && r.height > 0) return r
    const r = el.getBoundingClientRect()
    return r.width > 0 && r.height > 0 ? r : null
  }

  function topRect(el: Element): Box | null {
    const box = firstBox(el)
    if (!box) return null
    const off = frameOffset(el)
    return { x: off.x + box.left, y: off.y + box.top, width: box.width, height: box.height }
  }

  /** The element under a point, through shadow roots and same-origin frames. */
  function deepHit(x: number, y: number): Element | null {
    let el = document.elementFromPoint(x, y)
    let ox = 0
    let oy = 0
    for (let depth = 0; el && depth < 32; depth += 1) {
      if (el.shadowRoot) {
        const inner = el.shadowRoot.elementFromPoint(x - ox, y - oy)
        if (inner && inner !== el) {
          el = inner
          continue
        }
      }
      if (el.localName === 'iframe' || el.localName === 'frame') {
        const doc = frameDocument(el)
        if (doc) {
          const r = el.getBoundingClientRect()
          const cs = styleOf(el)
          ox += r.left + el.clientLeft + parseFloat(cs.paddingLeft)
          oy += r.top + el.clientTop + parseFloat(cs.paddingTop)
          const inner = doc.elementFromPoint(x - ox, y - oy)
          if (inner) {
            el = inner
            continue
          }
        }
      }
      break
    }
    return el
  }

  /** `outer` contains `inner`, across shadow and frame boundaries. */
  function composedContains(outer: Element, inner: Element | null): boolean {
    let node: Node | null = inner
    for (let depth = 0; node && depth < 512; depth += 1) {
      if (node === outer) return true
      if (node.parentNode) node = node.parentNode
      else if ((node as ShadowRoot).host) node = (node as ShadowRoot).host
      else node = (node as Document).defaultView?.frameElement ?? null
    }
    return false
  }

  function reaches(el: Element, hit: Element | null): boolean {
    if (!hit) return false
    if (composedContains(el, hit)) return true
    // A label stands in for its control (styled checkboxes hide the input under it).
    const labels = (el as HTMLInputElement).labels
    return labels ? [...labels].some((l) => composedContains(l, hit)) : false
  }

  function describe(el: Element): string {
    const role = roleOf(el) ?? (clickable(el, false, styleOf(el).cursor) ? 'clickable' : el.localName)
    const name = nameOf(el, role) || textOf(el, 60)
    return `${role}${name ? ` ${JSON.stringify(clean(name, 80))}` : ''} [${refOf(el)}]`
  }

  function describeCover(el: Element): string {
    const id = el.id ? `#${el.id}` : ''
    const cls = typeof el.className === 'string' && el.className.trim() ? `.${el.className.trim().split(/\s+/)[0]}` : ''
    const text = textOf(el, 80)
    return `<${el.localName}${id}${cls}>${text ? ` ${JSON.stringify(text)}` : ''} [${refOf(el)}]`
  }

  function viewportFits(box: Box): boolean {
    return box.y >= 0 && box.x >= 0 && box.y + box.height <= innerHeight && box.x + box.width <= innerWidth
  }

  function target(args: Record<string, unknown>) {
    let el = resolve(args.ref)
    let box = topRect(el)
    // A hidden control (custom checkbox): its label is what a user clicks.
    if (!box) {
      const label = (el as HTMLInputElement).labels?.[0]
      if (label && topRect(label)) {
        el = label
        box = topRect(label)
      }
    }
    if (!box) throw new Error(`${describe(el)} has no visible area (hidden, collapsed, or not rendered)`)
    if (args.scroll !== false && !viewportFits(box)) {
      el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' })
      box = topRect(el) ?? box
    }
    const points: Array<[number, number]> = [
      [box.x + box.width / 2, box.y + box.height / 2],
      [box.x + box.width * 0.25, box.y + box.height / 2],
      [box.x + box.width * 0.75, box.y + box.height / 2],
      [box.x + box.width / 2, box.y + box.height * 0.25],
      [box.x + box.width / 2, box.y + box.height * 0.75]
    ]
    let covered: string | null = null
    let point = points[0]!
    const inside = points.filter(([x, y]) => x >= 0 && y >= 0 && x < innerWidth && y < innerHeight)
    if (inside.length === 0) covered = 'outside the viewport'
    for (const p of inside) {
      const hit = deepHit(p[0], p[1])
      if (reaches(el, hit)) {
        point = p
        covered = null
        break
      }
      covered ??= hit ? describeCover(hit) : 'nothing'
    }
    const field = el as HTMLInputElement
    return {
      x: point[0],
      y: point[1],
      rect: box,
      label: describe(el),
      covered,
      disabled: field.disabled === true || el.getAttribute('aria-disabled') === 'true',
      file: el.localName === 'input' && field.type === 'file'
    }
  }

  /**
   * The area an element paints, for screenshots: its own boxes and its
   * descendants' (an inline link around an image is one line tall, the image
   * is not), unless it clips its content. Scrolled into view and cut to the viewport.
   */
  function shotBox(args: Record<string, unknown>) {
    const el = resolve(args.ref)
    const measure = (): Box | null => {
      let left = Infinity
      let top = Infinity
      let right = -Infinity
      let bottom = -Infinity
      const add = (node: Element) => {
        for (const r of node.getClientRects()) {
          if (r.width <= 0 || r.height <= 0) continue
          left = Math.min(left, r.left)
          top = Math.min(top, r.top)
          right = Math.max(right, r.right)
          bottom = Math.max(bottom, r.bottom)
        }
      }
      add(el)
      const cs = styleOf(el)
      if (cs.display === 'inline' || (cs.overflowX === 'visible' && cs.overflowY === 'visible')) {
        const walker = el.ownerDocument.createTreeWalker(el, NodeFilter.SHOW_ELEMENT)
        for (let n = walker.nextNode(), i = 0; n && i < 2000; n = walker.nextNode(), i += 1) add(n as Element)
      }
      if (left === Infinity) return null
      const off = frameOffset(el)
      return { x: off.x + left, y: off.y + top, width: right - left, height: bottom - top }
    }
    let box = measure()
    if (!box) throw new Error(`${describe(el)} has no visible area (hidden, collapsed, or not rendered)`)
    if (!viewportFits(box)) {
      el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' })
      box = measure() ?? box
    }
    const x = Math.max(0, box.x)
    const y = Math.max(0, box.y)
    const width = Math.min(innerWidth, box.x + box.width) - x
    const height = Math.min(innerHeight, box.y + box.height) - y
    if (width <= 0 || height <= 0) throw new Error(`${describe(el)} is outside the viewport`)
    return { rect: { x, y, width, height }, label: describe(el), clipped: width < box.width - 0.5 || height < box.height - 0.5 }
  }

  function pointInfo(args: Record<string, unknown>) {
    const x = Number(args.x)
    const y = Number(args.y)
    const hit = deepHit(x, y)
    const field = hit as HTMLInputElement | null
    return {
      x,
      y,
      rect: hit ? topRect(hit) : null,
      label: hit ? describe(hit) : 'nothing',
      covered: null,
      disabled: false,
      file: hit?.localName === 'input' && field?.type === 'file'
    }
  }

  // ---------------------------------------------------------------------------
  // Fields
  // ---------------------------------------------------------------------------

  function editable(el: Element): el is HTMLInputElement | HTMLTextAreaElement {
    if (el.localName === 'textarea') return true
    return el.localName === 'input' && !['checkbox', 'radio', 'file', 'button', 'submit', 'reset', 'image', 'hidden', 'range', 'color'].includes((el as HTMLInputElement).type)
  }

  /** Focus a field and put the caret at the end, or select its content (to replace it). */
  function focusField(args: Record<string, unknown>) {
    let el = args.ref ? resolve(args.ref) : deepActive()
    if (!el || el === document.body) throw new Error('Nothing is focused; pass a ref')
    if (el.localName === 'label' && (el as HTMLLabelElement).control) el = (el as HTMLLabelElement).control!
    ;(el as HTMLElement).focus({ preventScroll: true })
    const select = args.mode === 'select'
    if (editable(el)) {
      const field = el
      try {
        if (select) field.select()
        else field.setSelectionRange(field.value.length, field.value.length)
      } catch {
        // email / number inputs have no selection API; select() still works.
        if (select) field.select()
      }
      return { kind: 'text', label: describe(el) }
    }
    if ((el as HTMLElement).isContentEditable) {
      const range = el.ownerDocument.createRange()
      range.selectNodeContents(el)
      if (!select) range.collapse(false)
      const sel = view(el).getSelection()
      sel?.removeAllRanges()
      sel?.addRange(range)
      return { kind: 'text', label: describe(el) }
    }
    return { kind: 'other', label: describe(el) }
  }

  function setNativeValue(el: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement, value: string): void {
    const proto = Object.getPrototypeOf(el) as object
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set
    if (setter) setter.call(el, value)
    else el.value = value
    el.dispatchEvent(new Event('input', { bubbles: true }))
    el.dispatchEvent(new Event('change', { bubbles: true }))
  }

  /** Decide how to put `value` into a field; does it itself when no typing or clicking is needed. */
  function fill(args: Record<string, unknown>) {
    const el = resolve(args.ref)
    const value = String(args.value ?? '')
    const label = describe(el)
    const tag = el.localName
    const field = el as HTMLInputElement
    if (tag === 'select') {
      const select = el as HTMLSelectElement
      const wanted = value.trim().toLowerCase()
      const options = [...select.options]
      const option =
        options.find((o) => o.value === value) ??
        options.find((o) => clean(o.textContent).toLowerCase() === wanted) ??
        options.find((o) => clean(o.textContent).toLowerCase().includes(wanted))
      if (!option) throw new Error(`${label} has no option ${JSON.stringify(value)}; options: ${options.map((o) => JSON.stringify(clean(o.textContent, 40))).join(', ')}`)
      select.focus({ preventScroll: true })
      setNativeValue(select, option.value)
      return { action: 'done', detail: `${label} → ${JSON.stringify(clean(option.textContent, 60))}` }
    }
    const role = roleOf(el)
    if ((tag === 'input' && (field.type === 'checkbox' || field.type === 'radio')) || role === 'checkbox' || role === 'switch' || role === 'radio') {
      const want = /^(true|on|yes|1|checked|check)$/i.test(value.trim())
      const has = checkedState(el) === 'checked'
      if (want === has) return { action: 'done', detail: `${label} already ${has ? 'checked' : 'unchecked'}` }
      if (!want && (field.type === 'radio' || role === 'radio')) throw new Error(`${label} is a radio button; check another option instead`)
      return { action: 'click', label }
    }
    if (tag === 'input' && field.type === 'file') throw new Error(`${label} is a file input; use upload_file`)
    if (tag === 'input' && ['range', 'color', 'date', 'time', 'datetime-local', 'month', 'week'].includes(field.type)) {
      field.focus({ preventScroll: true })
      setNativeValue(field, value)
      return { action: 'done', detail: `${label} → ${JSON.stringify(field.value)}` }
    }
    if (editable(el) || (el as HTMLElement).isContentEditable) return { action: 'type', label }
    throw new Error(`${label} is not a form field (click it, or fill the field inside it)`)
  }

  function markUpload(args: Record<string, unknown>) {
    let el = resolve(args.ref)
    if (!(el.localName === 'input' && (el as HTMLInputElement).type === 'file')) {
      // A styled upload button usually wraps or labels the real input.
      const inner = el.querySelector('input[type="file"]') ?? (el as HTMLLabelElement).control
      if (inner && inner.localName === 'input' && (inner as HTMLInputElement).type === 'file') el = inner
      else throw new Error(`${describe(el)} is not a file input (input type=file)`)
    }
    el.setAttribute('data-arc-agent-upload', String(args.nonce))
    return { label: describe(el), multiple: (el as HTMLInputElement).multiple }
  }

  function unmarkUpload(args: Record<string, unknown>) {
    for (const el of document.querySelectorAll(`[data-arc-agent-upload="${String(args.nonce)}"]`)) el.removeAttribute('data-arc-agent-upload')
    const el = args.ref ? resolve(args.ref) : null
    return el ? describe(el) : ''
  }

  // ---------------------------------------------------------------------------
  // Scrolling and waiting
  // ---------------------------------------------------------------------------

  function scrollable(el: Element): boolean {
    const cs = styleOf(el)
    const y = /(auto|scroll|overlay)/.test(cs.overflowY) && el.scrollHeight > el.clientHeight + 1
    const x = /(auto|scroll|overlay)/.test(cs.overflowX) && el.scrollWidth > el.clientWidth + 1
    return x || y
  }

  function scrollState(args: Record<string, unknown>) {
    const at = typeof args.x === 'number' ? deepHit(Number(args.x), Number(args.y)) : null
    let container: Element | null = at
    while (container && !scrollable(container)) container = container.parentElement ?? (container.getRootNode() as ShadowRoot).host ?? null
    const page = document.scrollingElement ?? document.documentElement
    const el = container && container !== page && container !== document.body ? container : null
    return {
      container: el ? describe(el) : null,
      top: el ? el.scrollTop : scrollY,
      left: el ? el.scrollLeft : scrollX,
      height: el ? el.scrollHeight : page.scrollHeight,
      view: el ? el.clientHeight : innerHeight
    }
  }

  /** In-page fallback when a wheel event moved nothing (custom scrollers ignore it rarely, but they do). */
  function scrollBy(args: Record<string, unknown>) {
    const dx = Number(args.dx ?? 0)
    const dy = Number(args.dy ?? 0)
    const at = typeof args.x === 'number' ? deepHit(Number(args.x), Number(args.y)) : null
    let container: Element | null = at
    while (container && !scrollable(container)) container = container.parentElement
    if (container && container !== document.documentElement && container !== document.body) container.scrollBy({ left: dx, top: dy, behavior: 'instant' })
    else scrollTo({ left: scrollX + dx, top: scrollY + dy, behavior: 'instant' })
    return scrollState(args)
  }

  function hasText(args: Record<string, unknown>): boolean {
    const needle = String(args.text ?? '')
    if ((document.body?.innerText ?? '').includes(needle)) return true
    for (const frame of document.querySelectorAll('iframe')) {
      if ((frameDocument(frame)?.body?.innerText ?? '').includes(needle)) return true
    }
    return false
  }

  // ---------------------------------------------------------------------------
  // What the user sees while an agent works (drawn only while the tab is on screen)
  //
  // A rainbow glow breathes around the edges of the page for as long as an
  // agent is at work in it; that is the only color. Everything else is sky
  // blue and plain: a haloed pointer that carries the agent's name and what
  // it is doing, a frame on what it acts on, a ring where it clicks, a scan
  // line when it reads. Everything animates transform and opacity alone, so
  // the page's compositor runs it without repainting or waiting on the page's
  // own scripts, and the rainbow is a 96 px canvas the GPU scales and spins,
  // never a page-sized gradient.
  // ---------------------------------------------------------------------------

  /** Sky blue: the cursor and everything it does. */
  const SKY = '40 182 246'
  /** A touch deeper, for lines that must read on white. */
  const SKY_LINE = '14 160 230'
  const SPECTRUM = ['#ff4d8d', '#ff8a3d', '#ffd23f', '#3ddc97', '#2ec5ff', '#4f6bff', '#b259ff', '#ff4d8d']
  const FONT = '-apple-system, BlinkMacSystemFont, "Helvetica Neue", sans-serif'
  const SPRING = 'cubic-bezier(0.22, 1, 0.36, 1)'
  const SVG = 'http://www.w3.org/2000/svg'
  /** The cursor fades out after this long without moving. */
  const CURSOR_IDLE_MS = 4000
  const calm = matchMedia('(prefers-reduced-motion: reduce)').matches

  const overlay = {
    host: null as HTMLElement | null,
    root: null as ShadowRoot | null,
    aura: null as HTMLElement | null,
    layer: null as HTMLElement | null,
    cursor: null as HTMLElement | null,
    pointer: null as HTMLElement | null,
    tag: null as HTMLElement | null,
    name: null as HTMLElement | null,
    sep: null as HTMLElement | null,
    status: null as HTMLElement | null,
    /** The cursor's endless animations, paused while it is hidden. */
    loops: [] as Animation[],
    shown: false,
    x: -1,
    y: -1,
    lastScan: 0,
    auraTimer: 0,
    idleTimer: 0,
    teardownTimer: 0
  }

  function css(el: HTMLElement | SVGElement, styles: Record<string, string>): void {
    for (const [k, v] of Object.entries(styles)) el.style.setProperty(k, v)
  }

  function div(parent: Node, styles: Record<string, string>): HTMLElement {
    const el = document.createElement('div')
    css(el, styles)
    parent.appendChild(el)
    return el
  }

  function svgEl(parent: Node, tag: string, attrs: Record<string, string>): SVGElement {
    const el = document.createElementNS(SVG, tag)
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v)
    parent.appendChild(el)
    return el
  }

  /** Remove `el` once its animation is over (or cancelled). */
  function dropAfter(el: Element, animation: Animation): void {
    animation.finished.then(
      () => el.remove(),
      () => el.remove()
    )
  }

  /** A rainbow disc `size` across spinning in `parent` (the glow): a tiny canvas the compositor scales and rotates. */
  function rainbow(parent: HTMLElement, size: string, period: number): Animation | null {
    const canvas = document.createElement('canvas')
    canvas.width = canvas.height = 96
    const ctx = canvas.getContext('2d')
    if (ctx) {
      const gradient = ctx.createConicGradient(0, 48, 48)
      SPECTRUM.forEach((color, i) => gradient.addColorStop(i / (SPECTRUM.length - 1), color))
      ctx.fillStyle = gradient
      ctx.fillRect(0, 0, 96, 96)
    }
    css(canvas, { position: 'absolute', left: '50%', top: '50%', width: size, height: size, transform: 'translate(-50%, -50%)' })
    parent.appendChild(canvas)
    if (calm) return null
    return canvas.animate([{ transform: 'translate(-50%, -50%) rotate(0turn)' }, { transform: 'translate(-50%, -50%) rotate(1turn)' }], {
      duration: Math.abs(period),
      direction: period < 0 ? 'reverse' : 'normal',
      iterations: Infinity
    })
  }

  /** Fade from wherever the element is now. */
  function fade(el: HTMLElement, to: number, duration: number): Animation {
    const from = getComputedStyle(el).opacity
    for (const a of el.getAnimations()) if (a.id === 'fade') a.cancel()
    el.style.opacity = String(to)
    return el.animate([{ opacity: from }, { opacity: to }], { duration, easing: 'ease-out', id: 'fade' })
  }

  /** Build the overlay. Styles go through CSSOM, which page CSP does not police. */
  function ensureOverlay(name: string): void {
    if (overlay.host?.isConnected) {
      clearTimeout(overlay.teardownTimer)
      if (overlay.name && overlay.name.textContent !== name) overlay.name.textContent = name
      return
    }
    teardown()
    const host = document.createElement('arc-agent-overlay')
    css(host, { position: 'fixed', inset: '0', 'pointer-events': 'none', 'z-index': '2147483647', contain: 'strict', display: 'block' })
    const root = host.attachShadow({ mode: 'closed' })
    const layer = div(root, { position: 'absolute', inset: '0' })
    const cursor = div(root, { position: 'absolute', left: '0', top: '0', opacity: '0', 'will-change': 'transform, opacity' })

    // A soft sky-blue halo that breathes around the arrow.
    const halo = div(cursor, {
      position: 'absolute',
      left: '-24px',
      top: '-23px',
      width: '64px',
      height: '64px',
      'border-radius': '50%',
      background: `radial-gradient(circle closest-side, rgb(${SKY} / 0.42), rgb(${SKY} / 0.18) 45%, rgb(${SKY} / 0))`
    })
    const breathe = calm
      ? null
      : halo.animate([{ transform: 'scale(0.8)', opacity: 0.7 }, { transform: 'scale(1.12)', opacity: 1 }], {
          duration: 1400,
          direction: 'alternate',
          iterations: Infinity,
          easing: 'ease-in-out'
        })

    // The pointer: a rounded sky-blue arrow in a thick white outline, with a soft shadow. Its tip is at (0, 0).
    const pointer = div(cursor, { position: 'absolute', left: '-3.25px', top: '-3.25px', width: '26px', height: '26px', 'transform-origin': '3.25px 3.25px' })
    const svg = svgEl(pointer, 'svg', { width: '26', height: '26', viewBox: '0 0 24 24' })
    css(svg, { display: 'block', overflow: 'visible', filter: 'drop-shadow(0 1.5px 2.5px rgb(8 60 110 / 0.35))' })
    // Short and wide: the left edge nearly upright, the top edge falling at about 27°, a notch at the back.
    const arrow = 'M3 3 L17.6 10.3 L9.4 14.5 L6.4 20.4 Z'
    // The outline is a wide white stroke under the fill; a thin stroke in the fill's own color rounds its corners.
    svgEl(svg, 'path', { d: arrow, fill: 'white', stroke: 'white', 'stroke-width': '5', 'stroke-linejoin': 'round' })
    svgEl(svg, 'path', { d: arrow, fill: `rgb(${SKY})`, stroke: `rgb(${SKY})`, 'stroke-width': '1.6', 'stroke-linejoin': 'round' })

    // The name tag: a status light, the agent's name, and what it is doing.
    const tag = div(cursor, {
      position: 'absolute',
      left: '18px',
      top: '24px',
      display: 'flex',
      'align-items': 'center',
      gap: '6px',
      height: '24px',
      padding: '0 10px 0 5px',
      'box-sizing': 'border-box',
      'border-radius': '12px',
      background: `linear-gradient(135deg, rgb(${SKY} / 0.95), rgb(${SKY_LINE} / 0.95))`,
      'backdrop-filter': 'blur(12px) saturate(1.4)',
      border: '1px solid rgb(255 255 255 / 0.5)',
      'box-shadow': `0 6px 18px -6px rgb(${SKY_LINE} / 0.75), inset 0 1px 0 rgb(255 255 255 / 0.4)`,
      color: 'white',
      'text-shadow': '0 1px 1px rgb(20 70 140 / 0.3)',
      font: `600 11.5px/16px ${FONT}`,
      'letter-spacing': '0.01em',
      'white-space': 'nowrap',
      '-webkit-font-smoothing': 'antialiased'
    })
    const light = div(tag, {
      flex: 'none',
      width: '7px',
      height: '7px',
      margin: '0 1px 0 3px',
      'border-radius': '50%',
      background: 'white',
      'box-shadow': '0 0 6px 1px rgb(255 255 255 / 0.85)'
    })
    const pulse = calm
      ? null
      : light.animate([{ opacity: 1 }, { opacity: 0.45 }], { duration: 900, direction: 'alternate', iterations: Infinity, easing: 'ease-in-out' })
    const nameEl = div(tag, {})
    nameEl.textContent = name
    const sep = div(tag, { display: 'none', width: '1px', height: '12px', background: 'rgb(255 255 255 / 0.4)' })
    const status = div(tag, { display: 'none', 'font-weight': '500', opacity: '0.92', 'max-width': '260px', overflow: 'hidden', 'text-overflow': 'ellipsis' })

    document.documentElement.appendChild(host)
    const loops = [breathe, pulse].filter((a): a is Animation => a !== null)
    for (const a of loops) a.pause()
    Object.assign(overlay, { host, root, layer, cursor, pointer, tag, name: nameEl, sep, status, loops, shown: false })
  }

  /** With no glow and no cursor left, take the overlay out of the page. */
  function scheduleTeardown(): void {
    clearTimeout(overlay.teardownTimer)
    overlay.teardownTimer = window.setTimeout(() => {
      if (!overlay.aura && !overlay.shown) teardown()
    }, 2000)
  }

  function teardown(): void {
    clearTimeout(overlay.auraTimer)
    clearTimeout(overlay.idleTimer)
    clearTimeout(overlay.teardownTimer)
    overlay.host?.remove()
    Object.assign(overlay, { host: null, root: null, aura: null, layer: null, cursor: null, pointer: null, tag: null, name: null, sep: null, status: null, loops: [], shown: false })
  }

  // -- the glow around the page -----------------------------------------------

  /** How strong the glow is on its way in from the page's edge: [alpha, px from the edge]. */
  const GLOW: [number, number][] = [
    [0.95, 0],
    [0.7, 12],
    [0.42, 32],
    [0.2, 58],
    [0.07, 84],
    [0, 110]
  ]

  /**
   * Strong at the page's edge and gone a little way in, like an inset shadow:
   * a strip along each side and a quarter circle in each corner, so it rounds
   * the corners instead of piling up in them. The pieces never overlap.
   */
  function glowMask(): Record<string, string> {
    const reach = GLOW.at(-1)![1]
    const alpha = (a: number) => `rgb(0 0 0 / ${a})`
    const linear = (to: string) => `linear-gradient(to ${to}, ${GLOW.map(([a, d]) => `${alpha(a)} ${d}px`).join(', ')})`
    // Centred on the corner piece's inner point, which is `reach` from both edges.
    const radial = (at: string) =>
      `radial-gradient(circle ${reach}px at ${at}, ${GLOW.toReversed().map(([a, d]) => `${alpha(a)} ${reach - d}px`).join(', ')})`
    const strip = `calc(100% - ${2 * reach}px)`
    const corner = `${reach}px ${reach}px`
    const pieces = [
      [linear('bottom'), `${strip} ${reach}px`, '50% 0'],
      [linear('top'), `${strip} ${reach}px`, '50% 100%'],
      [linear('right'), `${reach}px ${strip}`, '0 50%'],
      [linear('left'), `${reach}px ${strip}`, '100% 50%'],
      [radial('100% 100%'), corner, '0 0'],
      [radial('0 100%'), corner, '100% 0'],
      [radial('100% 0'), corner, '0 100%'],
      [radial('0 0'), corner, '100% 100%']
    ]
    return {
      'mask-image': pieces.map((p) => p[0]).join(', '),
      'mask-size': pieces.map((p) => p[1]).join(', '),
      'mask-position': pieces.map((p) => p[2]).join(', '),
      'mask-repeat': 'no-repeat'
    }
  }

  function showAura(): void {
    if (overlay.aura || !overlay.root) return
    const aura = document.createElement('div')
    css(aura, { position: 'absolute', inset: '0', overflow: 'hidden' })
    // Under the highlights and the cursor.
    overlay.root.insertBefore(aura, overlay.root.firstChild)
    // A bloom that breathes inward from the edge; the page view's own rounded
    // corners trim it, so nothing is drawn outside the page.
    const bloom = div(aura, { position: 'absolute', inset: '0', ...glowMask() })
    rainbow(bloom, '150vmax', -11_000)
    aura.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 700, easing: 'ease-out' })
    if (!calm) bloom.animate([{ opacity: 1 }, { opacity: 0.6 }], { duration: 1600, direction: 'alternate', iterations: Infinity, easing: 'ease-in-out' })
    overlay.aura = aura
  }

  function hideAura(): void {
    const aura = overlay.aura
    if (!aura) return
    overlay.aura = null
    dropAfter(aura, aura.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 500, easing: 'ease-in', fill: 'forwards' }))
  }

  /** An agent is (or no longer is) at work in this tab. The glow goes by itself after `ttl` without a word from main. */
  function presence(args: Record<string, unknown>): void {
    clearTimeout(overlay.auraTimer)
    if (!args.on) {
      hideAura()
      hideCursor()
      return
    }
    ensureOverlay(String(args.name || 'Agent'))
    showAura()
    overlay.auraTimer = window.setTimeout(() => presence({ on: false }), Number(args.ttl) || 50_000)
  }

  // -- the cursor -------------------------------------------------------------

  function showCursor(): void {
    const cursor = overlay.cursor
    if (!cursor) return
    clearTimeout(overlay.idleTimer)
    overlay.idleTimer = window.setTimeout(hideCursor, CURSOR_IDLE_MS)
    if (overlay.shown) return
    overlay.shown = true
    fade(cursor, 1, 180)
    for (const a of overlay.loops) a.play()
  }

  function hideCursor(): void {
    clearTimeout(overlay.idleTimer)
    const cursor = overlay.cursor
    if (cursor && overlay.shown) {
      overlay.shown = false
      fade(cursor, 0, 450).finished.then(
        () => {
          if (!overlay.shown) for (const a of overlay.loops) a.pause()
        },
        () => undefined
      )
    }
    scheduleTeardown()
  }

  function setStatus(text: string): void {
    const { status, sep } = overlay
    if (!status || !sep || status.textContent === text) return
    status.textContent = text
    status.style.display = sep.style.display = text ? 'block' : 'none'
    if (text && !calm) status.animate([{ opacity: 0, transform: 'translateY(4px)' }, { opacity: 0.92, transform: 'none' }], { duration: 220, easing: SPRING })
  }

  /** The tag sits right of and below the pointer, and flips to stay on screen. */
  function placeTag(x: number, y: number): void {
    const tag = overlay.tag
    if (!tag) return
    const flipX = x + 18 + (tag.offsetWidth || 160) > innerWidth - 8
    const flipY = y + 48 > innerHeight - 8
    css(tag, { left: flipX ? 'auto' : '18px', right: flipX ? '10px' : 'auto', top: flipY ? 'auto' : '24px', bottom: flipY ? '10px' : 'auto' })
  }

  async function moveCursor(args: Record<string, unknown>): Promise<void> {
    ensureOverlay(String(args.name || 'Agent'))
    const x = Number(args.x)
    const y = Number(args.y)
    const cursor = overlay.cursor!
    setStatus(typeof args.status === 'string' ? args.status : '')
    if (args.rect) highlight(args.rect as Box)
    const fromX = overlay.x < 0 ? x + 60 : overlay.x
    const fromY = overlay.y < 0 ? y + 80 : overlay.y
    overlay.x = x
    overlay.y = y
    placeTag(x, y)
    const dx = x - fromX
    const duration = calm ? 0 : Math.round(Math.min(520, Math.max(180, Math.hypot(dx, y - fromY) / 2)))
    for (const a of cursor.getAnimations()) if (a.id === 'glide') a.cancel()
    showCursor()
    css(cursor, { transform: `translate(${x}px, ${y}px)` })
    if (!duration) return
    const glide = cursor.animate([{ transform: `translate(${fromX}px, ${fromY}px)` }, { transform: `translate(${x}px, ${y}px)` }], { duration, easing: SPRING, id: 'glide' })
    // The pointer leans into the move, then settles.
    const lean = Math.max(-14, Math.min(14, dx / 20))
    overlay.pointer?.animate([{ rotate: '0deg' }, { rotate: `${lean}deg`, offset: 0.3 }, { rotate: '0deg' }], { duration: duration + 160, easing: 'ease-out' })
    await Promise.race([glide.finished.catch(() => undefined), new Promise((r) => setTimeout(r, duration + 120))])
  }

  /** Say what the agent is doing without moving the cursor (keys, typing into what has focus). */
  function cursorStatus(args: Record<string, unknown>): void {
    if (!overlay.cursor || overlay.x < 0) return
    setStatus(String(args.status ?? ''))
    placeTag(overlay.x, overlay.y)
    showCursor()
  }

  // -- effects ------------------------------------------------------------------

  /** A sky-blue frame around what the agent is about to act on. */
  function highlight(box: Box): void {
    const layer = overlay.layer
    if (!layer) return
    const pad = 4
    const frame = div(layer, {
      position: 'absolute',
      left: `${box.x - pad}px`,
      top: `${box.y - pad}px`,
      width: `${box.width + pad * 2}px`,
      height: `${box.height + pad * 2}px`,
      'box-sizing': 'border-box',
      'border-radius': `${Math.min(10, box.height / 2 + pad)}px`,
      border: `1.5px solid rgb(${SKY_LINE} / 0.9)`,
      background: `rgb(${SKY} / 0.1)`,
      'box-shadow': `0 0 0 3px rgb(${SKY} / 0.16), 0 0 16px rgb(${SKY} / 0.35)`
    })
    dropAfter(
      frame,
      frame.animate(
        [
          { opacity: 0, transform: 'scale(1.06)', easing: SPRING },
          { opacity: 1, transform: 'scale(1)', offset: 0.15 },
          { opacity: 1, transform: 'scale(1)', offset: 0.75, easing: 'ease-in' },
          { opacity: 0, transform: 'scale(1)' }
        ],
        { duration: calm ? 900 : 1500, fill: 'forwards' }
      )
    )
  }

  /** A sky-blue ring spreading from where the agent clicked. */
  function clickRipple(args: Record<string, unknown>): void {
    const layer = overlay.layer
    if (!layer) return
    const x = Number(args.x)
    const y = Number(args.y)
    const ring = div(layer, {
      position: 'absolute',
      left: `${x - 20}px`,
      top: `${y - 20}px`,
      width: '40px',
      height: '40px',
      'box-sizing': 'border-box',
      'border-radius': '50%',
      border: `2px solid rgb(${SKY_LINE})`,
      background: `rgb(${SKY} / 0.2)`
    })
    dropAfter(
      ring,
      ring.animate([{ transform: 'scale(0.3)', opacity: 0.9 }, { transform: 'scale(1.4)', opacity: 0 }], { duration: 520, easing: SPRING, fill: 'forwards' })
    )
    overlay.pointer?.animate([{ scale: '1' }, { scale: '0.82', offset: 0.35 }, { scale: '1' }], { duration: 240, easing: 'ease-out' })
  }

  /** A scan line sweeps down the page while the agent reads it (at most every few seconds). */
  function scan(args: Record<string, unknown>): void {
    ensureOverlay(String(args.name || 'Agent'))
    if (typeof args.status === 'string' && overlay.x >= 0) cursorStatus(args)
    const now = Date.now()
    if (!calm && now - overlay.lastScan > 2500) {
      overlay.lastScan = now
      const band = div(overlay.layer!, {
        position: 'absolute',
        left: '0',
        right: '0',
        top: '0',
        height: '160px',
        background: `linear-gradient(to bottom, rgb(${SKY} / 0), rgb(${SKY} / 0.05) 60%, rgb(${SKY} / 0.16))`
      })
      div(band, {
        position: 'absolute',
        left: '0',
        right: '0',
        bottom: '0',
        height: '2px',
        background: `linear-gradient(to right, rgb(${SKY} / 0), rgb(${SKY_LINE}) 30%, rgb(${SKY_LINE}) 70%, rgb(${SKY} / 0))`,
        'box-shadow': `0 0 12px 1px rgb(${SKY} / 0.6)`
      })
      dropAfter(
        band,
        band.animate(
          [
            { transform: 'translateY(-160px)', opacity: 0 },
            { opacity: 1, offset: 0.12 },
            { opacity: 1, offset: 0.8 },
            { transform: `translateY(${innerHeight}px)`, opacity: 0 }
          ],
          { duration: 1200, easing: 'cubic-bezier(0.45, 0, 0.2, 1)', fill: 'forwards' }
        )
      )
    }
    if (!overlay.aura && !overlay.shown) scheduleTeardown()
  }

  /** Hide the overlay around a screenshot, so the agent sees the page as it is. */
  async function overlayVisible(args: Record<string, unknown>): Promise<boolean> {
    const host = overlay.host
    if (!host?.isConnected) return false
    host.style.setProperty('visibility', args.visible ? 'visible' : 'hidden')
    if (!args.visible) {
      await new Promise<void>((resolve) => {
        const done = () => resolve()
        requestAnimationFrame(() => requestAnimationFrame(done))
        setTimeout(done, 120)
      })
    }
    return true
  }

  // ---------------------------------------------------------------------------

  const methods: Record<string, (args: Record<string, unknown>) => unknown> = {
    snapshot,
    find,
    readPage,
    target,
    shotBox,
    pointInfo,
    focusField,
    fill,
    markUpload,
    unmarkUpload,
    scrollState,
    scrollBy,
    hasText,
    isPdf: () => document.contentType === 'application/pdf',
    describe: (args) => describe(resolve(args.ref)),
    presence,
    moveCursor,
    cursorStatus,
    clickRipple,
    scan,
    overlayVisible
  }

  return {
    async call(method: string, args: Record<string, unknown>): Promise<Reply> {
      try {
        const fn = methods[method]
        if (!fn) throw new Error(`Unknown page method ${method}`)
        const value = await fn(args)
        return { value, next }
      } catch (error) {
        return { error: error instanceof Error ? error.message : String(error), next }
      }
    }
  }
}
