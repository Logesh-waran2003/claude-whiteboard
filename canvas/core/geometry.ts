// CONTRACT (M0). Pure geometry shared by layout, renderer and quality, so all three agree on
// where an edge runs and where its label sits.
import { type CanvasDoc, type CanvasEdge, type CanvasNode, type Measure, type Point, type Rect, type Side, TYPE } from './model'

export const center = (r: Rect): Point => ({ x: r.x + r.width / 2, y: r.y + r.height / 2 })

export function sidePoint(r: Rect, side: Side): Point {
  const c = center(r)
  if (side === 'top') return { x: c.x, y: r.y }
  if (side === 'bottom') return { x: c.x, y: r.y + r.height }
  if (side === 'left') return { x: r.x, y: c.y }
  return { x: r.x + r.width, y: c.y }
}

/** Side of `a` that faces `b` (used when an edge has no fromSide/toSide). */
export function facingSide(a: Rect, b: Rect): Side {
  const ca = center(a)
  const cb = center(b)
  const dx = cb.x - ca.x
  const dy = cb.y - ca.y
  if (Math.abs(dx) * a.height >= Math.abs(dy) * a.width) return dx >= 0 ? 'right' : 'left'
  return dy >= 0 ? 'bottom' : 'top'
}

export const nodeById = (doc: CanvasDoc) => new Map(doc.nodes.map((n) => [n.id, n] as const))

/** Which side of each end an edge uses: explicit side, else the side facing its nearest waypoint / other end. */
function edgeSides(edge: CanvasEdge, a: Rect, b: Rect): { from: Side; to: Side } {
  const pts = edge['x-points'] ?? []
  const firstTarget = pts[0] ? { x: pts[0].x, y: pts[0].y, width: 0, height: 0 } : b
  const lastSource = pts.length ? { x: pts[pts.length - 1].x, y: pts[pts.length - 1].y, width: 0, height: 0 } : a
  return { from: edge.fromSide ?? facingSide(a, firstTarget), to: edge.toSide ?? facingSide(b, lastSource) }
}

/**
 * Port position on a side, 0..1 along it. Edges that share one side of one node are spread evenly
 * ((i+1)/(n+1)), ordered by where their other end sits, so they neither overlap nor cross at the node.
 * One edge on a side = 0.5 (the side midpoint).
 */
function portT(doc: CanvasDoc, byId: Map<string, CanvasNode>, nodeId: string, side: Side, edgeId: string, end: 'from' | 'to'): number {
  const along = side === 'top' || side === 'bottom' ? 'x' : 'y'
  const users: { id: string; key: number }[] = []
  for (const e of doc.edges) {
    if (e.fromNode !== nodeId && e.toNode !== nodeId) continue
    const a = byId.get(e.fromNode)
    const b = byId.get(e.toNode)
    if (!a || !b) continue
    const sides = edgeSides(e, a, b)
    for (const end of ['from', 'to'] as const) {
      if ((end === 'from' ? e.fromNode : e.toNode) !== nodeId || sides[end] !== side) continue
      // Order by the direction the edge leaves in: its first waypoint, else the other node's centre.
      const pts = e['x-points'] ?? []
      const toward = end === 'from' ? (pts[0] ?? center(b)) : (pts[pts.length - 1] ?? center(a))
      users.push({ id: `${e.id}:${end}`, key: toward[along] })
    }
  }
  if (users.length <= 1) return 0.5
  users.sort((p, q) => p.key - q.key || (p.id < q.id ? -1 : 1))
  const i = users.findIndex((u) => u.id === `${edgeId}:${end}`)
  return (Math.max(0, i) + 1) / (users.length + 1)
}

export function portPoint(r: Rect, side: Side, t: number): Point {
  if (side === 'top') return { x: r.x + r.width * t, y: r.y }
  if (side === 'bottom') return { x: r.x + r.width * t, y: r.y + r.height }
  if (side === 'left') return { x: r.x, y: r.y + r.height * t }
  return { x: r.x + r.width, y: r.y + r.height * t }
}

/** Full polyline of an edge: start port, x-points, end port. Undefined if an end is missing. */
export function edgePath(doc: CanvasDoc, edge: CanvasEdge, byId = nodeById(doc)): Point[] | undefined {
  const a = byId.get(edge.fromNode)
  const b = byId.get(edge.toNode)
  if (!a || !b) return undefined
  const sides = edgeSides(edge, a, b)
  const start = portPoint(a, sides.from, portT(doc, byId, a.id, sides.from, edge.id, 'from'))
  const end = portPoint(b, sides.to, portT(doc, byId, b.id, sides.to, edge.id, 'to'))
  return [start, ...(edge['x-points'] ?? []), end]
}

export const pathLength = (p: Point[]) => p.slice(1).reduce((s, q, i) => s + Math.hypot(q.x - p[i].x, q.y - p[i].y), 0)

/** Point at fraction t (0..1) along a polyline. */
export function pointAt(p: Point[], t: number): Point {
  const total = pathLength(p)
  let left = total * t
  for (let i = 1; i < p.length; i++) {
    const seg = Math.hypot(p[i].x - p[i - 1].x, p[i].y - p[i - 1].y)
    if (left <= seg && seg > 0) {
      const k = left / seg
      return { x: p[i - 1].x + (p[i].x - p[i - 1].x) * k, y: p[i - 1].y + (p[i].y - p[i - 1].y) * k }
    }
    left -= seg
  }
  return p[p.length - 1]
}

/**
 * Edge label box: centred at the path midpoint. The label may use at most the path length minus
 * 48px (24px clear at each end) as width; if the one-line text is wider, it wraps (that is a "wrap").
 */
export function edgeLabelBox(path: Point[], label: string, measure: Measure): { box: Rect; wrapped: boolean } {
  const pad = TYPE.labelPadding
  const one = measure(label, { fontSize: TYPE.labelFontSize })
  const room = Math.max(24, pathLength(path) - 48)
  const wrapped = one.width + pad * 2 > room
  const size = wrapped ? measure(label, { fontSize: TYPE.labelFontSize, maxWidth: room - pad * 2 }) : one
  const c = pointAt(path, 0.5)
  const w = size.width + pad * 2
  const h = size.height + pad * 2
  return { box: { x: c.x - w / 2, y: c.y - h / 2, width: w, height: h }, wrapped }
}

export const intersects = (a: Rect, b: Rect, margin = 0) =>
  a.x < b.x + b.width + margin && b.x < a.x + a.width + margin && a.y < b.y + b.height + margin && b.y < a.y + a.height + margin

export const contains = (outer: Rect, inner: Rect) =>
  inner.x >= outer.x && inner.y >= outer.y && inner.x + inner.width <= outer.x + outer.width && inner.y + inner.height <= outer.y + outer.height

export function boundsOf(rects: Rect[]): Rect | undefined {
  if (!rects.length) return undefined
  const x = Math.min(...rects.map((r) => r.x))
  const y = Math.min(...rects.map((r) => r.y))
  const r = Math.max(...rects.map((r) => r.x + r.width))
  const b = Math.max(...rects.map((r) => r.y + r.height))
  return { x, y, width: r - x, height: b - y }
}

/** Do segments p1-p2 and p3-p4 properly cross (shared endpoints do not count)? */
export function segmentsCross(p1: Point, p2: Point, p3: Point, p4: Point): boolean {
  const d = (a: Point, b: Point, c: Point) => (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x)
  const d1 = d(p3, p4, p1)
  const d2 = d(p3, p4, p2)
  const d3 = d(p1, p2, p3)
  const d4 = d(p1, p2, p4)
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))
}

/** Does segment a-b pass through the inside of rect r (shrunk by `inset` so touching the border does not count)? */
export function segmentHitsRect(a: Point, b: Point, r: Rect, inset = 2): boolean {
  const s = { x: r.x + inset, y: r.y + inset, width: r.width - inset * 2, height: r.height - inset * 2 }
  if (s.width <= 0 || s.height <= 0) return false
  const inside = (p: Point) => p.x > s.x && p.x < s.x + s.width && p.y > s.y && p.y < s.y + s.height
  if (inside(a) || inside(b)) return true
  const c = [
    { x: s.x, y: s.y },
    { x: s.x + s.width, y: s.y },
    { x: s.x + s.width, y: s.y + s.height },
    { x: s.x, y: s.y + s.height },
  ]
  return c.some((p, i) => segmentsCross(a, b, p, c[(i + 1) % 4]))
}

/** Text shown inside a node (group label is drawn separately). */
/** A file node that shows an image (rendered as the picture, sized by the user, not by its text). */
export const isImageNode = (n: CanvasNode) => n.type === 'file' && /\.(png|jpe?g|gif|webp|svg)$/i.test(n.file)

export function nodeText(n: CanvasNode): string {
  if (n.type === 'text') return n.text
  if (n.type === 'file') return n.file.split('/').pop() ?? n.file
  if (n.type === 'link') return n.url
  return ''
}
