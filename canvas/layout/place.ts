// Placement per container: dag (dagre), grid, free slots. Positions are absolute; a group's
// children start at its inner origin, so moving the group later moves them along.
import dagre from '@dagrejs/dagre'
import { boundsOf, center, contains, intersects } from '../core/geometry'
import { type CanvasNode, type GroupNode, type LayoutKind, type Measure, type Point, type Rect, TYPE } from '../core/model'
import { groupLabelWidth } from './size'
import { ROOT, type Work, boxIn, canMove, innerOrigin, isFixed, isPlaced, kidsOf, moveBy, rectOf } from './tree'

const r = Math.round

export function moveTo(w: Work, n: CanvasNode, x: number, y: number) {
  moveBy(w, n, r(x) - n.x, r(y) - n.y)
  delete n['x-placed']
}

/** Rank gap a labelled edge needs so its label fits on one line. */
export function labelRankGap(label: string | undefined, measure: Measure): number {
  if (!label) return TYPE.gap
  return Math.max(TYPE.edgeLabelGap, measure(label, { fontSize: TYPE.labelFontSize }).width + 48 + 24)
}

/** Edges between descendants of `cid`, mapped to its direct children, deduped; plus the rank gap their labels need. */
function containerEdges(w: Work, cid: string, measure: Measure): { edges: [string, string][]; ranksep: number } {
  const pairs = new Set<string>()
  let ranksep: number = TYPE.gap
  const edges: [string, string][] = []
  for (const e of w.doc.edges) {
    const a = boxIn(w, e.fromNode, cid)
    const b = boxIn(w, e.toNode, cid)
    if (!a || !b || a === b) continue
    ranksep = Math.max(ranksep, labelRankGap(e.label, measure))
    const key = `${a}\n${b}`
    if (!pairs.has(key)) (pairs.add(key), edges.push([a, b]))
  }
  return { edges, ranksep }
}

function dagLayout(w: Work, cid: string, kids: CanvasNode[], rankdir: 'LR' | 'TB', origin: Point, measure: Measure) {
  const g = new dagre.graphlib.Graph()
  const { edges, ranksep } = containerEdges(w, cid, measure)
  g.setGraph({ rankdir, nodesep: TYPE.gap, ranksep, marginx: 0, marginy: 0 })
  g.setDefaultEdgeLabel(() => ({}))
  for (const k of kids) g.setNode(k.id, { width: k.width, height: k.height })
  for (const [a, b] of edges) g.setEdge(a, b)
  dagre.layout(g)
  const pos = kids.map((k) => {
    const p = g.node(k.id)
    return { k, x: (p.x ?? 0) - k.width / 2, y: (p.y ?? 0) - k.height / 2 }
  })
  const minX = Math.min(...pos.map((p) => p.x))
  const minY = Math.min(...pos.map((p) => p.y))
  for (const p of pos) if (!isFixed(p.k)) moveTo(w, p.k, origin.x + p.x - minX, origin.y + p.y - minY)
}

/** Children with no edges among them: one row (LR) or one column (TB), centred on the cross axis. */
function lineLayout(w: Work, kids: CanvasNode[], horizontal: boolean, origin: Point) {
  const cross = Math.max(...kids.map((k) => (horizontal ? k.height : k.width)))
  let at = horizontal ? origin.x : origin.y
  for (const k of kids) {
    if (horizontal) moveTo(w, k, at, origin.y + (cross - k.height) / 2)
    else moveTo(w, k, origin.x + (cross - k.width) / 2, at)
    at += (horizontal ? k.width : k.height) + TYPE.gap
  }
}

function gridLayout(w: Work, kids: CanvasNode[], origin: Point) {
  const cols = Math.ceil(Math.sqrt(kids.length))
  const colW: number[] = []
  const rowH: number[] = []
  kids.forEach((k, i) => {
    const c = i % cols
    const row = Math.floor(i / cols)
    colW[c] = Math.max(colW[c] ?? 0, k.width)
    rowH[row] = Math.max(rowH[row] ?? 0, k.height)
  })
  const offset = (sizes: number[], i: number) => sizes.slice(0, i).reduce((s, v) => s + v + TYPE.gap, 0)
  kids.forEach((k, i) => moveTo(w, k, origin.x + offset(colW, i % cols), origin.y + offset(rowH, Math.floor(i / cols))))
}

/** Put each node into the free slot nearest to its placed neighbours, else keep the content compact. */
function freePlace(w: Work, obstacles: Rect[], toPlace: CanvasNode[], origin: Point) {
  const obs = [...obstacles]
  for (const n of toPlace) {
    const neighbours = w.doc.edges
      .flatMap((e) => (e.fromNode === n.id ? [e.toNode] : e.toNode === n.id ? [e.fromNode] : []))
      .map((id) => w.byId.get(id))
      .filter((m): m is CanvasNode => !!m && m.id !== n.id && isPlaced(m) && !toPlace.slice(toPlace.indexOf(n)).includes(m))
    const target = neighbours.length
      ? { x: neighbours.reduce((s, m) => s + center(m).x, 0) / neighbours.length, y: neighbours.reduce((s, m) => s + center(m).y, 0) / neighbours.length }
      : undefined
    const xs = new Set([origin.x, ...obs.flatMap((o) => [o.x, o.x + o.width + TYPE.gap])])
    const ys = new Set([origin.y, ...obs.flatMap((o) => [o.y, o.y + o.height + TYPE.gap])])
    let best: { x: number; y: number; score: number } | undefined
    for (const y of [...ys].sort((a, b) => a - b))
      for (const x of [...xs].sort((a, b) => a - b)) {
        if (x < origin.x || y < origin.y) continue
        const cand = { x, y, width: n.width, height: n.height }
        if (obs.some((o) => intersects(cand, o, TYPE.gap))) continue
        const c = center(cand)
        const score = target
          ? Math.hypot(c.x - target.x, c.y - target.y)
          : Math.max(x + n.width - origin.x, y + n.height - origin.y)
        if (!best || score < best.score) best = { x, y, score }
      }
    // A candidate right of all obstacles always exists, so best is set.
    moveTo(w, n, best!.x, best!.y)
    obs.push(rectOf(n))
  }
}

/** Grow (or, when tight, set) a group to wrap its children with padding and room for the label. */
export function fitGroup(w: Work, g: CanvasNode, tight: boolean, measure: Measure): boolean {
  // Pinned groups never change; other fixed groups (user / other editor) may only grow.
  if (g['x-pin'] === true) return false
  if (isFixed(g)) tight = false
  const before = JSON.stringify(rectOf(g))
  const labelW = groupLabelWidth((g as GroupNode).label, measure)
  const b = boundsOf(kidsOf(w, g.id).filter(isPlaced).map(rectOf))
  if (!b) {
    if (!isPlaced(g)) {
      g.width = Math.max(TYPE.minNode.width * 2, labelW)
      g.height = TYPE.minNode.height * 2
    }
    return JSON.stringify(rectOf(g)) !== before
  }
  const pad = TYPE.groupPadding
  const need = { x: b.x - pad, y: b.y - pad - TYPE.groupLabelHeight, width: 0, height: 0 }
  need.width = Math.max(b.x + b.width + pad - need.x, labelW)
  need.height = b.y + b.height + pad - need.y
  if (tight) Object.assign(g, need)
  else if (!contains(g, need)) {
    const u = boundsOf([rectOf(g), need])!
    Object.assign(g, u)
  }
  return JSON.stringify(rectOf(g)) !== before
}

export function layoutKind(w: Work, cid: string): LayoutKind {
  const k = cid === ROOT ? w.doc['x-layout'] : (w.byId.get(cid) as GroupNode)['x-layout']
  return k ?? 'free'
}

/** Lay out one container's direct children. `changed` collects nodes sized/placed/resized in this run. */
export function layoutContainer(w: Work, cid: string, all: boolean, changed: Set<string>, measure: Measure) {
  const group = cid === ROOT ? undefined : w.byId.get(cid)!
  const kids = kidsOf(w, cid)
  const kind = layoutKind(w, cid)
  const placedKids = kids.filter(isPlaced)
  const origin = group
    ? innerOrigin(group)
    : placedKids.length
      ? { x: Math.min(...placedKids.map((k) => k.x)), y: Math.min(...placedKids.map((k) => k.y)) }
      : { x: 0, y: 0 }
  const movable = kids.filter((k) => canMove(w, k))
  const dirty = all || kids.some((k) => changed.has(k.id)) || (group && !isPlaced(group))
  if ((kind === 'dag-lr' || kind === 'dag-tb') && dirty && movable.length) {
    // dagre would stack edge-less children in one rank (a column for LR); a line or grid reads better.
    if (containerEdges(w, cid, measure).edges.length) dagLayout(w, cid, kids, kind === 'dag-lr' ? 'LR' : 'TB', origin, measure)
    else if (movable.length > 4) gridLayout(w, movable, origin)
    else lineLayout(w, movable, kind === 'dag-lr', origin)
    movable.forEach((k) => changed.add(k.id))
  } else if (kind === 'grid' && dirty && movable.length) {
    gridLayout(w, movable, origin)
    movable.forEach((k) => changed.add(k.id))
  } else if (kind === 'free') {
    const toPlace = movable.filter((k) => all || !isPlaced(k))
    const obstacles = kids.filter((k) => isPlaced(k) && !toPlace.includes(k)).map(rectOf)
    freePlace(w, obstacles, toPlace, origin)
    toPlace.forEach((k) => changed.add(k.id))
  }
  if (group) {
    const tight = all || !isPlaced(group) || (kind !== 'free' && !!dirty)
    if (fitGroup(w, group, tight, measure)) changed.add(group.id)
  }
}
