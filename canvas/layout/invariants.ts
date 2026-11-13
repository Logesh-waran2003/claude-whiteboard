// Auto-tidy: repair overlaps, squeezed edge labels, containment and routes on a Work, in place.
import { center, edgeLabelBox, intersects, pathLength } from '../core/geometry'
import { type CanvasEdge, type CanvasNode, type Measure, type Rect, TYPE } from '../core/model'
import { fitGroup } from './place'
import { currentPath, fixRoutes, samePair } from './route'
import { ROOT, type Work, canMove, isPlaced, kidsOf, moveBy, parentId, postOrderGroups, rectOf, splitBoxes } from './tree'

const MAX_PASSES = 20
const MAX_LABEL_PUSHES = 6
const CLEAR = 24
const MAX_PUSH = 400

/** Text boxes an edge label must not touch: non-group nodes and group label strips. */
export function textBoxes(w: Work): { id: string; rect: Rect }[] {
  return w.doc.nodes
    .filter(isPlaced)
    .map((n) => ({ id: n.id, rect: n.type === 'group' ? { x: n.x, y: n.y, width: n.width, height: TYPE.groupLabelHeight } : rectOf(n) }))
}

/** a. Siblings closer than TYPE.gap: push the movable one (prefer the later) along the shallower axis. */
function fixOverlaps(w: Work): boolean {
  let changed = false
  for (const cid of [ROOT, ...postOrderGroups(w)]) {
    const sibs = kidsOf(w, cid).filter(isPlaced)
    for (let j = 0; j < sibs.length; j++)
      for (let i = 0; i < j; i++) {
        const [a, b] = [sibs[i], sibs[j]]
        if (!intersects(a, b, TYPE.gap)) continue
        const mover = canMove(w, b) ? b : canMove(w, a) ? a : undefined
        if (!mover) continue
        const other = mover === b ? a : b
        const cm = center(mover)
        const co = center(other)
        const dx = cm.x >= co.x ? other.x + other.width + TYPE.gap - mover.x : -(mover.x + mover.width + TYPE.gap - other.x)
        const dy = cm.y >= co.y ? other.y + other.height + TYPE.gap - mover.y : -(mover.y + mover.height + TYPE.gap - other.y)
        if (Math.abs(dx) <= Math.abs(dy)) moveBy(w, mover, Math.ceil(dx), 0)
        else moveBy(w, mover, 0, Math.ceil(dy))
        changed = true
      }
  }
  return changed
}

const overlapDepth = (a: Rect, b: Rect, horizontal: boolean) =>
  horizontal ? Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x) : Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y)

/**
 * Open space by moving `box` and every movable sibling at or beyond it along the axis, so rows
 * and columns that were aligned stay aligned. `anchor` (the other end) never moves.
 */
function sweep(w: Work, box: CanvasNode, anchor: CanvasNode, horizontal: boolean, d: number) {
  const start = (n: Rect) => (horizontal ? n.x : n.y)
  const end = (n: Rect) => (horizontal ? n.x + n.width : n.y + n.height)
  for (const n of kidsOf(w, parentId(w.byId, box))) {
    const beyond = d > 0 ? end(n) > start(box) : start(n) < end(box) // not wholly behind the box
    if (n === box || (n !== anchor && isPlaced(n) && beyond && canMove(w, n)))
      moveBy(w, n, horizontal ? d : 0, horizontal ? 0 : d)
  }
}

/** b. Labels that wrap or touch a text box: push the target's box away from the source's box. */
function fixLabels(w: Work, measure: Measure, pushes: Map<string, number>): boolean {
  let changed = false
  const labelled = w.doc.edges.filter((e) => e.label && w.byId.get(e.fromNode) && w.byId.get(e.toNode))
  const box = (e: CanvasEdge) => {
    const p = currentPath(w, e)
    return p && { path: p, ...edgeLabelBox(p, e.label!, measure) }
  }
  labelled.forEach((e, idx) => {
    if ((pushes.get(e.id) ?? 0) >= MAX_LABEL_PUSHES) return
    const split = splitBoxes(w, e.fromNode, e.toNode)
    const lb = box(e)
    if (!split || !lb) return
    const [sBox, tBox] = split
    const cs = center(sBox)
    const ct = center(tBox)
    const horizontal = Math.abs(ct.x - cs.x) >= Math.abs(ct.y - cs.y)
    let missing = 0
    if (lb.wrapped) {
      const one = measure(e.label!, { fontSize: TYPE.labelFontSize }).width + 2 * TYPE.labelPadding
      missing = Math.max(missing, one + 48 - pathLength(lb.path))
    }
    // Moving the target by d moves the label midpoint by about d/2.
    for (const t of textBoxes(w)) if (intersects(lb.box, t.rect)) missing = Math.max(missing, 2 * overlapDepth(lb.box, t.rect, horizontal))
    // Of two clashing labels only the later edge moves, so they do not both push.
    for (const o of labelled.slice(0, idx)) {
      if (samePair(o, e)) continue // parallel edges get separate lanes from the router; pushing cannot help
      const ob = box(o)
      if (ob && intersects(lb.box, ob.box)) missing = Math.max(missing, 2 * overlapDepth(lb.box, ob.box, horizontal))
    }
    if (missing <= 0 && !lb.wrapped) return
    // Capped so one bad measurement cannot blow the board apart.
    const amount = Math.min(MAX_PUSH, Math.ceil(Math.max(0, missing)) + CLEAR)
    let sign = horizontal ? Math.sign(ct.x - cs.x) : Math.sign(ct.y - cs.y)
    if (sign === 0) sign = 1
    if (canMove(w, tBox)) sweep(w, tBox, sBox, horizontal, sign * amount)
    else if (canMove(w, sBox)) sweep(w, sBox, tBox, horizontal, -sign * amount)
    else return
    pushes.set(e.id, (pushes.get(e.id) ?? 0) + 1)
    changed = true
  })
  return changed
}

/** c. Groups grow (innermost first) so every child sits inside with padding. */
function fixContainment(w: Work, measure: Measure): boolean {
  let changed = false
  for (const gid of postOrderGroups(w)) {
    const g = w.byId.get(gid)!
    if (isPlaced(g) && fitGroup(w, g, false, measure)) changed = true
  }
  return changed
}

/** Run the repair passes on `w` until a pass changes nothing (max 20). */
export function enforce(w: Work, measure: Measure): void {
  const start = new Map(w.doc.nodes.map((n) => [n.id, rectOf(n)] as const))
  const pushes = new Map<string, number>()
  for (let pass = 0; pass < MAX_PASSES; pass++) {
    let dirty = fixContainment(w, measure)
    dirty = fixOverlaps(w) || dirty
    dirty = fixRoutes(w, start, false, measure) || dirty
    if (!dirty) dirty = fixLabels(w, measure, pushes)
    if (!dirty) return
  }
}
