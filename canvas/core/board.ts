// M1: the board store. Every change goes through apply(ops): validated on a draft, all or nothing,
// one undo step per batch, one version per change, per-version change records for diffSince.
import {
  TYPE,
  type ApplyOptions,
  type ApplyResult,
  type BoardApi,
  type BoardDiff,
  type CanvasDoc,
  type CanvasEdge,
  type CanvasNode,
  type Op,
} from './model'

const HISTORY_LIMIT = 500
const SHAPES = ['rect', 'ellipse', 'diamond', 'sticky', 'text']
const KINDS = [...SHAPES, 'group']
const LAYOUTS = ['dag-lr', 'dag-tb', 'grid', 'free']
const SIDES = ['top', 'right', 'bottom', 'left']
const ROUTES = ['straight', 'elbow']
const ARROWS = ['none', 'end', 'both']
const NODE_FIELDS = ['kind', 'text', 'file', 'url', 'x', 'y', 'width', 'height', 'color', 'parent', 'role', 'pin', 'layout']
const ALLOWED: Record<Op['op'], string[]> = {
  add_node: ['ref', 'id', ...NODE_FIELDS],
  add_edge: ['ref', 'id', 'from', 'to', 'label', 'fromSide', 'toSide', 'color', 'route', 'arrow'],
  update: ['id', ...NODE_FIELDS],
  update_edge: ['id', 'label', 'color', 'route', 'points', 'fromSide', 'toSide'],
  move: ['ids', 'dx', 'dy'],
  remove: ['ids'],
  set_layout: ['group', 'layout'],
  reorder: ['id', 'to'],
}

type Loose = Record<string, unknown>

class InvalidOp extends Error {
  constructor(
    message: string,
    readonly field?: string,
  ) {
    super(message)
  }
}

function fail(field: string | undefined, message: string): never {
  throw new InvalidOp(message, field)
}
const show = (v: unknown) => JSON.stringify(v) ?? String(v)
const list = (vs: string[]) => vs.map((v) => `"${v}"`).join(', ')

// ---------------------------------------------------------------- field readers (undefined = absent)

function num(op: Loose, f: string): number | undefined {
  const v = op[f]
  if (v === undefined) return undefined
  if (typeof v !== 'number' || !Number.isFinite(v)) fail(f, `${f} ${show(v)} is not valid; use a finite number`)
  return v as number
}
function size(op: Loose, f: string): number | undefined {
  const v = num(op, f)
  if (v !== undefined && v <= 0) fail(f, `${f} ${v} is not valid; use a number greater than 0`)
  return v
}
function str(op: Loose, f: string): string | undefined {
  const v = op[f]
  if (v !== undefined && typeof v !== 'string') fail(f, `${f} ${show(v)} is not valid; use a string`)
  return v as string | undefined
}
function bool(op: Loose, f: string): boolean | undefined {
  const v = op[f]
  if (v !== undefined && typeof v !== 'boolean') fail(f, `${f} ${show(v)} is not valid; use true or false`)
  return v as boolean | undefined
}
function oneOf(op: Loose, f: string, allowed: string[]): string | undefined {
  const v = op[f]
  if (v !== undefined && !allowed.includes(v as string)) fail(f, `${f} ${show(v)} is not valid; use one of ${list(allowed)}`)
  return v as string | undefined
}
function color(op: Loose): string | undefined {
  const v = op.color
  if (v === undefined) return undefined
  if (typeof v !== 'string' || !/^([1-6]|#[0-9a-fA-F]{6})$/.test(v)) fail('color', `color ${show(v)} is not valid; use "1".."6" or "#rrggbb"`)
  return v as string
}
function need<T>(f: string, v: T | undefined): T {
  if (v === undefined) fail(f, `${f} is required`)
  return v as T
}

// ---------------------------------------------------------------- draft: a mutable copy for one batch

class Draft {
  nodes: CanvasNode[]
  edges: CanvasEdge[]
  root: Loose
  refs = new Map<string, string>()

  constructor(
    doc: CanvasDoc,
    private by: string,
  ) {
    this.nodes = [...doc.nodes]
    this.edges = [...doc.edges]
    this.root = { ...doc } // keeps the key order of the original doc
  }

  toDoc(): CanvasDoc {
    return { ...this.root, nodes: this.nodes, edges: this.edges } as CanvasDoc
  }

  apply(raw: unknown) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail(undefined, 'op must be an object like {"op":"add_node",...}')
    const op = raw as Loose
    const allowed = ALLOWED[op.op as Op['op']]
    if (!allowed || !Object.hasOwn(ALLOWED, op.op as string)) fail('op', `op ${show(op.op)} is not valid; use one of ${list(Object.keys(ALLOWED))}`)
    for (const k of Object.keys(op)) {
      if (k !== 'op' && op[k] !== undefined && !allowed.includes(k)) fail(k, `field "${k}" is not valid for ${op.op}; use ${list(allowed)}`)
    }
    switch (op.op as Op['op']) {
      case 'add_node': return this.addNode(op)
      case 'add_edge': return this.addEdge(op)
      case 'update': return this.update(op)
      case 'update_edge': return this.updateEdge(op)
      case 'move': return this.move(op)
      case 'remove': return this.remove(op)
      case 'set_layout': return this.setLayout(op)
      case 'reorder': return this.reorder(op)
    }
  }

  // ---- lookups

  private resolve(v: string) {
    return this.refs.get(v) ?? v
  }
  private exists(id: string) {
    return this.nodes.some((n) => n.id === id) || this.edges.some((e) => e.id === id)
  }
  private nodeIndex(f: string, value: unknown): number {
    if (typeof value !== 'string') fail(f, `${f} ${show(value)} is not valid; use a node id or a ref from this batch`)
    const id = this.resolve(value as string)
    const i = this.nodes.findIndex((n) => n.id === id)
    if (i < 0) fail(f, `${f} "${value}" is not a node on the board; use an existing node id or a ref defined earlier in this batch`)
    return i
  }
  private groupId(f: string, value: unknown): string {
    const node = this.nodes[this.nodeIndex(f, value)]
    if (node.type !== 'group') fail(f, `${f} "${value}" is a ${node.type} node, not a group; use a group id`)
    return node.id
  }
  private ids(op: Loose, f: string): string[] {
    const v = op[f]
    if (!Array.isArray(v) || v.length === 0) fail(f, `${f} must be a non-empty array of ids`)
    return (v as unknown[]).map((x, i) => {
      if (typeof x !== 'string') fail(`${f}[${i}]`, `${f}[${i}] ${show(x)} is not valid; use an id string`)
      return this.resolve(x as string)
    })
  }

  private newId(op: Loose): string {
    const ref = str(op, 'ref')
    if (ref !== undefined && (ref === '' || this.refs.has(ref))) fail('ref', `ref "${ref}" is ${ref ? 'already used in this batch' : 'empty'}; use a unique non-empty ref`)
    let id = str(op, 'id')
    if (id !== undefined) {
      if (id === '' || id === 'root') fail('id', `id "${id}" is reserved; use another id or omit id`)
      if (this.exists(id)) fail('id', `id "${id}" already exists; use a new id or omit id to get a generated one`)
    } else {
      do id = Math.random().toString(36).slice(2, 10).padEnd(8, '0')
      while (this.exists(id))
    }
    if (ref !== undefined) this.refs.set(ref, id)
    return id
  }

  /** Throws if making `groupId` the parent of `nodeId` would create a cycle. */
  private checkCycle(nodeId: string, groupId: string) {
    const seen = new Set<string>()
    for (let cur: string | undefined = groupId; cur && !seen.has(cur); cur = this.nodes.find((n) => n.id === cur)?.['x-parent']) {
      if (cur === nodeId) fail('parent', `parent "${groupId}" would put "${nodeId}" inside itself; use a group that is not inside this node`)
      seen.add(cur)
    }
  }

  // ---- ops

  private addNode(op: Loose) {
    const kind = oneOf(op, 'kind', KINDS) ?? 'rect'
    const text = str(op, 'text')
    const file = str(op, 'file')
    const url = str(op, 'url')
    const x = num(op, 'x')
    const y = num(op, 'y')
    const width = size(op, 'width')
    const height = size(op, 'height')
    const col = color(op)
    const role = str(op, 'role')
    const pin = bool(op, 'pin')
    const layout = oneOf(op, 'layout', LAYOUTS)
    if (file !== undefined && url !== undefined) fail('url', 'give file or url, not both')
    if (kind === 'group' && file !== undefined) fail('file', 'file is not valid for kind "group"; use it on a non-group node')
    if (kind === 'group' && url !== undefined) fail('url', 'url is not valid for kind "group"; use it on a non-group node')
    if (kind !== 'group' && layout !== undefined) fail('layout', 'layout is only valid for kind "group"')
    const parent = op.parent !== undefined ? this.groupId('parent', op.parent) : undefined
    const id = this.newId(op)

    const def = kind === 'sticky' ? TYPE.sticky : TYPE.minNode
    const node: Loose = { id }
    if (kind === 'group') {
      node.type = 'group'
      if (text !== undefined) node.label = text
    } else if (file !== undefined) Object.assign(node, { type: 'file', file })
    else if (url !== undefined) Object.assign(node, { type: 'link', url })
    else Object.assign(node, { type: 'text', text: text ?? '' })
    Object.assign(node, { x: x ?? 0, y: y ?? 0, width: width ?? def.width, height: height ?? def.height })
    if (col !== undefined) node.color = col
    if (kind !== 'group' && (node.type === 'text' || op.kind !== undefined)) node['x-shape'] = kind
    if (layout !== undefined) node['x-layout'] = layout
    node['x-by'] = this.by
    if (parent !== undefined) node['x-parent'] = parent
    if (role !== undefined) node['x-role'] = role
    if (pin !== undefined) node['x-pin'] = pin
    if (x === undefined && y === undefined) node['x-placed'] = false

    if (kind === 'group') {
      // Groups stay before non-groups so they never cover their children.
      let last = -1
      this.nodes.forEach((n, i) => n.type === 'group' && (last = i))
      this.nodes.splice(last + 1, 0, node as CanvasNode)
    } else this.nodes.push(node as CanvasNode)
  }

  private addEdge(op: Loose) {
    const from = this.nodes[this.nodeIndex('from', need('from', op.from))].id
    const to = this.nodes[this.nodeIndex('to', need('to', op.to))].id
    const label = str(op, 'label')
    const fromSide = oneOf(op, 'fromSide', SIDES)
    const toSide = oneOf(op, 'toSide', SIDES)
    const col = color(op)
    const route = oneOf(op, 'route', ROUTES)
    const arrow = oneOf(op, 'arrow', ARROWS) ?? 'end'
    const id = this.newId(op)
    const edge: Loose = { id, fromNode: from }
    if (fromSide !== undefined) edge.fromSide = fromSide
    if (arrow === 'both') edge.fromEnd = 'arrow'
    edge.toNode = to
    if (toSide !== undefined) edge.toSide = toSide
    edge.toEnd = arrow === 'none' ? 'none' : 'arrow'
    if (col !== undefined) edge.color = col
    if (label !== undefined) edge.label = label
    edge['x-by'] = this.by
    if (route !== undefined) edge['x-route'] = route
    this.edges.push(edge as CanvasEdge)
  }

  private update(op: Loose) {
    const i = this.nodeIndex('id', need('id', op.id))
    const node = this.nodes[i]
    const next: Loose = { ...node }
    const isGroup = node.type === 'group'
    const kind = oneOf(op, 'kind', KINDS)
    if (kind !== undefined) {
      if ((kind === 'group') !== isGroup) fail('kind', `cannot change kind between group and non-group; remove the node and add a new one`)
      if (!isGroup) next['x-shape'] = kind
    }
    const text = str(op, 'text')
    if (text !== undefined) {
      if (isGroup) next.label = text
      else if (node.type === 'text') next.text = text
      else fail('text', `text is not valid on ${node.type} node "${node.id}"; use it on text nodes and groups`)
    }
    const file = str(op, 'file')
    if (file !== undefined) {
      if (node.type !== 'file') fail('file', `file is not valid on ${node.type} node "${node.id}"; use it on file nodes`)
      next.file = file
    }
    const url = str(op, 'url')
    if (url !== undefined) {
      if (node.type !== 'link') fail('url', `url is not valid on ${node.type} node "${node.id}"; use it on link nodes`)
      next.url = url
    }
    for (const f of ['x', 'y'] as const) {
      const v = num(op, f)
      if (v !== undefined) {
        next[f] = v
        if (next['x-placed'] === false) delete next['x-placed']
      }
    }
    for (const f of ['width', 'height'] as const) {
      const v = size(op, f)
      if (v !== undefined) next[f] = v
    }
    const col = color(op)
    if (col !== undefined) next.color = col
    const role = str(op, 'role')
    if (role !== undefined) next['x-role'] = role
    const pin = bool(op, 'pin')
    if (pin !== undefined) next['x-pin'] = pin
    const layout = oneOf(op, 'layout', LAYOUTS)
    if (layout !== undefined) {
      if (!isGroup) fail('layout', 'layout is only valid on groups')
      next['x-layout'] = layout
    }
    if (op.parent !== undefined) {
      // "" = take the node out of its group.
      if (op.parent === '') delete next['x-parent']
      else {
        const parent = this.groupId('parent', op.parent)
        this.checkCycle(node.id, parent)
        next['x-parent'] = parent
      }
    }
    this.nodes[i] = next as CanvasNode
  }

  private updateEdge(op: Loose) {
    const id = need('id', str(op, 'id'))
    const i = this.edges.findIndex((e) => e.id === this.resolve(id))
    if (i < 0) fail('id', `id "${id}" is not an edge on the board; use an existing edge id (use "update" for nodes)`)
    const next: Loose = { ...this.edges[i] }
    const label = str(op, 'label')
    if (label !== undefined) next.label = label
    const col = color(op)
    if (col !== undefined) next.color = col
    const route = oneOf(op, 'route', ROUTES)
    if (route !== undefined) next['x-route'] = route
    for (const f of ['fromSide', 'toSide']) {
      const v = oneOf(op, f, SIDES)
      if (v !== undefined) next[f] = v
    }
    if (op.points !== undefined) {
      if (!Array.isArray(op.points)) fail('points', 'points must be an array of {x, y}')
      next['x-points'] = (op.points as unknown[]).map((p, k) => {
        const pt = p as Loose
        if (!pt || typeof pt !== 'object' || !Number.isFinite(pt.x) || !Number.isFinite(pt.y))
          fail(`points[${k}]`, `points[${k}] ${show(p)} is not valid; use {"x": number, "y": number}`)
        return { x: pt.x as number, y: pt.y as number }
      })
    }
    this.edges[i] = next as CanvasEdge
  }

  private move(op: Loose) {
    const ids = this.ids(op, 'ids')
    const dx = need('dx', num(op, 'dx'))
    const dy = need('dy', num(op, 'dy'))
    const moved = new Set<string>()
    ids.forEach((id, k) => {
      this.nodeIndex(`ids[${k}]`, id)
      moved.add(id)
    })
    // Add descendants of moved groups (x-parent chains), until no new node joins.
    for (let grew = true; grew; ) {
      grew = false
      for (const n of this.nodes) {
        const p = n['x-parent']
        if (p && moved.has(p) && !moved.has(n.id)) moved.add(n.id), (grew = true)
      }
    }
    this.nodes = this.nodes.map((n) => (moved.has(n.id) ? ({ ...n, x: n.x + dx, y: n.y + dy } as CanvasNode) : n))
    this.edges = this.edges.map((e) =>
      e['x-points'] && moved.has(e.fromNode) && moved.has(e.toNode)
        ? { ...e, 'x-points': e['x-points'].map((p) => ({ x: p.x + dx, y: p.y + dy })) }
        : e,
    )
  }

  private remove(op: Loose) {
    const ids = this.ids(op, 'ids')
    ids.forEach((id, k) => {
      if (!this.exists(id)) fail(`ids[${k}]`, `ids[${k}] "${id}" is not on the board; use an existing node or edge id`)
    })
    const gone = new Set(ids)
    this.nodes = this.nodes
      .filter((n) => !gone.has(n.id))
      .map((n) => {
        if (!n['x-parent'] || !gone.has(n['x-parent'])) return n
        const { 'x-parent': _, ...rest } = n
        return rest as CanvasNode
      })
    this.edges = this.edges.filter((e) => !gone.has(e.id) && !gone.has(e.fromNode) && !gone.has(e.toNode))
  }

  private setLayout(op: Loose) {
    const layout = need('layout', oneOf(op, 'layout', LAYOUTS))
    const group = need('group', str(op, 'group'))
    if (group === 'root') {
      this.root['x-layout'] = layout
      return
    }
    const id = this.groupId('group', group)
    const i = this.nodes.findIndex((n) => n.id === id)
    this.nodes[i] = { ...this.nodes[i], 'x-layout': layout } as CanvasNode
  }

  private reorder(op: Loose) {
    const i = this.nodeIndex('id', need('id', op.id))
    const to = need('to', oneOf(op, 'to', ['front', 'back']))
    // A copy, so the z-order change shows up as "changed" in diffs.
    const [node] = this.nodes.splice(i, 1).map((n) => ({ ...n }) as CanvasNode)
    let lastGroup = -1
    this.nodes.forEach((n, k) => n.type === 'group' && (lastGroup = k))
    // Groups stay before non-groups: groups move within the group block, others within the rest.
    const at = node.type === 'group' ? (to === 'back' ? 0 : lastGroup + 1) : to === 'back' ? lastGroup + 1 : this.nodes.length
    this.nodes.splice(at, 0, node)
  }
}

// ---------------------------------------------------------------- change records

type Change = { added: Set<string>; changed: Set<string>; removed: Set<string> }

/** Items keep identity when untouched, so a reference compare finds every change. */
function diffDocs(a: CanvasDoc, b: CanvasDoc): Change {
  const c: Change = { added: new Set(), changed: new Set(), removed: new Set() }
  for (const key of ['nodes', 'edges'] as const) {
    const before = new Map<string, unknown>(a[key].map((x) => [x.id, x]))
    const after = new Set<string>()
    for (const x of b[key]) {
      after.add(x.id)
      if (!before.has(x.id)) c.added.add(x.id)
      else if (before.get(x.id) !== x) c.changed.add(x.id)
    }
    for (const id of before.keys()) if (!after.has(id)) c.removed.add(id)
  }
  // Top-level fields (e.g. root x-layout) are reported as id "root".
  const keys = new Set([...Object.keys(a), ...Object.keys(b)])
  for (const k of keys) if (k !== 'nodes' && k !== 'edges' && a[k as `x-${string}`] !== b[k as `x-${string}`]) c.changed.add('root')
  return c
}

const allIds = (doc: CanvasDoc) => [...doc.nodes.map((n) => n.id), ...doc.edges.map((e) => e.id)]

// ---------------------------------------------------------------- the board

type UndoEntry = { before: CanvasDoc; after: CanvasDoc }

export class Board implements BoardApi {
  private _doc: CanvasDoc
  private _version = 0
  private undoStack: UndoEntry[] = []
  private redoStack: UndoEntry[] = []
  private changes = new Map<number, Change>() // version -> what that version changed
  private historyStart = 0 // diffSince(v) is exact for v >= historyStart
  private listeners = new Set<(doc: CanvasDoc, version: number) => void>()

  constructor(doc: CanvasDoc = { nodes: [], edges: [] }) {
    this._doc = doc
  }

  get doc() {
    return this._doc
  }
  get version() {
    return this._version
  }

  apply(ops: Op[], opts: ApplyOptions): ApplyResult {
    if (opts.baseVersion !== undefined && opts.baseVersion !== this._version) {
      return {
        ok: false,
        version: this._version,
        error: {
          stale: true,
          message: `baseVersion ${opts.baseVersion} is stale; the board is at version ${this._version}. Read the diff, then retry with baseVersion ${this._version}`,
          diff: this.diffSince(opts.baseVersion),
        },
      }
    }
    if (!Array.isArray(ops)) return { ok: false, version: this._version, error: { opIndex: -1, field: 'ops', message: 'ops must be an array of op objects' } }
    if (ops.length === 0) return { ok: true, version: this._version, ids: {} }

    const draft = new Draft(this._doc, opts.by)
    for (let i = 0; i < ops.length; i++) {
      try {
        draft.apply(ops[i])
      } catch (e) {
        if (!(e instanceof InvalidOp)) throw e
        const error = e.field === undefined ? { opIndex: i, message: e.message } : { opIndex: i, field: e.field, message: e.message }
        return { ok: false, version: this._version, error }
      }
    }
    const next = draft.toDoc()
    const top = this.undoStack.at(-1)
    if (opts.mergeWithPrevious && top && top.after === this._doc) top.after = next
    else {
      this.undoStack.push({ before: this._doc, after: next })
      if (this.undoStack.length > HISTORY_LIMIT) this.undoStack.shift()
    }
    this.redoStack = []
    this.commit(next)
    return { ok: true, version: this._version, ids: Object.fromEntries(draft.refs) }
  }

  undo(): boolean {
    const entry = this.undoStack.pop()
    if (!entry) return false
    this.redoStack.push(entry)
    this.commit(entry.before)
    return true
  }

  redo(): boolean {
    const entry = this.redoStack.pop()
    if (!entry) return false
    this.undoStack.push(entry)
    this.commit(entry.after)
    return true
  }

  canUndo() {
    return this.undoStack.length > 0
  }
  canRedo() {
    return this.redoStack.length > 0
  }

  diffSince(version: number): BoardDiff {
    const diff: BoardDiff = { from: version, to: this._version, added: [], changed: [], removed: [] }
    if (Number.isInteger(version) && version >= this._version) return diff
    if (!Number.isInteger(version) || version < this.historyStart) {
      diff.changed = allIds(this._doc) // too old: treat everything as changed
      return diff
    }
    // Net effect per id: did it exist at `version`, and does it exist now?
    const state = new Map<string, { existedBefore: boolean; existsNow: boolean }>()
    for (let v = version + 1; v <= this._version; v++) {
      const c = this.changes.get(v)!
      for (const [set, existsNow] of [[c.added, true], [c.changed, true], [c.removed, false]] as const) {
        for (const id of set) {
          const s = state.get(id)
          if (s) s.existsNow = existsNow
          else state.set(id, { existedBefore: set !== c.added, existsNow })
        }
      }
    }
    for (const [id, s] of state) {
      if (!s.existedBefore && s.existsNow) diff.added.push(id)
      else if (s.existedBefore && s.existsNow) diff.changed.push(id)
      else if (s.existedBefore) diff.removed.push(id)
    }
    return diff
  }

  subscribe(fn: (doc: CanvasDoc, version: number) => void): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  toJSON(): string {
    return JSON.stringify(this._doc, null, 2)
  }

  private commit(next: CanvasDoc) {
    const change = diffDocs(this._doc, next)
    this._doc = next
    this._version += 1
    this.changes.set(this._version, change)
    const oldest = this._version - HISTORY_LIMIT
    if (oldest > this.historyStart) {
      this.changes.delete(oldest)
      this.historyStart = oldest
    }
    for (const fn of this.listeners) fn(next, this._version)
  }
}

export function createBoard(doc?: CanvasDoc): Board {
  return new Board(doc)
}

const NODE_TYPES = ['text', 'file', 'link', 'group']

/** Parses JSON Canvas text. Keeps every unknown field. Throws Error with a precise message. */
export function fromJSON(text: string): Board {
  const doc = JSON.parse(text) as Loose
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) throw new Error('canvas must be a JSON object')
  for (const key of ['nodes', 'edges']) {
    if (doc[key] === undefined) doc[key] = []
    else if (!Array.isArray(doc[key])) throw new Error(`canvas "${key}" must be an array`)
  }
  const seen = new Set<string>()
  const checkId = (where: string, id: unknown) => {
    if (typeof id !== 'string' || id === '') throw new Error(`${where}.id must be a non-empty string`)
    if (seen.has(id)) throw new Error(`${where}.id "${id}" is a duplicate; ids must be unique`)
    seen.add(id)
  }
  ;(doc.nodes as Loose[]).forEach((n, i) => {
    const where = `nodes[${i}]`
    if (!n || typeof n !== 'object') throw new Error(`${where} must be an object`)
    checkId(where, n.id)
    if (!NODE_TYPES.includes(n.type as string)) throw new Error(`${where}.type ${show(n.type)} is not valid; use one of ${list(NODE_TYPES)}`)
    for (const f of ['x', 'y', 'width', 'height'])
      if (typeof n[f] !== 'number' || !Number.isFinite(n[f])) throw new Error(`${where}.${f} must be a finite number`)
  })
  ;(doc.edges as Loose[]).forEach((e, i) => {
    const where = `edges[${i}]`
    if (!e || typeof e !== 'object') throw new Error(`${where} must be an object`)
    checkId(where, e.id)
    for (const f of ['fromNode', 'toNode']) if (typeof e[f] !== 'string') throw new Error(`${where}.${f} must be a string`)
  })
  return new Board(doc as CanvasDoc)
}
