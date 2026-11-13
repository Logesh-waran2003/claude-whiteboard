// M4 layout engine. Pure: doc in, ops out (update / move / update_edge only).
import type { CanvasDoc, CanvasNode, Measure, Op, Point, Rect } from '../core/model'
import { enforce } from './invariants'
import { layoutContainer } from './place'
import { fixRoutes } from './route'
import { sizeFor } from './size'
import { ROOT, type Work, descendants, isFixed, isPlaced, kidsOf, makeWork, moveBy, postOrderGroups, rectOf } from './tree'

/** Size + place unplaced nodes, lay out groups by their x-layout, route edges. Returns ops (update/move/update_edge only). */
export function layoutBoard(doc: CanvasDoc, measure: Measure, opts: { scope?: string; all?: boolean } = {}): Op[] {
  const w = makeWork(doc)
  const all = !!opts.all
  const scope = opts.scope && opts.scope !== ROOT && w.byId.get(opts.scope)?.type === 'group' ? opts.scope : ROOT
  const inScope = new Set(scope === ROOT ? w.doc.nodes.map((n) => n.id) : [scope, ...descendants(w, scope).map((n) => n.id)])
  const changed = new Set<string>()
  for (const n of w.doc.nodes) {
    if (n.type === 'group' || isFixed(n) || !inScope.has(n.id) || (isPlaced(n) && !all)) continue
    Object.assign(n, sizeFor(n, measure))
    changed.add(n.id)
  }
  const containers = postOrderGroups(w, scope)
  if (scope === ROOT) containers.push(ROOT)
  for (const cid of containers) layoutContainer(w, cid, all, changed, measure)
  fixRoutes(w, startRects(doc), true, measure)
  return diffOps(doc, w)
}

/** Repair readability without a full re-layout. Returns ops. */
export function enforceInvariants(doc: CanvasDoc, measure: Measure): Op[] {
  const w = makeWork(doc)
  enforce(w, measure)
  return diffOps(doc, w)
}

/** Convenience: apply ops to a plain doc copy (for tests and for the quality benchmark). Pure. */
export function applyLayoutOps(doc: CanvasDoc, ops: Op[]): CanvasDoc {
  const w = makeWork(doc)
  for (const op of ops) {
    if (op.op === 'update') {
      const n = w.byId.get(op.id)
      if (!n) throw new Error(`applyLayoutOps: unknown node ${op.id}`)
      for (const k of ['x', 'y', 'width', 'height'] as const) if (op[k] !== undefined) n[k] = op[k]!
      if (op.x !== undefined || op.y !== undefined) delete n['x-placed']
    } else if (op.op === 'move') {
      const ids = new Set<string>()
      for (const id of op.ids) for (const m of [w.byId.get(id), ...descendants(w, id)]) if (m) ids.add(m.id)
      for (const id of ids) {
        const m = w.byId.get(id)!
        m.x += op.dx
        m.y += op.dy
      }
    } else if (op.op === 'update_edge') {
      const e = w.doc.edges.find((x) => x.id === op.id)
      if (!e) throw new Error(`applyLayoutOps: unknown edge ${op.id}`)
      if (op.points !== undefined) {
        if (op.points.length) e['x-points'] = op.points
        else delete e['x-points']
      }
      if (op.fromSide !== undefined) e.fromSide = op.fromSide
      if (op.toSide !== undefined) e.toSide = op.toSide
      if (op.route !== undefined) e['x-route'] = op.route
      if (op.label !== undefined) e.label = op.label
    } else throw new Error(`applyLayoutOps: unsupported op ${op.op}`)
  }
  return w.doc
}

const startRects = (doc: CanvasDoc) => new Map<string, Rect>(doc.nodes.map((n) => [n.id, rectOf(n)]))

/**
 * Net ops from `orig` to the work copy. A subtree that only translated becomes one `move`.
 * After an `update` that changes a group's position, its descendants get absolute updates,
 * so the result is right whether or not the board drags children on `update`.
 */
function diffOps(orig: CanvasDoc, w: Work): Op[] {
  const ops: Op[] = []
  const before = new Map(orig.nodes.map((n) => [n.id, n] as const))
  const covered = new Set<string>()
  const forceAbs = new Set<string>()
  const delta = (n: CanvasNode) => {
    const p = before.get(n.id)!
    return { dx: n.x - p.x, dy: n.y - p.y, resized: n.width !== p.width || n.height !== p.height, wasUnplaced: p['x-placed'] === false }
  }
  const visit = (cid: string) => {
    for (const n of kidsOf(w, cid)) {
      // Fixed nodes never change, except fixed groups that grew to hold their children.
      const d = delta(n)
      if (!covered.has(n.id) && (!isFixed(n) || d.dx || d.dy || d.resized)) {
        const touched = d.dx || d.dy || d.resized || d.wasUnplaced || forceAbs.has(n.id)
        if (touched) {
          const desc = descendants(w, n.id)
          const pureMove =
            !d.resized && !d.wasUnplaced && !forceAbs.has(n.id) &&
            desc.every((m) => {
              const dm = delta(m)
              return !isFixed(m) && dm.dx === d.dx && dm.dy === d.dy && !dm.resized && !dm.wasUnplaced
            })
          if (pureMove) {
            ops.push({ op: 'move', ids: [n.id], dx: d.dx, dy: d.dy })
            desc.forEach((m) => covered.add(m.id))
          } else {
            ops.push({ op: 'update', id: n.id, x: n.x, y: n.y, width: n.width, height: n.height })
            if (d.dx || d.dy) desc.forEach((m) => forceAbs.add(m.id))
          }
        }
      }
      visit(n.id)
    }
  }
  visit(ROOT)
  const oldEdges = new Map(orig.edges.map((e) => [e.id, e] as const))
  for (const e of w.doc.edges) {
    const o = oldEdges.get(e.id)!
    const pts = (x: { 'x-points'?: Point[] }) => JSON.stringify(x['x-points'] ?? [])
    if (pts(e) !== pts(o) || e.fromSide !== o.fromSide || e.toSide !== o.toSide)
      ops.push({ op: 'update_edge', id: e.id, points: e['x-points'] ?? [], fromSide: e.fromSide, toSide: e.toSide })
  }
  return ops
}
