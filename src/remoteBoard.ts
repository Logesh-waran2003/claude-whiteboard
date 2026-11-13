// Browser replica of the server's board. BoardView renders it and applies user ops to it at once
// (optimistic); every batch also goes to the server, which owns the board and its undo history.
// Server docs win: on each one the replica adopts it and re-applies the batches the server has
// not acknowledged yet.
import { type Board, createBoard } from '../canvas/core/board'
import type { ApplyOptions, ApplyResult, BoardApi, BoardDiff, CanvasDoc, Op } from '../canvas/core/model'

export type DocMsg = { type: 'doc'; doc: CanvasDoc; version: number; by: string; ack?: number; canUndo: boolean; canRedo: boolean; file: string }
type Pending = { seq: number; ops: Op[]; merge: boolean }

/** Gives new nodes/edges their generated id, so the server creates them with the same ids. */
function withIds(ops: Op[], ids: Record<string, string>): Op[] {
  return ops.map((op) => ((op.op === 'add_node' || op.op === 'add_edge') && op.ref && !op.id && ids[op.ref] ? { ...op, id: ids[op.ref] } : op))
}

/** Reuse the old object for every node/edge that did not change, so memoised views skip it. */
function keepIdentity(prev: CanvasDoc, next: CanvasDoc): CanvasDoc {
  const same = <T extends { id: string }>(olds: T[], news: T[]) => {
    const byId = new Map(olds.map((o) => [o.id, o]))
    return news.map((n) => {
      const o = byId.get(n.id)
      return o && JSON.stringify(o) === JSON.stringify(n) ? o : n
    })
  }
  return { ...next, nodes: same(prev.nodes, next.nodes), edges: same(prev.edges, next.edges) }
}

export class RemoteBoard implements BoardApi {
  private local: Board
  private pending: Pending[] = []
  private seq = 0
  private listeners = new Set<(doc: CanvasDoc, version: number) => void>()
  version: number
  file: string
  private undoable: boolean
  private redoable: boolean

  constructor(
    msg: DocMsg,
    private send: (msg: unknown) => void,
  ) {
    this.local = createBoard(msg.doc)
    this.version = msg.version
    this.file = msg.file
    this.undoable = msg.canUndo
    this.redoable = msg.canRedo
  }

  get doc() {
    return this.local.doc
  }

  /** A doc from the server: adopt it, then replay what it has not seen yet. */
  receive(msg: DocMsg) {
    if (msg.by === 'load') this.pending = [] // (re)connected: batches sent on the old socket are gone
    else if (msg.ack !== undefined) this.pending = this.pending.filter((p) => p.seq > msg.ack!)
    this.version = msg.version
    this.file = msg.file
    this.undoable = msg.canUndo
    this.redoable = msg.canRedo
    const next = createBoard(keepIdentity(this.local.doc, msg.doc))
    for (const p of this.pending) next.apply(p.ops, { by: 'user', mergeWithPrevious: p.merge })
    this.local = next
    this.emit()
  }

  apply(ops: Op[], opts: ApplyOptions): ApplyResult {
    const r = this.local.apply(ops, { by: opts.by, mergeWithPrevious: opts.mergeWithPrevious })
    if (!r.ok || ops.length === 0) return r
    const sent = withIds(ops, r.ids)
    const p: Pending = { seq: ++this.seq, ops: sent, merge: !!opts.mergeWithPrevious }
    this.pending.push(p)
    this.undoable = true
    this.redoable = false
    this.send({ type: 'ops', ops: sent, seq: p.seq, merge: p.merge, baseVersion: this.version })
    this.emit()
    return r
  }

  undo() {
    if (!this.undoable) return false
    this.send({ type: 'undo' })
    return true
  }
  redo() {
    if (!this.redoable) return false
    this.send({ type: 'redo' })
    return true
  }
  canUndo() {
    return this.undoable
  }
  canRedo() {
    return this.redoable
  }

  diffSince(version: number): BoardDiff {
    return this.local.diffSince(version)
  }

  subscribe(fn: (doc: CanvasDoc, version: number) => void) {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  toJSON() {
    return this.local.toJSON()
  }

  private emit() {
    for (const fn of this.listeners) fn(this.local.doc, this.version)
  }
}
