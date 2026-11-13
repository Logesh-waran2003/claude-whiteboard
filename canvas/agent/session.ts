// M5. The agent API: one session per board, used by the MCP server and the in-app server. Pure (no I/O).
// Every write runs: board.apply -> layout -> invariants (one undo step) -> quality score.
import { nodeText } from '../core/geometry'
import type { ApplyFail, BoardApi, BoardDiff, CanvasDoc, CanvasEdge, CanvasNode, LayoutKind, Measure, Op, OpError, QualityReport } from '../core/model'
import { enforceInvariants, layoutBoard } from '../layout/index'
import { score } from '../quality/score'
import { parseMermaid } from './mermaid'
import { toSVG } from './export-svg'

export type Quality = Pick<QualityReport, 'score' | 'overlaps' | 'wraps' | 'edgeThroughNode' | 'outsideGroup' | 'crossings'>

export type WriteOk = { ok: true; version: number; ids: Record<string, string>; edges?: string[]; quality: Quality; tidied: string[]; hint?: string; warnings?: string[] }
export type WriteFail = { ok: false; version: number; error: ApplyFail['error'] | { line: number; message: string }; hint: string }
export type WriteResult = WriteOk | WriteFail

const MAX_DIFF_LINES = 40

const quote = (s: string, max = 40) => {
  const one = s.replace(/\s+/g, ' ').trim()
  return `"${one.length > max ? one.slice(0, max - 1) + '…' : one}"`
}
const kindOf = (n: CanvasNode) => (n.type === 'group' ? 'group' : n.type === 'text' ? (n['x-shape'] ?? 'rect') : n.type)
const textOf = (n: CanvasNode) => (n.type === 'group' ? (n.label ?? '') : nodeText(n))
const edgeLine = (e: CanvasEdge) => `${e.id}: ${e.fromNode} -> ${e.toNode}${e.label ? ' ' + quote(e.label) : ''}`

function nodeLine(n: CanvasNode): string {
  const at = n['x-placed'] === false ? '@unplaced' : `@${Math.round(n.x)},${Math.round(n.y)} ${Math.round(n.width)}x${Math.round(n.height)}`
  const parts = [n.id, `[${kindOf(n)}]`, quote(textOf(n)), at]
  if (n.type === 'group' && n['x-layout']) parts.push(`layout:${n['x-layout']}`)
  if (n['x-parent']) parts.push(`in:${n['x-parent']}`)
  if (n['x-role']) parts.push(`role:${n['x-role']}`)
  parts.push(`by:${n['x-by'] ?? 'unknown'}`)
  if (n['x-pin']) parts.push('pinned')
  return parts.join(' ')
}

/** Compact text an LLM reads cheaply: groups as headers, children indented, then edges. */
export function outline(doc: CanvasDoc, version: number): string {
  const ids = new Set(doc.nodes.map((n) => n.id))
  const kids = new Map<string, CanvasNode[]>()
  for (const n of doc.nodes) {
    const p = n['x-parent'] && ids.has(n['x-parent']) ? n['x-parent'] : 'root'
    kids.set(p, [...(kids.get(p) ?? []), n])
  }
  const out = [`board v${version} layout:${doc['x-layout'] ?? 'free'} nodes:${doc.nodes.length} edges:${doc.edges.length}`]
  const seen = new Set<string>()
  const walk = (id: string, depth: number) => {
    for (const n of kids.get(id) ?? []) {
      if (seen.has(n.id)) continue
      seen.add(n.id)
      out.push('  '.repeat(depth) + nodeLine(n))
      walk(n.id, depth + 1)
    }
  }
  walk('root', 0)
  for (const n of doc.nodes) if (!seen.has(n.id)) out.push(nodeLine(n)) // parent cycles
  if (doc.edges.length) out.push('edges:', ...doc.edges.map((e) => '  ' + edgeLine(e)))
  return out.join('\n')
}

function describeNodeChange(a: CanvasNode, b: CanvasNode, moved: Map<string, string>): string[] {
  const what: string[] = []
  if (textOf(a) !== textOf(b)) what.push(`renamed ${b.id} to ${quote(textOf(b))}`)
  const pa = a['x-parent'] ?? ''
  const pb = b['x-parent'] ?? ''
  if (pa !== pb) what.push(pb ? `put ${b.id} into ${pb}` : `took ${b.id} out of ${pa}`)
  const delta = `${b.x - a.x},${b.y - a.y}`
  // Children that moved with their group are not reported.
  if (delta !== '0,0' && !(pa === pb && pb && moved.get(pb) === delta)) what.push(`moved ${b.id}`)
  if (a.width !== b.width || a.height !== b.height) what.push(`resized ${b.id}`)
  if (!what.length) what.push(`changed ${b.id}`)
  return what
}

/** Readable lines for what changed between two docs, skipping changes made by `self`. */
function describeDiff(before: CanvasDoc, after: CanvasDoc, actorOf: (id: string) => string, self: string): string[] {
  const lines: string[] = []
  const who = (id: string) => actorOf(id)
  const oldN = new Map(before.nodes.map((n) => [n.id, n] as const))
  const newN = new Map(after.nodes.map((n) => [n.id, n] as const))
  const oldE = new Map(before.edges.map((e) => [e.id, e] as const))
  const newE = new Map(after.edges.map((e) => [e.id, e] as const))
  const moved = new Map<string, string>()
  for (const [id, b] of newN) {
    const a = oldN.get(id)
    if (a && a !== b && (a.x !== b.x || a.y !== b.y)) moved.set(id, `${b.x - a.x},${b.y - a.y}`)
  }
  const push = (id: string, text: string) => who(id) !== self && lines.push(`${who(id)} ${text}`)
  for (const [id, b] of newN) {
    const a = oldN.get(id)
    if (!a) push(id, `added ${id} [${kindOf(b)}] ${quote(textOf(b))}${b['x-parent'] ? ' in ' + b['x-parent'] : ''}`)
    else if (a !== b && JSON.stringify(a) !== JSON.stringify(b)) for (const t of describeNodeChange(a, b, moved)) push(id, t)
  }
  for (const [id, a] of oldN) if (!newN.has(id)) push(id, `removed ${id} ${quote(textOf(a))}`)
  for (const [id, e] of newE) {
    const a = oldE.get(id)
    if (!a) push(id, `added ${edgeLine(e)}`)
    else if (a !== e && (a.label ?? '') !== (e.label ?? '')) push(id, `relabelled ${id} to ${quote(e.label ?? '')}`)
    else if (a !== e && (a.fromNode !== e.fromNode || a.toNode !== e.toNode)) push(id, `reconnected ${edgeLine(e)}`)
  }
  for (const id of oldE.keys()) if (!newE.has(id)) push(id, `removed ${id}`)
  if (lines.length > MAX_DIFF_LINES) return [...lines.slice(0, MAX_DIFF_LINES), `… and ${lines.length - MAX_DIFF_LINES} more; read the outline`]
  return lines
}

function failHint(error: WriteFail['error'], version: number): string {
  if ('stale' in error) return `Call read_board to see what changed, then retry with baseVersion ${version}.`
  if ('line' in error) return `Fix Mermaid line ${error.line}, then call draw_mermaid again. Nothing was drawn.`
  const e = error as OpError
  if (/is not a node on the board|is not on the board|is not an edge/.test(e.message))
    return `ops[${e.opIndex}] points at a missing id. Call find or read_board for real ids; a ref works only inside the same batch. Nothing was applied.`
  if (/already exists/.test(e.message)) return `ops[${e.opIndex}]: omit "id" to get a fresh one, or update the existing item. Nothing was applied.`
  return `Fix ops[${e.opIndex}]${e.field ? ` field "${e.field}"` : ''} as the message says, then resend the whole batch. Nothing was applied.`
}

/** One line naming the worst problem and the op that fixes it. Undefined when the score is 100. */
export function qualityHint(q: QualityReport, doc: CanvasDoc): string | undefined {
  if (q.score >= 100) return undefined
  const [a, b] = q.overlaps[0] ?? []
  if (a) {
    const edge = [a, b].find((id) => doc.edges.some((e) => e.id === id))
    if (edge) return `${a} overlaps ${b}: route edge ${edge} around with {"op":"update_edge","id":"${edge}","route":"elbow"}, or merge parallel edges into one label; then layout({"all":true}).`
    const node = [a, b].map((id) => id.replace(/#label$/, '')).find((id) => {
      const n = doc.nodes.find((m) => m.id === id)
      return n && !isUser(n)
    }) ?? a
    return `${a} overlaps ${b}: call layout({"all":true}) or move one with {"op":"move","ids":["${node}"],"dx":0,"dy":120}.`
  }
  if (q.outsideGroup[0]) return `${q.outsideGroup[0]} sticks out of its group: call layout({"scope":"<that group>"}).`
  if (q.wraps[0]) return `Label of ${q.wraps[0]} wraps: shorten it to 1-3 words with {"op":"update_edge","id":"${q.wraps[0]}","label":"..."}.`
  const [e, n] = q.edgeThroughNode[0] ?? []
  if (e) return `Edge ${e} runs through ${n}: try {"op":"update_edge","id":"${e}","route":"elbow"} or layout({"all":true}).`
  if (q.crossings) return `${q.crossings} edge crossing(s): call layout({"all":true}), or regroup nodes so linked ones sit in the same group.`
  return undefined
}

/** No x-by (another editor, e.g. Obsidian) counts as user content. */
const isUser = (x: { 'x-by'?: string }) => !x['x-by'] || x['x-by'] === 'user'

const pickQuality = (q: QualityReport): Quality => ({
  score: q.score,
  overlaps: q.overlaps,
  wraps: q.wraps,
  edgeThroughNode: q.edgeThroughNode,
  outsideGroup: q.outsideGroup,
  crossings: q.crossings,
})

export class AgentSession {
  private board!: BoardApi
  private unsubscribe = () => {}
  /** Added to board.version so versions stay increasing after `load` swaps the board. */
  private offset = 0
  /** Doc each agent saw at its last read_board. */
  private reads = new Map<string, CanvasDoc>()
  /** Last actor per id: "user" | "agent:<name>". Layout during an agent turn counts as that agent. */
  private actors = new Map<string, string>()
  private actor: string | undefined
  /** Agent turns, newest last, for safe undo: undo only when the board is still at that turn's result. */
  private turns: { by: string; after: CanvasDoc; before: CanvasDoc }[] = []

  constructor(
    board: BoardApi,
    readonly measure: Measure,
  ) {
    this.attach(board)
  }

  get version() {
    return this.board.version + this.offset
  }
  get doc() {
    return this.board.doc
  }

  /** Swap in a board loaded from disk (another editor changed the file). Changed items count as "user". */
  load(board: BoardApi) {
    const old = this.board.doc
    const next = board.doc
    const before = new Map<string, string>([...old.nodes, ...old.edges].map((x) => [x.id, JSON.stringify(x)]))
    for (const x of [...next.nodes, ...next.edges]) if (before.get(x.id) !== JSON.stringify(x)) this.actors.set(x.id, 'user')
    for (const id of before.keys()) if (!next.nodes.some((n) => n.id === id) && !next.edges.some((e) => e.id === id)) this.actors.set(id, 'user')
    const v = this.version
    this.unsubscribe()
    this.attach(board)
    this.offset = v + 1 - board.version
    this.turns = []
  }

  private attach(board: BoardApi) {
    this.board = board
    this.unsubscribe = board.subscribe((_doc, version) => {
      const d = board.diffSince(version - 1)
      for (const id of [...d.added, ...d.changed, ...d.removed]) this.actors.set(id, this.actor ?? 'user')
    })
  }

  private actorOf = (id: string) => this.actors.get(id) ?? 'user'

  readBoard({ agent, detail = 'outline' }: { agent: string; detail?: 'outline' | 'full' }) {
    const doc = this.board.doc
    const last = this.reads.get(agent)
    const diff = last ? describeDiff(last, doc, this.actorOf, `agent:${agent}`) : []
    this.reads.set(agent, doc)
    return { version: this.version, outline: outline(doc, this.version), diff, ...(detail === 'full' ? { doc } : {}) }
  }

  apply({ agent, ops, baseVersion }: { agent: string; ops: Op[]; baseVersion?: number }): WriteResult {
    return this.turn(agent, () => {
      if (baseVersion !== undefined && baseVersion !== this.version) {
        const d = this.board.diffSince(baseVersion - this.offset)
        const diff: BoardDiff = { ...d, from: baseVersion, to: this.version }
        const error = { stale: true as const, message: `baseVersion ${baseVersion} is stale; the board is at version ${this.version}`, diff }
        return { ok: false, version: this.version, error, hint: failHint(error, this.version) }
      }
      const r = this.board.apply(ops, { by: `agent:${agent}` })
      if (!r.ok) return { ok: false, version: this.version, error: r.error, hint: failHint(r.error, this.version) }
      return { ...this.tidy({}, ops.length > 0), ids: r.ids }
    })
  }

  fromMermaid({ agent, source, parent, layout }: { agent: string; source: string; parent?: string; layout?: LayoutKind }): WriteResult {
    const doc = this.board.doc
    const parsed = parseMermaid(source, {
      parent,
      layout,
      existingNodes: new Set(doc.nodes.map((n) => n.id)),
      takenIds: new Set([...doc.nodes, ...doc.edges].map((x) => x.id)),
    })
    if (!parsed.ok) {
      const error = { line: parsed.line, message: parsed.message }
      return { ok: false, version: this.version, error, hint: failHint(error, this.version) }
    }
    // Keep an existing root layout unless the caller asked for one: drawing must not rearrange the board.
    const ops = parsed.ops.filter((o) => !(o.op === 'set_layout' && o.group === 'root' && !layout && doc['x-layout'] && doc.nodes.length))
    const r = this.apply({ agent, ops })
    if (!r.ok) return r
    return { ...r, ids: parsed.ids, edges: parsed.edges, ...(parsed.warnings.length ? { warnings: parsed.warnings } : {}) }
  }

  layout({ agent, scope, all }: { agent: string; scope?: string; all?: boolean }): WriteOk {
    return this.turn(agent, () => ({ ...this.tidy({ scope, all }, false), ids: {} }))
  }

  check(): QualityReport & { hint?: string } {
    const q = score(this.board.doc, this.measure)
    const hint = qualityHint(q, this.board.doc)
    return hint ? { ...q, hint } : q
  }

  find({ text, file, role }: { text?: string; file?: string; role?: string }): string[] {
    const doc = this.board.doc
    const t = text?.toLowerCase()
    const out: string[] = []
    for (const n of doc.nodes) {
      if (t !== undefined && !textOf(n).toLowerCase().includes(t)) continue
      if (file !== undefined && !(n.type === 'file' && n.file.includes(file))) continue
      if (role !== undefined && n['x-role'] !== role) continue
      out.push(nodeLine(n))
    }
    if (t !== undefined && file === undefined && role === undefined)
      for (const e of doc.edges) if (e.label?.toLowerCase().includes(t)) out.push(edgeLine(e))
    return out
  }

  /** Undo this agent's last turn, only if nothing changed since (never undoes user work). */
  undo({ agent }: { agent: string }): { ok: boolean; version: number; message: string } {
    const by = `agent:${agent}`
    const last = this.turns.at(-1)
    if (!last || last.by !== by) return { ok: false, version: this.version, message: 'Nothing of yours to undo. Use ops (update/remove) to revert specific items.' }
    if (last.after !== this.board.doc) {
      this.turns = []
      return { ok: false, version: this.version, message: 'The board changed after your last write (by someone else). Use ops to revert specific items.' }
    }
    this.actor = by
    try {
      this.board.undo()
    } finally {
      this.actor = undefined
    }
    this.turns.pop()
    return { ok: true, version: this.version, message: 'Undid your last write (ops + layout).' }
  }

  snapshot({ ids, padding }: { ids?: string[]; padding?: number } = {}): string {
    return toSVG(this.board.doc, this.measure, { ids, padding })
  }

  // ---------------------------------------------------------------- internals

  private turn<T extends WriteResult>(agent: string, fn: () => T): T {
    const by = `agent:${agent}`
    const before = this.board.doc
    this.actor = by
    try {
      const r = fn()
      if (r.ok && this.board.doc !== before) this.turns.push({ by, before, after: this.board.doc })
      return r
    } finally {
      this.actor = undefined
    }
  }

  /** Layout + invariants as part of the current undo step (merge) or a new one. Returns quality and moved ids. */
  private tidy(opts: { scope?: string; all?: boolean }, merge: boolean): Omit<WriteOk, 'ids'> {
    const start = this.board.doc
    const placedBefore = new Set(start.nodes.filter((n) => n['x-placed'] !== false).map((n) => n.id))
    const touched = new Set<string>()
    for (const step of [() => layoutBoard(this.board.doc, this.measure, opts), () => enforceInvariants(this.board.doc, this.measure)]) {
      const ops = step()
      if (!ops.length) continue
      const r = this.board.apply(ops, { by: 'layout', mergeWithPrevious: merge })
      if (!r.ok) throw new Error(`layout engine produced an invalid op: ${JSON.stringify(r.error)}`)
      merge = true
      for (const op of ops) {
        if (op.op === 'update') touched.add(op.id)
        if (op.op === 'move') op.ids.forEach((id) => touched.add(id))
      }
    }
    const end = new Map(this.board.doc.nodes.map((n) => [n.id, n] as const))
    const tidied = [...touched].filter((id) => {
      const a = start.nodes.find((n) => n.id === id)
      const b = end.get(id)
      return a && b && placedBefore.has(id) && (a.x !== b.x || a.y !== b.y || a.width !== b.width || a.height !== b.height)
    })
    const q = score(this.board.doc, this.measure)
    const hint = qualityHint(q, this.board.doc)
    return { ok: true, version: this.version, quality: pickQuality(q), tidied, ...(hint ? { hint } : {}) }
  }
}
