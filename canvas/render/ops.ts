// Pure op builders for user edits: create, connect, re-parent, copy/paste.
import { center, facingSide } from '../core/geometry'
import { type CanvasDoc, type CanvasEdge, type CanvasNode, type Op, type Point, type Rect, type Side, TYPE } from '../core/model'
import { MIN_SIZE, groupAt, movingSet, normRect } from './scene'

export type Tool = 'select' | 'rect' | 'ellipse' | 'diamond' | 'sticky' | 'text' | 'group' | 'connector'
export type CreateKind = Exclude<Tool, 'select' | 'connector'>

/** Default size for a click-created shape. Ellipse and diamond get the same 1.4x room layout gives them. */
export const DEFAULT_SIZE: Record<CreateKind, { width: number; height: number }> = {
  rect: TYPE.minNode,
  text: TYPE.minNode,
  ellipse: { width: Math.ceil(TYPE.minNode.width * 1.4), height: Math.ceil(TYPE.minNode.height * 1.4) },
  diamond: { width: Math.ceil(TYPE.minNode.width * 1.4), height: Math.ceil(TYPE.minNode.height * 1.4) },
  sticky: TYPE.sticky,
  group: { width: 400, height: 260 },
}

/** Drags shorter than this (world px, both axes) count as a click. */
const CLICK_DRAG = 6

/** Rect for a new shape: click = default size centred on the point; drag = the dragged box (min 40x24). */
export function createRect(kind: CreateKind, start: Point, end?: Point): Rect {
  if (!end || (Math.abs(end.x - start.x) < CLICK_DRAG && Math.abs(end.y - start.y) < CLICK_DRAG)) {
    const s = DEFAULT_SIZE[kind]
    return { x: Math.round(start.x - s.width / 2), y: Math.round(start.y - s.height / 2), width: s.width, height: s.height }
  }
  const r = normRect(start, end)
  return {
    x: Math.round(r.x),
    y: Math.round(r.y),
    width: Math.round(Math.max(MIN_SIZE.width, r.width)),
    height: Math.round(Math.max(MIN_SIZE.height, r.height)),
  }
}

/** Drop keys whose value is undefined, so the store only sees fields we mean. */
const clean = <T extends object>(o: T): T => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T

/** add_node for a new shape; parent = innermost group under the shape centre. */
export function createOp(doc: CanvasDoc, kind: CreateKind, rect: Rect, ref = 'new'): Op {
  const parent = groupAt(doc, center(rect))?.id
  return clean({ op: 'add_node' as const, ref, kind, ...rect, text: kind === 'group' ? 'Group' : '', parent })
}

/** Edge from `from` to an existing node, or to a new rect created at `point`. */
export function connectOps(doc: CanvasDoc, from: CanvasNode, fromSide: Side | undefined, target: CanvasNode | undefined, point: Point): { ops: Op[]; newNode?: string } {
  if (target) {
    return { ops: [clean({ op: 'add_edge' as const, ref: 'edge', from: from.id, to: target.id, fromSide, toSide: facingSide(target, from) })] }
  }
  const rect = createRect('rect', point)
  const ops: Op[] = [createOp(doc, 'rect', rect, 'to'), clean({ op: 'add_edge' as const, ref: 'edge', from: from.id, to: 'to', fromSide, toSide: facingSide(rect, from) })]
  return { ops, newNode: 'to' }
}

/**
 * After a move, put each moved root into the innermost group under its new centre, or take it out
 * of all groups (parent ""). Only roots whose parent changes get an op.
 */
export function reparentOps(doc: CanvasDoc, roots: string[], dx: number, dy: number): Op[] {
  const moving = movingSet(doc, roots)
  const ops: Op[] = []
  for (const id of roots) {
    const n = doc.nodes.find((m) => m.id === id)
    if (!n) continue
    const c = center(n)
    const target = groupAt(doc, { x: c.x + dx, y: c.y + dy }, moving)?.id ?? ''
    if (target !== (n['x-parent'] ?? '')) ops.push({ op: 'update', id, parent: target })
  }
  return ops
}

// ---------------------------------------------------------------- copy / paste

/** Selected nodes plus descendants of selected groups, and the edges between them. A JSON Canvas doc. */
export function copyPayload(doc: CanvasDoc, ids: string[]): CanvasDoc {
  const set = movingSet(doc, ids.filter((id) => doc.nodes.some((n) => n.id === id)))
  return { nodes: doc.nodes.filter((n) => set.has(n.id)), edges: doc.edges.filter((e) => set.has(e.fromNode) && set.has(e.toNode)) }
}

/** Parse clipboard text as a JSON Canvas doc; undefined when it is not one. */
export function parsePayload(text: string): CanvasDoc | undefined {
  try {
    const d = JSON.parse(text)
    return d && Array.isArray(d.nodes) && d.nodes.length && d.nodes.every((n: CanvasNode) => typeof n?.id === 'string' && typeof n.x === 'number')
      ? { nodes: d.nodes, edges: Array.isArray(d.edges) ? d.edges : [] }
      : undefined
  } catch {
    return undefined
  }
}

const arrowOf = (e: CanvasEdge) => ((e.toEnd ?? 'arrow') === 'none' ? 'none' : e.fromEnd === 'arrow' ? 'both' : 'end')

/**
 * Ops that paste `payload` shifted by `offset`, with new ids via refs ("p:<old id>"). Internal edges
 * and parents point at the new copies; a parent outside the copy is kept if it still exists.
 */
export function pasteOps(payload: CanvasDoc, doc: CanvasDoc, offset: number): { ops: Op[]; refs: string[] } {
  const inCopy = new Set(payload.nodes.map((n) => n.id))
  const onBoard = new Set(doc.nodes.filter((n) => n.type === 'group').map((n) => n.id))
  const ref = (id: string) => `p:${id}`
  const ops: Op[] = []
  const nodes = [...payload.nodes.filter((n) => n.type === 'group'), ...payload.nodes.filter((n) => n.type !== 'group')]
  for (const n of nodes) {
    const p = n['x-parent']
    const parent = p && inCopy.has(p) ? ref(p) : p && onBoard.has(p) ? p : undefined
    const kind = n.type === 'group' ? 'group' : n['x-shape']
    ops.push(
      clean({
        op: 'add_node' as const,
        ref: ref(n.id),
        kind: kind ?? (n.type === 'text' ? 'rect' : undefined),
        text: n.type === 'group' ? n.label : n.type === 'text' ? n.text : undefined,
        file: n.type === 'file' ? n.file : undefined,
        url: n.type === 'link' ? n.url : undefined,
        x: n.x + offset,
        y: n.y + offset,
        width: n.width,
        height: n.height,
        color: n.color,
        role: n['x-role'],
        parent,
        layout: n.type === 'group' ? n['x-layout'] : undefined,
      }),
    )
  }
  const edgeRefs: string[] = []
  for (const e of payload.edges) {
    if (!inCopy.has(e.fromNode) || !inCopy.has(e.toNode)) continue
    const r = ref(e.id)
    edgeRefs.push(r)
    ops.push(
      clean({
        op: 'add_edge' as const,
        ref: r,
        from: ref(e.fromNode),
        to: ref(e.toNode),
        label: e.label,
        fromSide: e.fromSide,
        toSide: e.toSide,
        color: e.color,
        route: e['x-route'],
        arrow: arrowOf(e),
      }),
    )
    const pts = e['x-points']
    if (pts?.length) ops.push({ op: 'update_edge', id: r, points: pts.map((q) => ({ x: q.x + offset, y: q.y + offset })) })
  }
  return { ops, refs: [...nodes.map((n) => ref(n.id)), ...edgeRefs] }
}
