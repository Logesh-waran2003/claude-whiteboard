// M6. Diagram quality scorer. Pure: same doc + same measure = same report.
import type { CanvasDoc, CanvasEdge, GroupNode, Measure, Point, QualityReport, Rect } from '../core/model'
import { TYPE } from '../core/model'
import { boundsOf, contains, edgeLabelBox, edgePath, intersects, nodeById, segmentHitsRect, segmentsCross } from '../core/geometry'

/**
 * score = round(max(0, 100 − 15·overlaps − 10·wraps − 8·edgeThroughNode − 10·outsideGroup − 30·crossings/max(edges, 10)
 *                  − 10·edgeOverlap − 10·labelOnBorder − 10·edgeOnBorder − 5·stubs))
 * overlaps, wraps, edgeThroughNode, outsideGroup, edgeOverlap, labelOnBorder, edgeOnBorder, stubs: list lengths.
 * edgeThroughNode also holds a group's title text box (+8px margin), as "<groupId>#label".
 * crossings: count, scaled by edge count so big boards are not punished for unavoidable crossings
 * (≤10 edges: 3 points each).
 */

export type DetailedReport = QualityReport & {
  /** Edge pairs whose axis-aligned segments run together for more than 8px. Shared-node ends within 12px are ignored. */
  edgeOverlap: [string, string][]
  /** Edge label boxes and nodes that cross a group border (intersect the group, not contained). Deduplicated ids. */
  labelOnBorder: string[]
  /** Edges routed with elbows or x-points that have a segment which is neither horizontal nor vertical. */
  stubs: string[]
  /** Edges with an axis-aligned segment within 6px of, and parallel to, a group border for more than 24px. */
  edgeOnBorder: string[]
}

type TextBox = { id: string; rect: Rect }
type Seg = { a: Point; b: Point }
type Axis = 'h' | 'v'

/** Text boxes overlap only when both axes overlap by more than this many px. */
const MIN_OVERLAP = 2
/** Shared-end crossings within this distance of the shared node are not counted. */
const SHARED_END_TOL = 1
/** Segments on the same axis count as collinear within this distance. */
const COLLINEAR_TOL = 3
/** Overlap of two edges at a shared node is ignored within this distance of that node. */
const SHARED_NODE_CLEAR = 12
const MIN_SHARED_RUN = 8
const BORDER_TOL = 6
const MIN_BORDER_RUN = 24
const AXIS_TOL = 0.5
/** A segment is a stub when both its dx and dy exceed this many px. */
const STUB_TOL = 1

/** Group label: 4px inside the top-left corner, width = measured text + 8, height = TYPE.groupLabelHeight. */
function groupLabelRect(g: GroupNode, label: string, measure: Measure): Rect {
  return {
    x: g.x + 4,
    y: g.y + 4,
    width: measure(label, { fontSize: TYPE.groupLabelFontSize }).width + 8,
    height: TYPE.groupLabelHeight,
  }
}

function overlapsDeep(a: Rect, b: Rect): boolean {
  if (!intersects(a, b)) return false
  const ox = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)
  const oy = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y)
  return ox > MIN_OVERLAP && oy > MIN_OVERLAP
}

/** Point where two crossing segments meet (caller guarantees they cross). */
function crossPoint(p1: Point, p2: Point, p3: Point, p4: Point): Point {
  const denom = (p2.x - p1.x) * (p4.y - p3.y) - (p2.y - p1.y) * (p4.x - p3.x)
  const t = ((p3.x - p1.x) * (p4.y - p3.y) - (p3.y - p1.y) * (p4.x - p3.x)) / denom
  return { x: p1.x + t * (p2.x - p1.x), y: p1.y + t * (p2.y - p1.y) }
}

/** Path points of `e` that sit on node `nodeId` (its shared end). */
function endsAt(e: CanvasEdge, path: Point[], nodeId: string): Point[] {
  const out: Point[] = []
  if (e.fromNode === nodeId) out.push(path[0])
  if (e.toNode === nodeId) out.push(path[path.length - 1])
  return out
}

function sharedEndsOf(a: CanvasEdge, pa: Point[], b: CanvasEdge, pb: Point[]): Point[] {
  return [a.fromNode, a.toNode]
    .filter((id) => id === b.fromNode || id === b.toNode)
    .flatMap((id) => [...endsAt(a, pa, id), ...endsAt(b, pb, id)])
}

function edgesCross(a: CanvasEdge, pa: Point[], b: CanvasEdge, pb: Point[]): boolean {
  const sharedEnds = sharedEndsOf(a, pa, b, pb)
  for (let i = 1; i < pa.length; i++) {
    for (let j = 1; j < pb.length; j++) {
      const p1 = pa[i - 1], p2 = pa[i], p3 = pb[j - 1], p4 = pb[j]
      if (!segmentsCross(p1, p2, p3, p4)) continue
      const hit = crossPoint(p1, p2, p3, p4)
      const atSharedEnd = sharedEnds.some((e) => Math.hypot(e.x - hit.x, e.y - hit.y) <= SHARED_END_TOL)
      if (!atSharedEnd) return true
    }
  }
  return false
}

const segmentsOf = (path: Point[]): Seg[] => path.slice(1).map((b, i) => ({ a: path[i], b }))

function axisOf(s: Seg): Axis | undefined {
  if (Math.abs(s.a.y - s.b.y) < AXIS_TOL) return 'h'
  if (Math.abs(s.a.x - s.b.x) < AXIS_TOL) return 'v'
  return undefined
}

/** Span [min, max] of a segment along its axis, and its fixed coordinate across that axis. */
function spanOf(s: Seg, axis: Axis): { lo: number; hi: number; at: number } {
  return axis === 'h'
    ? { lo: Math.min(s.a.x, s.b.x), hi: Math.max(s.a.x, s.b.x), at: s.a.y }
    : { lo: Math.min(s.a.y, s.b.y), hi: Math.max(s.a.y, s.b.y), at: s.a.x }
}

/** Length of [lo, hi] not covered by any cut interval. */
function uncoveredLength(lo: number, hi: number, cuts: [number, number][]): number {
  const clipped = cuts
    .map(([a, b]): [number, number] => [Math.max(lo, a), Math.min(hi, b)])
    .filter(([a, b]) => b > a)
    .sort((x, y) => x[0] - y[0])
  let covered = 0
  let end = -Infinity
  for (const [a, b] of clipped) {
    const start = Math.max(a, end)
    if (b > start) {
      covered += b - start
      end = b
    }
  }
  return hi - lo - covered
}

function edgesOverlap(a: CanvasEdge, pa: Point[], b: CanvasEdge, pb: Point[]): boolean {
  const sharedEnds = sharedEndsOf(a, pa, b, pb)
  for (const s1 of segmentsOf(pa)) {
    const axis = axisOf(s1)
    if (!axis) continue
    const u = spanOf(s1, axis)
    for (const s2 of segmentsOf(pb)) {
      if (axisOf(s2) !== axis) continue
      const v = spanOf(s2, axis)
      if (Math.abs(u.at - v.at) > COLLINEAR_TOL) continue
      const lo = Math.max(u.lo, v.lo)
      const hi = Math.min(u.hi, v.hi)
      if (hi <= lo) continue
      const cuts = sharedEnds.map((p): [number, number] => {
        const c = axis === 'h' ? p.x : p.y
        return [c - SHARED_NODE_CLEAR, c + SHARED_NODE_CLEAR]
      })
      if (uncoveredLength(lo, hi, cuts) > MIN_SHARED_RUN) return true
    }
  }
  return false
}

/** Four border segments of a group, as axis + fixed coordinate + span. */
function borderSides(g: GroupNode): { axis: Axis; at: number; lo: number; hi: number }[] {
  return [
    { axis: 'h', at: g.y, lo: g.x, hi: g.x + g.width },
    { axis: 'h', at: g.y + g.height, lo: g.x, hi: g.x + g.width },
    { axis: 'v', at: g.x, lo: g.y, hi: g.y + g.height },
    { axis: 'v', at: g.x + g.width, lo: g.y, hi: g.y + g.height },
  ]
}

export function scoreDetailed(doc: CanvasDoc, measure: Measure): DetailedReport {
  const byId = nodeById(doc)

  // Text boxes: non-group nodes, group labels, edge labels.
  const textBoxes: TextBox[] = []
  for (const n of doc.nodes) {
    if (n.type !== 'group') textBoxes.push({ id: n.id, rect: n })
    else if (n.label) textBoxes.push({ id: `${n.id}#label`, rect: groupLabelRect(n, n.label, measure) })
  }

  const paths = new Map<string, Point[]>()
  const wraps: string[] = []
  const edgeLabels: TextBox[] = []
  for (const e of doc.edges) {
    const path = edgePath(doc, e, byId)
    if (!path) continue
    paths.set(e.id, path)
    if (!e.label) continue
    const { box, wrapped } = edgeLabelBox(path, e.label, measure)
    edgeLabels.push({ id: e.id, rect: box })
    if (wrapped) wraps.push(e.id)
  }
  textBoxes.push(...edgeLabels)

  const overlaps: [string, string][] = []
  for (let i = 0; i < textBoxes.length; i++) {
    for (let j = i + 1; j < textBoxes.length; j++) {
      if (overlapsDeep(textBoxes[i].rect, textBoxes[j].rect)) overlaps.push([textBoxes[i].id, textBoxes[j].id])
    }
  }

  const groups = doc.nodes.filter((n): n is GroupNode => n.type === 'group')

  // Groups are skipped as node obstacles, so the ancestor-group rule holds without a check.
  const edgeThroughNode: [string, string][] = []
  for (const e of doc.edges) {
    const path = paths.get(e.id)
    if (!path) continue
    for (const n of doc.nodes) {
      if (n.type === 'group' || n.id === e.fromNode || n.id === e.toNode) continue
      if (segmentsOf(path).some((s) => segmentHitsRect(s.a, s.b, n))) edgeThroughNode.push([e.id, n.id])
    }
    // A group's title TEXT (+8px left/right, +4px top/bottom) is an obstacle; the rest of the top band is free, so edges may enter a group
    // from above. Exceptions: edges that end at the group or join two of its children.
    for (const g of groups) {
      if (!g.label || g.id === e.fromNode || g.id === e.toNode) continue
      if (byId.get(e.fromNode)?.['x-parent'] === g.id && byId.get(e.toNode)?.['x-parent'] === g.id) continue
      const t = groupLabelRect(g, g.label, measure)
      const strip: Rect = { x: t.x - 8, y: t.y - 4, width: t.width + 16, height: t.height + 8 }
      if (segmentsOf(path).some((s) => segmentHitsRect(s.a, s.b, strip))) edgeThroughNode.push([e.id, `${g.id}#label`])
    }
  }

  // A child whose parent id is missing is not counted: it is a broken reference, not a containment defect.
  const outsideGroup = doc.nodes
    .filter((n) => {
      const parent = n['x-parent'] ? byId.get(n['x-parent']) : undefined
      return parent !== undefined && !contains(parent, n)
    })
    .map((n) => n.id)

  const routed = doc.edges.filter((e) => paths.has(e.id))
  let crossings = 0
  const edgeOverlap: [string, string][] = []
  for (let i = 0; i < routed.length; i++) {
    for (let j = i + 1; j < routed.length; j++) {
      const pa = paths.get(routed[i].id)!
      const pb = paths.get(routed[j].id)!
      if (edgesCross(routed[i], pa, routed[j], pb)) crossings++
      if (edgesOverlap(routed[i], pa, routed[j], pb)) edgeOverlap.push([routed[i].id, routed[j].id])
    }
  }

  // A label, or a node in another group, that crosses a group border. Contained items never reach this check.
  // A node crossing its own x-parent border is left to outsideGroup, so it is penalised once.
  const borderItems: TextBox[] = [...doc.nodes.map((n) => ({ id: n.id, rect: n })), ...edgeLabels]
  // True when `id` is nested (at any depth) in group `ancestor`: an outer group always overlaps its inner groups.
  const inside = (id: string, ancestor: string) => {
    for (let p = byId.get(id)?.['x-parent'], seen = 0; p && seen < 64; p = byId.get(p)?.['x-parent'], seen++) if (p === ancestor) return true
    return false
  }
  const labelOnBorder = new Set<string>()
  for (const g of groups) {
    for (const item of borderItems) {
      if (item.id === g.id || byId.get(item.id)?.['x-parent'] === g.id || inside(g.id, item.id)) continue
      if (intersects(item.rect, g) && !contains(g, item.rect)) labelOnBorder.add(item.id)
    }
  }

  const edgeOnBorder = new Set<string>()
  for (const g of groups) {
    for (const e of routed) {
      for (const s of segmentsOf(paths.get(e.id)!)) {
        const axis = axisOf(s)
        if (!axis) continue
        const span = spanOf(s, axis)
        for (const side of borderSides(g)) {
          if (side.axis !== axis || Math.abs(span.at - side.at) > BORDER_TOL) continue
          if (Math.min(span.hi, side.hi) - Math.max(span.lo, side.lo) > MIN_BORDER_RUN) edgeOnBorder.add(e.id)
        }
      }
    }
  }

  // Stubs: a routed edge (elbow or x-points) with a segment that is neither horizontal nor vertical.
  const stubs = routed
    .filter((e) => e['x-route'] === 'elbow' || (e['x-points']?.length ?? 0) > 0)
    .filter((e) => segmentsOf(paths.get(e.id)!).some((s) => Math.abs(s.a.x - s.b.x) > STUB_TOL && Math.abs(s.a.y - s.b.y) > STUB_TOL))
    .map((e) => e.id)

  const bounds = boundsOf(doc.nodes)
  const area = bounds ? bounds.width * bounds.height : 0

  const value =
    100 -
    15 * overlaps.length -
    10 * wraps.length -
    8 * edgeThroughNode.length -
    10 * outsideGroup.length -
    (30 * crossings) / Math.max(routed.length, 10) -
    10 * edgeOverlap.length -
    10 * labelOnBorder.size -
    10 * edgeOnBorder.size -
    5 * stubs.length

  return {
    overlaps,
    wraps,
    edgeThroughNode,
    outsideGroup,
    crossings,
    area,
    score: Math.round(Math.max(0, value)),
    edgeOverlap,
    labelOnBorder: [...labelOnBorder],
    stubs,
    edgeOnBorder: [...edgeOnBorder],
  }
}

export function score(doc: CanvasDoc, measure: Measure): QualityReport {
  return scoreDetailed(doc, measure)
}
