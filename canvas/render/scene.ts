// Pure scene queries: derived geometry, hit testing, marquee, culling, move/resize math.
import { boundsOf, contains, edgePath, facingSide, intersects, nodeById, pointAt } from '../core/geometry'
import type { CanvasDoc, CanvasEdge, CanvasNode, Point, Rect, Side } from '../core/model'

/** `labelGroup`: innermost group under the label centre, so the label background can match its fill. */
export type EdgeGeom = { edge: CanvasEdge; path: Point[]; bounds: Rect; ends: [CanvasNode, CanvasNode]; labelGroup?: CanvasNode }
export type Scene = { doc: CanvasDoc; byId: Map<string, CanvasNode>; edges: EdgeGeom[] }

/**
 * Derived data for one doc version. Build once per doc (memoise by identity). Pass the previous
 * scene so edges whose edge and end nodes kept identity keep their EdgeGeom (memoised views skip).
 */
export function buildScene(doc: CanvasDoc, prev?: Scene): Scene {
  const byId = nodeById(doc)
  const old = new Map(prev?.edges.map((e) => [e.edge.id, e]))
  // Ports are spread along a side by every edge on it (core portT), so when one edge at a node
  // changes, the other edges at that node may move too: recompute every edge touching such a node.
  const dirty = new Set<string>()
  const live = new Set<string>()
  for (const edge of doc.edges) {
    live.add(edge.id)
    const o = old.get(edge.id)
    if (!o || o.edge !== edge || o.ends[0] !== byId.get(edge.fromNode) || o.ends[1] !== byId.get(edge.toNode)) dirty.add(edge.fromNode).add(edge.toNode)
  }
  for (const o of prev?.edges ?? []) if (!live.has(o.edge.id)) dirty.add(o.edge.fromNode).add(o.edge.toNode)
  const edges: EdgeGeom[] = []
  for (const edge of doc.edges) {
    const a = byId.get(edge.fromNode)
    const b = byId.get(edge.toNode)
    if (!a || !b) continue
    const o = old.get(edge.id)
    const same = o && !dirty.has(a.id) && !dirty.has(b.id)
    let path = same ? o.path : edgePath(doc, edge, byId)!
    // Elbow edge the layout has not routed yet: orthogonal fallback between the same core ports.
    if (!same && edge['x-route'] === 'elbow' && !edge['x-points']?.length) {
      path = elbowPath(path[0], edge.fromSide ?? facingSide(a, b), path[path.length - 1], edge.toSide ?? facingSide(b, a))
    }
    if (o && !same && samePath(o.path, path)) path = o.path
    const labelGroup = edge.label ? groupAt(doc, pointAt(path, 0.5)) : undefined
    if (o && o.edge === edge && o.path === path && o.labelGroup === labelGroup) edges.push(o)
    else edges.push({ edge, path, ends: [a, b], labelGroup, bounds: o?.path === path ? o.bounds : boundsOf(path.map((p) => ({ ...p, width: 0, height: 0 })))! })
  }
  return { doc, byId, edges }
}

const samePath = (p: Point[], q: Point[]) => p.length === q.length && p.every((a, i) => a.x === q[i].x && a.y === q[i].y)

const horizontal = (s: Side) => s === 'left' || s === 'right'

/**
 * Orthogonal fallback for an elbow edge that has no x-points yet: horizontal-vertical-horizontal
 * between side midpoints (or vertical-horizontal-vertical for top/bottom sides; one bend if mixed).
 */
export function elbowPath(start: Point, fromSide: Side, end: Point, toSide: Side): Point[] {
  if (start.x === end.x || start.y === end.y) return [start, end]
  const h1 = horizontal(fromSide)
  const h2 = horizontal(toSide)
  if (h1 && h2) {
    const mx = (start.x + end.x) / 2
    return [start, { x: mx, y: start.y }, { x: mx, y: end.y }, end]
  }
  if (!h1 && !h2) {
    const my = (start.y + end.y) / 2
    return [start, { x: start.x, y: my }, { x: end.x, y: my }, end]
  }
  return [start, h1 ? { x: end.x, y: start.y } : { x: start.x, y: end.y }, end]
}

/** Innermost (smallest) group containing point `p`, skipping ids in `exclude`. */
export function groupAt(doc: CanvasDoc, p: Point, exclude?: Set<string>): CanvasNode | undefined {
  let best: CanvasNode | undefined
  for (const n of doc.nodes) {
    if (n.type !== 'group' || exclude?.has(n.id) || !inRect(p, n)) continue
    if (!best || n.width * n.height < best.width * best.height) best = n
  }
  return best
}

// ---------------------------------------------------------------- hit testing

function distToSegment(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const len2 = dx * dx + dy * dy
  const t = len2 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2)) : 0
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy))
}

const inRect = (p: Point, r: Rect) => p.x >= r.x && p.x <= r.x + r.width && p.y >= r.y && p.y <= r.y + r.height

/**
 * Topmost item at world point `p`. Order: non-group nodes (top of z-order first), then edges
 * (within `tolerance` world px), then groups. So a node inside a group wins over the group.
 */
export function hitTest(scene: Scene, p: Point, tolerance = 4): string | undefined {
  const nodes = scene.doc.nodes
  for (let i = nodes.length - 1; i >= 0; i--) if (nodes[i].type !== 'group' && inRect(p, nodes[i])) return nodes[i].id
  for (let i = scene.edges.length - 1; i >= 0; i--) {
    const { edge, path, bounds } = scene.edges[i]
    if (!intersects(bounds, { ...p, width: 0, height: 0 }, tolerance)) continue
    for (let k = 1; k < path.length; k++) if (distToSegment(p, path[k - 1], path[k]) <= tolerance) return edge.id
  }
  for (let i = nodes.length - 1; i >= 0; i--) if (nodes[i].type === 'group' && inRect(p, nodes[i])) return nodes[i].id
  return undefined
}

/** Nodes fully inside the marquee rect. */
export function marqueeSelect(doc: CanvasDoc, r: Rect): string[] {
  return doc.nodes.filter((n) => contains(r, n)).map((n) => n.id)
}

export function normRect(a: Point, b: Point): Rect {
  return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), width: Math.abs(a.x - b.x), height: Math.abs(a.y - b.y) }
}

// ---------------------------------------------------------------- culling

/** Nodes and edges whose bounds intersect the viewport (+ margin in world px). Keeps z-order. */
export function cull(scene: Scene, view: Rect, margin = 200): { nodes: CanvasNode[]; edges: EdgeGeom[] } {
  return {
    nodes: scene.doc.nodes.filter((n) => intersects(n, view, margin)),
    edges: scene.edges.filter((e) => intersects(e.bounds, view, margin + 40)), // +40: labels hang off the path
  }
}

// ---------------------------------------------------------------- move

const ancestors = (byId: Map<string, CanvasNode>, id: string): string[] => {
  const out: string[] = []
  let p = byId.get(id)?.['x-parent']
  while (p && !out.includes(p)) {
    out.push(p)
    p = byId.get(p)?.['x-parent']
  }
  return out
}

/** Selected node ids minus those whose ancestor group is also selected (the store moves children with the group). */
export function moveRoots(byId: Map<string, CanvasNode>, ids: string[]): string[] {
  const set = new Set(ids)
  return ids.filter((id) => byId.has(id) && !ancestors(byId, id).some((a) => set.has(a)))
}

/** Every node that moves when `roots` move: the roots plus all group descendants. */
export function movingSet(doc: CanvasDoc, roots: string[]): Set<string> {
  const set = new Set(roots)
  let grew = true
  while (grew) {
    grew = false
    for (const n of doc.nodes) {
      const p = n['x-parent']
      if (p && set.has(p) && !set.has(n.id)) {
        set.add(n.id)
        grew = true
      }
    }
  }
  return set
}

/** New doc with preview changes; untouched nodes keep identity. */
export function previewDoc(doc: CanvasDoc, moved: Set<string>, dx: number, dy: number, resized?: { id: string; rect: Rect }): CanvasDoc {
  if (!moved.size && !resized) return doc
  return {
    ...doc,
    nodes: doc.nodes.map((n) => {
      if (resized && n.id === resized.id) return { ...n, ...resized.rect }
      return moved.has(n.id) ? { ...n, x: n.x + dx, y: n.y + dy } : n
    }),
  }
}

// ---------------------------------------------------------------- resize

export type Handle = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w'
export const HANDLES: Handle[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w']
export const MIN_SIZE = { width: 40, height: 24 }

/** Handle centre on a rect. */
export function handlePoint(r: Rect, h: Handle): Point {
  const x = h.includes('w') ? r.x : h.includes('e') ? r.x + r.width : r.x + r.width / 2
  const y = h.includes('n') ? r.y : h.includes('s') ? r.y + r.height : r.y + r.height / 2
  return { x, y }
}

/** Resize `r` by dragging handle `h` by (dx, dy) world px. The opposite edge/corner stays fixed. */
export function resizeRect(r: Rect, h: Handle, dx: number, dy: number, keepRatio = false, min = MIN_SIZE): Rect {
  let left = r.x
  let top = r.y
  let right = r.x + r.width
  let bottom = r.y + r.height
  if (h.includes('w')) left = Math.min(left + dx, right - min.width)
  if (h.includes('e')) right = Math.max(right + dx, left + min.width)
  if (h.includes('n')) top = Math.min(top + dy, bottom - min.height)
  if (h.includes('s')) bottom = Math.max(bottom + dy, top + min.height)
  let width = right - left
  let height = bottom - top
  if (keepRatio && r.width > 0 && r.height > 0) {
    const ratio = r.width / r.height
    const horizontal = h === 'e' || h === 'w'
    const vertical = h === 'n' || h === 's'
    // corners follow the larger relative change; sides drive the other axis
    if (horizontal || (!vertical && width / r.width >= height / r.height)) height = width / ratio
    else width = height * ratio
    if (width < min.width) [width, height] = [min.width, min.width / ratio]
    if (height < min.height) [width, height] = [min.height * ratio, min.height]
    if (h.includes('w')) left = right - width
    else if (vertical) left = r.x + (r.width - width) / 2
    if (h.includes('n')) top = bottom - height
    else if (horizontal) top = r.y + (r.height - height) / 2
  }
  return { x: Math.round(left), y: Math.round(top), width: Math.round(width), height: Math.round(height) }
}

export const docBounds = (doc: CanvasDoc, ids?: string[]): Rect | undefined => {
  const set = ids && new Set(ids)
  return boundsOf(doc.nodes.filter((n) => !set || set.has(n.id)))
}
