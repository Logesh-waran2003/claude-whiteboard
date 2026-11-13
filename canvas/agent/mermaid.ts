// M5. Mermaid flowchart subset -> board ops. Pure. Every node is left unplaced so the layout engine places it.
import type { LayoutKind, Op, ShapeKind } from '../core/model'

export type MermaidResult =
  | { ok: true; ops: Op[]; warnings: string[]; /** Mermaid id -> board id (nodes and groups). */ ids: Record<string, string>; /** Board ids of the edges it adds. */ edges: string[] }
  | { ok: false; line: number; message: string }

export type MermaidOptions = {
  /** Put the whole diagram inside this existing group. */
  parent?: string
  /** Override the layout of the container (root or parent). Default: from the header direction. */
  layout?: LayoutKind
  /** Node ids already on the board: a Mermaid id that matches one reuses that node (no add_node). */
  existingNodes?: Set<string>
  /** Every id already on the board (nodes and edges): new ids avoid them. */
  takenIds?: Set<string>
}

type Sub = { id: string; title: string; parent?: string; layout?: LayoutKind; line: number }
type NodeIR = { id: string; text?: string; shape?: ShapeKind; parent?: string }
type EdgeIR = { from: string; to: string; label?: string; arrow: 'none' | 'end' | 'both' }

class SyntaxErr extends Error {}

const DIRS: Record<string, LayoutKind> = { TD: 'dag-tb', TB: 'dag-tb', BT: 'dag-tb', LR: 'dag-lr', RL: 'dag-lr' }

// Longest openers first.
const SHAPES: [open: string, close: string, shape: ShapeKind][] = [
  ['([', '])', 'rect'],
  ['((', '))', 'ellipse'],
  ['[[', ']]', 'rect'],
  ['[(', ')]', 'rect'],
  ['{{', '}}', 'rect'],
  ['[', ']', 'rect'],
  ['(', ')', 'rect'],
  ['{', '}', 'diamond'],
  ['>', ']', 'rect'],
]

const ID = /[\p{L}\p{N}_]+/uy
const LABELLED_LINK = /(<)?(--|==|-\.)(?![->=.])\s*(.+?)\s*(-{2,}>|-{3,}|={2,}>|={3,}|\.-+>|\.-+)/y
const PLAIN_LINK = /(<)?(-{2,}>|-{3,}|={2,}>|={3,}|-\.+->|-\.+-)(?:\s*\|([^|]*)\|)?/y

const unquote = (s: string) => s.trim().replace(/^"(.*)"$/s, '$1')
const cleanText = (s: string) => unquote(s).replace(/<br\s*\/?>/gi, '\n').replace(/^[/\\](.*)[/\\]$/s, '$1').trim()

/** Split on `;` outside double quotes; drop a `%%` comment tail. */
function statements(line: string): string[] {
  const out: string[] = []
  let cur = ''
  let quoted = false
  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    if (c === '"') quoted = !quoted
    if (!quoted && c === '%' && line[i + 1] === '%') break
    if (!quoted && c === ';') (out.push(cur), (cur = ''))
    else cur += c
  }
  out.push(cur)
  return out.map((s) => s.trim()).filter(Boolean)
}

type NodeRef = { id: string; text?: string; shape?: ShapeKind }

/** Parse `A --> B & C -- label --> D` into node groups and the links between them. */
function parseChain(s: string): { groups: NodeRef[][]; links: { label?: string; arrow: EdgeIR['arrow'] }[] } {
  let pos = 0
  const ws = () => {
    while (pos < s.length && /\s/.test(s[pos])) pos++
  }
  const node = (): NodeRef => {
    ws()
    ID.lastIndex = pos
    const m = ID.exec(s)
    if (!m) throw new SyntaxErr(`expected a node id at column ${pos + 1}, found "${s.slice(pos, pos + 12)}"`)
    pos = ID.lastIndex
    const ref: NodeRef = { id: m[0] }
    for (const [open, close, shape] of SHAPES) {
      if (!s.startsWith(open, pos)) continue
      let start = pos + open.length
      let end: number
      let text: string
      const lead = s.slice(start).match(/^\s*"/)
      if (lead) {
        const q = s.indexOf('"', start + lead[0].length)
        if (q < 0) throw new SyntaxErr(`unclosed quote in the label of node "${ref.id}"`)
        text = s.slice(start + lead[0].length, q)
        start = q + 1
        end = s.indexOf(close, start)
        if (end < 0 || s.slice(start, end).trim()) throw new SyntaxErr(`expected "${close}" after the quoted label of node "${ref.id}"`)
      } else {
        end = s.indexOf(close, start)
        if (end < 0) throw new SyntaxErr(`unclosed "${open}" in node "${ref.id}"; close it with "${close}"`)
        text = s.slice(start, end)
      }
      ref.text = cleanText(text)
      ref.shape = shape
      pos = end + close.length
      break
    }
    const cls = /:::[\w-]+/y
    cls.lastIndex = pos
    if (cls.exec(s)) pos = cls.lastIndex
    return ref
  }
  const group = (): NodeRef[] => {
    const g = [node()]
    for (;;) {
      ws()
      if (s[pos] !== '&') return g
      pos++
      g.push(node())
    }
  }
  const groups = [group()]
  const links: { label?: string; arrow: EdgeIR['arrow'] }[] = []
  for (;;) {
    ws()
    if (pos >= s.length) break
    let m: RegExpExecArray | null = null
    let label: string | undefined
    let both = false
    let close = ''
    for (const re of [LABELLED_LINK, PLAIN_LINK]) {
      re.lastIndex = pos
      m = re.exec(s)
      if (!m) continue
      pos = re.lastIndex
      both = !!m[1]
      if (re === LABELLED_LINK) ((label = m[3]), (close = m[4]))
      else ((label = m[3]), (close = m[2]))
      break
    }
    if (!m) throw new SyntaxErr(`expected an arrow like --> at column ${pos + 1}, found "${s.slice(pos, pos + 12)}"`)
    const arrow = close.endsWith('>') ? (both ? 'both' : 'end') : 'none'
    const text = label !== undefined ? cleanText(label) : undefined
    links.push({ label: text || undefined, arrow })
    groups.push(group())
  }
  return { groups, links }
}

/** Parse a Mermaid flowchart into board ops. Never throws: a syntax error returns its 1-based line. */
export function parseMermaid(source: string, opts: MermaidOptions = {}): MermaidResult {
  const warnings: string[] = []
  const lines = source.replace(/\r\n?/g, '\n').split('\n')
  const subs: Sub[] = []
  const stack: Sub[] = []
  const nodes = new Map<string, NodeIR>()
  const edges: EdgeIR[] = []
  let rootLayout: LayoutKind | undefined
  let lineNo = 0
  try {
    for (const raw of lines) {
      lineNo++
      for (const st of statements(raw)) {
        if (!rootLayout) {
          const h = st.match(/^(flowchart|graph)(?:\s+(\w+))?$/i)
          if (!h) throw new SyntaxErr(`expected a header like "flowchart LR" or "graph TD"; only flowcharts are supported (for sequence/ER/2x2 use ops, see get_skill)`)
          const dir = (h[2] ?? 'TB').toUpperCase()
          if (!DIRS[dir]) throw new SyntaxErr(`direction "${h[2]}" is not valid; use TD, TB, LR, RL or BT`)
          if (dir === 'RL' || dir === 'BT') warnings.push(`line ${lineNo}: ${dir} is drawn as ${dir === 'RL' ? 'LR' : 'TB'}`)
          rootLayout = DIRS[dir]
          continue
        }
        const word = st.split(/\s+/)[0]
        if (['classDef', 'class', 'style', 'click', 'linkStyle'].includes(word)) {
          warnings.push(`line ${lineNo}: "${word}" is ignored; the board styles shapes itself`)
          continue
        }
        if (word === 'subgraph') {
          const rest = st.slice('subgraph'.length).trim()
          if (!rest) throw new SyntaxErr('subgraph needs an id or a title')
          let id: string
          let title: string
          const withTitle = rest.match(/^([\p{L}\p{N}_]+)\s*\[(.*)\]$/su)
          if (withTitle) ((id = withTitle[1]), (title = cleanText(withTitle[2])))
          else if (/^[\p{L}\p{N}_]+$/u.test(rest)) id = title = rest
          else ((title = cleanText(rest)), (id = title.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '_').replace(/^_|_$/g, '') || 'group'))
          if (subs.some((s) => s.id === id)) throw new SyntaxErr(`subgraph id "${id}" is used twice; give each subgraph a unique id`)
          const sub: Sub = { id, title, parent: stack.at(-1)?.id, line: lineNo }
          subs.push(sub)
          stack.push(sub)
          continue
        }
        if (st === 'end') {
          if (!stack.pop()) throw new SyntaxErr('"end" without an open subgraph')
          continue
        }
        if (word === 'direction') {
          const dir = st.split(/\s+/)[1]?.toUpperCase() ?? ''
          if (!DIRS[dir]) throw new SyntaxErr(`direction "${dir}" is not valid; use TB, LR, RL or BT`)
          const top = stack.at(-1)
          if (top) top.layout = DIRS[dir]
          else rootLayout = DIRS[dir]
          continue
        }
        const { groups, links } = parseChain(st)
        const inSub = stack.at(-1)?.id
        for (const g of groups)
          for (const ref of g) {
            const n = nodes.get(ref.id) ?? { id: ref.id }
            if (ref.text !== undefined) ((n.text = ref.text), (n.shape = ref.shape))
            if (inSub && n.parent === undefined) n.parent = inSub
            nodes.set(ref.id, n)
          }
        links.forEach((l, i) => {
          for (const a of groups[i]) for (const b of groups[i + 1]) edges.push({ from: a.id, to: b.id, ...l })
        })
      }
    }
    if (!rootLayout) throw new SyntaxErr('empty diagram; start with a header like "flowchart LR"')
    if (stack.length) {
      lineNo = stack.at(-1)!.line
      throw new SyntaxErr(`subgraph "${stack.at(-1)!.id}" is not closed; add "end"`)
    }
  } catch (e) {
    if (e instanceof SyntaxErr) return { ok: false, line: lineNo, message: e.message }
    throw e
  }

  // ---- emit ops: container layout, groups (outer first), nodes, edges
  const existing = opts.existingNodes ?? new Set<string>()
  const taken = new Set(opts.takenIds ?? [])
  const idOf = new Map<string, string>()
  const fresh = (want: string) => {
    let id = want
    for (let k = 2; taken.has(id) || id === 'root'; k++) id = `${want}_${k}`
    taken.add(id)
    return id
  }
  const subIds = new Set(subs.map((s) => s.id))
  for (const s of subs) idOf.set(s.id, fresh(s.id))
  for (const n of nodes.values()) {
    if (subIds.has(n.id)) continue
    if (existing.has(n.id)) {
      idOf.set(n.id, n.id)
      warnings.push(`node "${n.id}" already exists on the board; edges connect to it`)
    } else idOf.set(n.id, fresh(n.id))
  }
  const ops: Op[] = [{ op: 'set_layout', group: opts.parent ?? 'root', layout: opts.layout ?? rootLayout! }]
  const parentOf = (p: string | undefined) => (p ? idOf.get(p) : opts.parent)
  for (const s of subs)
    ops.push({ op: 'add_node', id: idOf.get(s.id), kind: 'group', text: s.title, layout: s.layout ?? rootLayout, ...(parentOf(s.parent) ? { parent: parentOf(s.parent) } : {}) })
  for (const n of nodes.values()) {
    if (subIds.has(n.id) || existing.has(n.id)) continue
    const parent = parentOf(n.parent)
    ops.push({ op: 'add_node', id: idOf.get(n.id), kind: n.shape ?? 'rect', text: n.text ?? n.id, ...(parent ? { parent } : {}) })
  }
  // A reply edge (B -> A after A -> B) would sit on top of the first one: route it as an elbow.
  const pairs = new Set<string>()
  for (const e of edges) {
    const from = idOf.get(e.from)!
    const to = idOf.get(e.to)!
    pairs.add(`${from}\n${to}`)
    const reply = pairs.has(`${to}\n${from}`) && from !== to
    ops.push({
      op: 'add_edge',
      id: fresh(`${from}-${to}`),
      from,
      to,
      ...(e.label ? { label: e.label } : {}),
      ...(e.arrow !== 'end' ? { arrow: e.arrow } : {}),
      ...(reply ? { route: 'elbow' as const } : {}),
    })
  }
  const edgeIds = ops.flatMap((o) => (o.op === 'add_edge' ? [o.id!] : []))
  return { ok: true, ops, warnings, ids: Object.fromEntries(idOf), edges: edgeIds }
}
