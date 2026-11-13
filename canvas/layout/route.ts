// Edge routing: straight when clear, else orthogonal (elbow) waypoints that avoid other nodes.
import { contains, edgeLabelBox, edgePath, facingSide, intersects, pathLength, segmentHitsRect, segmentsCross, sidePoint } from '../core/geometry'
import { type CanvasEdge, type GroupNode, type Measure, type Point, type Rect, type Side, TYPE } from '../core/model'
import { type Work, ancestors, isPlaced, rectOf, splitBoxes } from './tree'

export type Route = { points: Point[]; fromSide?: Side; toSide?: Side }

const SIDES: Side[] = ['right', 'bottom', 'left', 'top']
const NORMAL: Record<Side, Point> = { right: { x: 1, y: 0 }, left: { x: -1, y: 0 }, bottom: { x: 0, y: 1 }, top: { x: 0, y: -1 } }
const STUB = 24
/** Min distance between an edge running parallel to a group border and that border. */
export const BORDER_CLEAR = 20
/** Lane spacing for the 2nd, 3rd... edge between the same two nodes. */
const LANE = 32

export const samePair = (a: CanvasEdge, b: CanvasEdge) =>
  (a.fromNode === b.fromNode && a.toNode === b.toNode) || (a.fromNode === b.toNode && a.toNode === b.fromNode)

/** Parallel lines closer than this read as one line. */
const NEAR = 10

/** Axis-aligned segments of two paths that run together (closer than NEAR) for more than 2px. */
export function sharedRuns(p: Point[], o: Point[], near = NEAR): number {
  let n = 0
  for (let i = 1; i < p.length; i++)
    for (let j = 1; j < o.length; j++) {
      const [a, b, c, d] = [p[i - 1], p[i], o[j - 1], o[j]]
      const run = (u1: number, u2: number, v1: number, v2: number) => Math.min(Math.max(u1, u2), Math.max(v1, v2)) - Math.max(Math.min(u1, u2), Math.min(v1, v2))
      if (a.x === b.x && c.x === d.x && Math.abs(a.x - c.x) < near && run(a.y, b.y, c.y, d.y) > 2) n++
      else if (a.y === b.y && c.y === d.y && Math.abs(a.y - c.y) < near && run(a.x, b.x, c.x, d.x) > 2) n++
    }
  return n
}

/** Axis-aligned segments that run along a group border closer than BORDER_CLEAR. */
export function borderRuns(p: Point[], groups: Rect[], clear = BORDER_CLEAR): number {
  let n = 0
  const run = (u1: number, u2: number, lo: number, hi: number) => Math.min(Math.max(u1, u2), hi) - Math.max(Math.min(u1, u2), lo)
  for (let i = 1; i < p.length; i++) {
    const [a, b] = [p[i - 1], p[i]]
    for (const g of groups) {
      if (a.x === b.x && a.y !== b.y)
        n += [g.x, g.x + g.width].filter((x) => Math.abs(a.x - x) < clear && run(a.y, b.y, g.y, g.y + g.height) > BORDER_CLEAR).length
      else if (a.y === b.y && a.x !== b.x)
        n += [g.y, g.y + g.height].filter((y) => Math.abs(a.y - y) < clear && run(a.x, b.x, g.x, g.x + g.width) > BORDER_CLEAR).length
    }
  }
  return n
}

/** Label boxes that cut a group border (partly inside, partly outside). */
export const labelOnBorder = (box: Rect, groups: Rect[]) => groups.filter((g) => intersects(box, g) && !contains(g, box)).length

/** Does the edge's label box cut a group border on this path? */
export function labelCutsBorder(w: Work, e: CanvasEdge, path: Point[], measure: Measure): boolean {
  if (!e.label) return false
  const box = edgeLabelBox(path, e.label, measure).box
  return labelOnBorder(box, w.doc.nodes.filter((n) => n.type === 'group' && isPlaced(n)).map(rectOf)) > 0
}

/** Sides that face each other at the level where the two ends' group chains split. */
export function preferredSides(w: Work, e: CanvasEdge): [Side, Side] {
  const a = w.byId.get(e.fromNode)!
  const b = w.byId.get(e.toNode)!
  const split = splitBoxes(w, e.fromNode, e.toNode)
  if (split) {
    const [s, t] = split
    const gx = Math.max(t.x - (s.x + s.width), s.x - (t.x + t.width))
    const gy = Math.max(t.y - (s.y + s.height), s.y - (t.y + t.height))
    if (gy > 0 && gy >= gx) return t.y > s.y ? ['bottom', 'top'] : ['top', 'bottom']
    if (gx > 0) return t.x > s.x ? ['right', 'left'] : ['left', 'right']
  }
  return [facingSide(a, b), facingSide(b, a)]
}

/** A group's title text box + 8px margin (the quality scorer's obstacle too); the rest of the top band is free. */
export function titleRect(g: GroupNode, measure: Measure): Rect {
  const w = measure(g.label ?? '', { fontSize: TYPE.groupLabelFontSize }).width + 8
  return { x: g.x - 4, y: g.y, width: w + 16, height: TYPE.groupLabelHeight + 8 }
}

/**
 * Rects an edge must not cross: hard = other non-group nodes and group titles (except for
 * edges that end at the group or join two of its children), soft = groups that hold neither end.
 */
export function obstaclesFor(w: Work, e: CanvasEdge, measure: Measure): { hard: Rect[]; soft: Rect[] } {
  const ends = new Set([e.fromNode, e.toNode])
  const skip = new Set([...ends, ...ancestors(w, e.fromNode), ...ancestors(w, e.toNode)])
  const hard: Rect[] = []
  const soft: Rect[] = []
  for (const n of w.doc.nodes) {
    if (!isPlaced(n)) continue
    const inside = w.byId.get(e.fromNode)?.['x-parent'] === n.id && w.byId.get(e.toNode)?.['x-parent'] === n.id
    if (n.type === 'group' && n.label && !ends.has(n.id) && !inside) hard.push(titleRect(n, measure))
    if (skip.has(n.id)) continue
    ;(n.type === 'group' ? soft : hard).push(rectOf(n))
  }
  return { hard, soft }
}

export function pathHits(path: Point[], obs: { hard: Rect[]; soft: Rect[] }): [number, number] {
  const count = (rs: Rect[]) => rs.filter((r) => path.slice(1).some((q, i) => segmentHitsRect(path[i], q, r))).length
  return [count(obs.hard), count(obs.soft)]
}

/** Drop repeated and collinear points; ends stay. */
function simplify(p: Point[]): Point[] {
  const out: Point[] = []
  for (const q of p) {
    const last = out[out.length - 1]
    if (last && last.x === q.x && last.y === q.y) continue
    const prev = out[out.length - 2]
    if (prev && last && ((prev.x === last.x && last.x === q.x) || (prev.y === last.y && last.y === q.y))) out.pop()
    out.push(q)
  }
  return out
}

/** First segment leaves `a` outward and last segment enters `b` from outside. */
function validEnds(p: Point[], sa: Side, sb: Side): boolean {
  if (p.length < 2) return false
  const dot = (u: Point, v: Point, n: Point) => (v.x - u.x) * n.x + (v.y - u.y) * n.y
  return dot(p[0], p[1], NORMAL[sa]) > 0 && dot(p[p.length - 1], p[p.length - 2], NORMAL[sb]) > 0
}

/** `all` = every placed node, so outer channels clear the end's own groups too. */
function candidates(a: Rect, b: Rect, all: Rect[], groups: Rect[]): { path: Point[]; sa: Side; sb: Side }[] {
  const out: { path: Point[]; sa: Side; sb: Side }[] = []
  const minX = Math.min(...all.map((r) => r.x)) - STUB
  const maxX = Math.max(...all.map((r) => r.x + r.width)) + STUB
  const minY = Math.min(...all.map((r) => r.y)) - STUB
  const maxY = Math.max(...all.map((r) => r.y + r.height)) + STUB
  // Outer channels: a near one, and a far one that leaves room for a label beside the content.
  const outX = [minX, maxX, minX - 2 * STUB, maxX + 2 * STUB]
  const outY = [minY, maxY, minY - 2 * STUB, maxY + 2 * STUB]
  // Channels in the gaps next to every box (TYPE.gap apart, so STUB is mid-gap): short routes around one group.
  const gapX = [...new Set(all.flatMap((r) => [r.x - STUB, r.x + r.width + STUB]))].sort((u, v) => u - v)
  const gapY = [...new Set(all.flatMap((r) => [r.y - STUB, r.y + r.height + STUB]))].sort((u, v) => u - v)
  const chX = [...outX, ...gapX]
  const chY = [...outY, ...gapY]
  // Gaps beside groups only, for the two-channel shapes below (keeps the candidate count small).
  const grX = [...new Set([...groups.flatMap((r) => [r.x - STUB, r.x + r.width + STUB]), outX[2], outX[3]])]
  const grY = [...new Set([...groups.flatMap((r) => [r.y - STUB, r.y + r.height + STUB]), outY[2], outY[3]])]
  for (const sa of SIDES)
    for (const sb of SIDES) {
      const p = sidePoint(a, sa)
      const q = sidePoint(b, sb)
      const hA = sa === 'left' || sa === 'right'
      const hB = sb === 'left' || sb === 'right'
      const mids: Point[][] = []
      if (hA && !hB) mids.push([{ x: q.x, y: p.y }])
      if (!hA && hB) mids.push([{ x: p.x, y: q.y }])
      if (hA && hB) {
        const xs = [(p.x + q.x) / 2, p.x + NORMAL[sa].x * STUB, q.x + NORMAL[sb].x * STUB, ...chX]
        for (const x of xs) mids.push([{ x, y: p.y }, { x, y: q.y }])
      }
      if (!hA && !hB) {
        const ys = [(p.y + q.y) / 2, p.y + NORMAL[sa].y * STUB, q.y + NORMAL[sb].y * STUB, ...chY]
        for (const y of ys) mids.push([{ x: p.x, y }, { x: q.x, y }])
      }
      // 4-segment detours through a stub and an outer channel, for when the simple shapes are blocked.
      if (hA && !hB) for (const y of chY) mids.push([{ x: p.x + NORMAL[sa].x * STUB, y: p.y }, { x: p.x + NORMAL[sa].x * STUB, y }, { x: q.x, y }])
      if (!hA && hB) for (const x of chX) mids.push([{ x: p.x, y: p.y + NORMAL[sa].y * STUB }, { x, y: p.y + NORMAL[sa].y * STUB }, { x, y: q.y }])
      // Leave along the side normal to a gap between groups, cross over, and enter from the side:
      // the way into a group without crossing its title strip.
      if (!hA && hB) for (const y of grY) for (const x of grX) mids.push([{ x: p.x, y }, { x, y }, { x, y: q.y }])
      if (hA && !hB) for (const x of grX) for (const y of grY) mids.push([{ x, y: p.y }, { x, y }, { x: q.x, y }])
      for (const m of mids) {
        const path = simplify([p, ...m, q])
        if (validEnds(path, sa, sb)) out.push({ path, sa, sb })
      }
    }
  return out
}

/**
 * Best route for an edge. Straight edges keep a straight line when it hits nothing.
 * With `fewerCrossings`, returns a clean route with fewer crossings than the current one, or undefined.
 */
export function routeEdge(w: Work, e: CanvasEdge, elbow: boolean, measure: Measure, fewerCrossings = false): Route | undefined {
  const a = w.byId.get(e.fromNode)
  const b = w.byId.get(e.toNode)
  if (!a || !b || a === b) return undefined
  const obs = obstaclesFor(w, e, measure)
  const groups = w.doc.nodes.filter((n) => n.type === 'group' && isPlaced(n)).map(rectOf)
  // Edges between the same two nodes are left out: the extra ones get fixed lanes below.
  const others = w.doc.edges.flatMap((o) => {
    const p = samePair(o, e) ? undefined : currentPath(w, o)
    return p ? [{ o, p }] : []
  })
  // Other edges' labels are soft obstacles too: a line through a label makes it hard to read.
  const labels = others.filter(({ o }) => o.label).map(({ o, p }) => edgeLabelBox(p, o.label!, measure).box)
  // Text boxes this edge's own label must stay clear of (nodes, group label strips, other labels).
  const texts = [
    ...w.doc.nodes.filter(isPlaced).map((n) => (n.type === 'group' ? { ...rectOf(n), height: TYPE.groupLabelHeight } : rectOf(n))),
    ...labels,
  ]
  const ownLabel = (path: Point[]) => {
    if (!e.label) return 0
    const lb = edgeLabelBox(path, e.label, measure)
    return (lb.wrapped ? 1 : 0) + texts.filter((t) => intersects(lb.box, t)).length + labelOnBorder(lb.box, groups)
  }
  const crossings = (path: Point[]) =>
    others.filter(({ p }) => path.slice(1).some((q, i) => p.slice(1).some((r, j) => segmentsCross(path[i], q, p[j], r)))).length
  const runs = (path: Point[]) => others.reduce((s, { p }) => s + sharedRuns(path, p), 0)
  // Same tests at the scorer's tolerances: a real overlap / a line on a border.
  const exact = (path: Point[]) => others.reduce((s, { p }) => s + sharedRuns(path, p, 4), 0) + borderRuns(path, groups, 7)
  const [pa, pb] = preferredSides(w, e)
  // Lower is better, compared left to right. The last-but-one entry trades length against
  // crossings, group hits and off-preference ports, so a short route wins over a long loop.
  const score = (path: Point[], sa: Side, sb: Side) => {
    const [h, s] = pathHits(path, obs)
    const [l] = pathHits(path, { hard: labels, soft: [] })
    const port = (sa === pa ? 0 : 1) + (sb === pb ? 0 : 1)
    const cost = pathLength(path) + 300 * crossings(path) + 200 * s + 60 * port
    return [h, ownLabel(path), l, runs(path) + borderRuns(path, groups), Math.round(cost), path.length]
  }
  type Scored = { route: Route; key: number[]; soft: number; cross: number; len: number; exact: number }
  const scored: Scored[] = []
  // Routes no worse than now on hits, labels, runs and groups; fewest crossings first; no long detours;
  // and strictly fewer crossings than now.
  const pickFewer = (list: Scored[]) => {
    const cur = currentPath(w, e)!
    const now = score(cur, e.fromSide ?? pa, e.toSide ?? pb)
    const nowSoft = pathHits(cur, obs)[1]
    const limit = Math.max(2 * pathLength(cur), pathLength(cur) + 600)
    const ok = list.filter(
      // One more near-parallel run is allowed, but no real overlap or line on a border.
      (x) =>
        x.key[0] === 0 && x.key[1] <= now[1] && x.key[2] <= now[2] && x.key[3] <= now[3] + 1 && x.exact <= exact(cur) &&
        x.soft <= nowSoft && x.len <= limit,
    )
    ok.sort((x, y) => x.cross - y.cross || x.key[4] - y.key[4])
    return ok[0] && ok[0].cross < crossings(cur) ? ok[0].route : undefined
  }
  // Score the path the renderer will draw: real ports (spread along a shared side), waypoints aligned to them.
  const add = (path: Point[], sa: Side, sb: Side) => {
    const route = tryRoute(w, e, { points: path.slice(1, -1), fromSide: sa, toSide: sb })
    const key = score(route.path, sa, sb)
    scored.push({ route: route.route, key, soft: pathHits(route.path, obs)[1], cross: crossings(route.path), len: pathLength(route.path), exact: exact(route.path) })
  }

  // 2nd, 3rd... edge between the same two nodes (either direction): its own lane beside the nodes.
  const rank = w.doc.edges.filter((o) => samePair(o, e)).indexOf(e)
  if (rank > 0) {
    const vertical = pa === 'top' || pa === 'bottom'
    const lanes: Side[] = vertical ? ['left', 'right'] : ['top', 'bottom']
    if (rank % 2 === 0) lanes.reverse()
    // A second, wider offset per side, for when the near lane runs along a group border or another edge.
    for (const off of [LANE * Math.ceil(rank / 2), LANE * Math.ceil(rank / 2) + LANE]) for (const side of lanes) {
      const p = sidePoint(a, side)
      const q = sidePoint(b, side)
      const lane =
        side === 'top' ? Math.min(a.y, b.y) - off
        : side === 'bottom' ? Math.max(a.y + a.height, b.y + b.height) + off
        : side === 'left' ? Math.min(a.x, b.x) - off
        : Math.max(a.x + a.width, b.x + b.width) + off
      const mid = vertical ? [{ x: lane, y: p.y }, { x: lane, y: q.y }] : [{ x: p.x, y: lane }, { x: q.x, y: lane }]
      add([p, ...mid, q], side, side)
    }
    if (fewerCrossings) return pickFewer(scored)
    scored.sort((x, y) => x.key.reduce((d, v, i) => d || v - y.key[i], 0))
    return scored[0].route
  }

  if (!elbow) {
    const path = tryRoute(w, e, { points: [], fromSide: pa, toSide: pb }).path
    const [h, s] = pathHits(path, obs)
    if (!fewerCrossings && h + s === 0 && runs(path) === 0 && !labelCutsBorder(w, e, path, measure)) return { points: [], fromSide: pa, toSide: pb }
    add(path, pa, pb)
  }
  for (const c of candidates(rectOf(a), rectOf(b), w.doc.nodes.filter(isPlaced).map(rectOf), groups)) add(c.path, c.sa, c.sb)
  if (fewerCrossings) return pickFewer(scored)
  // Stable sort keeps generation order on ties.
  scored.sort((x, y) => x.key.reduce((d, v, i) => d || v - y.key[i], 0))
  return scored[0]?.route
}

export const currentPath = (w: Work, e: CanvasEdge) => edgePath(w.doc, e, w.byId)

/**
 * Move the first/last waypoint so the first/last segment runs straight out of the real port
 * (core spreads ports along a shared side). Returns the new points, or undefined if already aligned.
 */
function alignedPoints(w: Work, e: CanvasEdge): Point[] | undefined {
  const path = currentPath(w, e)
  if (!path) return undefined
  const p = path[0]
  const q = path[path.length - 1]
  const horizontal = (s?: Side) => s === 'left' || s === 'right'
  const pts = e['x-points']
  if (!pts?.length) {
    // An elbow edge must stay orthogonal even when shifted ports make its two ends misaligned.
    if (e['x-route'] !== 'elbow' || p.x === q.x || p.y === q.y || !e.fromSide) return undefined
    if (horizontal(e.fromSide) && horizontal(e.toSide)) return [{ x: (p.x + q.x) / 2, y: p.y }, { x: (p.x + q.x) / 2, y: q.y }]
    if (!horizontal(e.fromSide) && !horizontal(e.toSide)) return [{ x: p.x, y: (p.y + q.y) / 2 }, { x: q.x, y: (p.y + q.y) / 2 }]
    return [horizontal(e.fromSide) ? { x: q.x, y: p.y } : { x: p.x, y: q.y }]
  }
  const out = pts.map((t) => ({ ...t }))
  if (horizontal(e.fromSide)) out[0].y = p.y
  else out[0].x = p.x
  const l = out.length - 1
  if (horizontal(e.toSide)) out[l].y = q.y
  else out[l].x = q.x
  return out.some((t, i) => t.x !== pts[i].x || t.y !== pts[i].y) ? out : undefined
}

/** Align one edge to its ports; ports depend on waypoints, so repeat (max 3). */
function alignEdge(w: Work, e: CanvasEdge): boolean {
  let changed = false
  for (let i = 0; i < 3; i++) {
    const pts = alignedPoints(w, e)
    if (!pts) break
    e['x-points'] = pts
    changed = true
  }
  return changed
}

/** Path and port-aligned route for `e` if it took route `r` (the edge is restored afterwards). */
function tryRoute(w: Work, e: CanvasEdge, r: Route): { route: Route; path: Point[] } {
  const saved = { p: e['x-points'], f: e.fromSide, t: e.toSide }
  setRoute(e, r)
  alignEdge(w, e)
  const out = { route: { points: e['x-points'] ?? [], fromSide: e.fromSide, toSide: e.toSide }, path: currentPath(w, e)! }
  if (saved.p) e['x-points'] = saved.p
  else delete e['x-points']
  e.fromSide = saved.f
  e.toSide = saved.t
  return out
}

/** Re-align every elbow edge to the current ports (adding an edge to a side shifts its neighbours' ports). */
export function alignAll(w: Work): boolean {
  let changed = false
  for (let pass = 0; pass < 3; pass++) {
    let any = false
    for (const e of w.doc.edges) if (alignEdge(w, e)) any = true
    if (!any) break
    changed = true
  }
  return changed
}

const same = (e: CanvasEdge, r: Route) =>
  JSON.stringify(e['x-points'] ?? []) === JSON.stringify(r.points) && e.fromSide === r.fromSide && e.toSide === r.toSide

export function setRoute(e: CanvasEdge, r: Route): boolean {
  if (same(e, r)) return false
  if (r.points.length) e['x-points'] = r.points
  else delete e['x-points']
  e.fromSide = r.fromSide
  e.toSide = r.toSide
  return true
}

/**
 * Route edges that need it: elbow edges without sides, edges whose ends moved since `start`,
 * edges that cross a node, and (when `fillSides`) straight edges with no sides yet.
 */
export function fixRoutes(w: Work, start: Map<string, Rect>, fillSides: boolean, measure: Measure): boolean {
  let changed = false
  for (const e of w.doc.edges) {
    const a = w.byId.get(e.fromNode)
    const b = w.byId.get(e.toNode)
    if (!a || !b || a === b || !isPlaced(a) || !isPlaced(b)) continue
    const elbow = e['x-route'] === 'elbow'
    const moved = [a, b].some((n) => JSON.stringify(rectOf(n)) !== JSON.stringify(start.get(n.id)))
    const path = currentPath(w, e)!
    const [h, s] = pathHits(path, obstaclesFor(w, e, measure))
    const missing = !e.fromSide || !e.toSide
    const stacked = !e['x-points']?.length && w.doc.edges.findIndex((o) => samePair(o, e)) < w.doc.edges.indexOf(e)
    const cut = labelCutsBorder(w, e, path, measure)
    if (!(moved || stacked || cut || h + s > 0 || (missing && (elbow || fillSides)))) continue
    const r = routeEdge(w, e, elbow, measure)
    if (r && setRoute(e, r)) changed = true
  }
  changed = alignAll(w) || changed
  // Only after a full layout: in the tidy loop it would cost a lot and could undo label fixes.
  return (fillSides && reduceCrossings(w, measure)) || changed
}

/** Local search: re-route an edge when a clean route with strictly fewer crossings exists (3 rounds). */
function reduceCrossings(w: Work, measure: Measure): boolean {
  let changed = false
  for (let round = 0; round < 3; round++) {
    let any = false
    const paths = new Map(w.doc.edges.map((e) => [e, currentPath(w, e)] as const))
    const crosses = (e: CanvasEdge) => {
      const p = paths.get(e)
      return !!p && w.doc.edges.some((o) => {
        const q = paths.get(o)
        return o !== e && !samePair(o, e) && !!q && p.slice(1).some((u, i) => q.slice(1).some((v, j) => segmentsCross(p[i], u, q[j], v)))
      })
    }
    for (const e of w.doc.edges.filter(crosses)) {
      const a = w.byId.get(e.fromNode)
      const b = w.byId.get(e.toNode)
      if (!a || !b || a === b || !isPlaced(a) || !isPlaced(b)) continue
      const r = routeEdge(w, e, e['x-route'] === 'elbow', measure, true)
      if (r && setRoute(e, r)) (alignAll(w), (any = true))
    }
    if (!any) break
    changed = true
  }
  return changed
}
