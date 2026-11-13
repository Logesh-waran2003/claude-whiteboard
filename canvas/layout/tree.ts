// Mutable working copy of a doc plus tree helpers. Every layout step edits a Work; index.ts diffs it into ops.
import { type CanvasDoc, type CanvasNode, type Point, type Rect, TYPE } from '../core/model'

export const ROOT = 'root'

export type Work = { doc: CanvasDoc; byId: Map<string, CanvasNode>; kids: Map<string, CanvasNode[]> }

export function makeWork(doc: CanvasDoc): Work {
  const clone = structuredClone(doc)
  const byId = new Map(clone.nodes.map((n) => [n.id, n] as const))
  const kids = new Map<string, CanvasNode[]>([[ROOT, []]])
  for (const n of clone.nodes) {
    const p = parentId(byId, n)
    if (!kids.has(p)) kids.set(p, [])
    kids.get(p)!.push(n)
  }
  // A cycle in x-parent would hide nodes from the tree; treat such nodes as top level.
  const reach = new Set<string>()
  const walk = (id: string) => (kids.get(id) ?? []).forEach((k) => !reach.has(k.id) && (reach.add(k.id), walk(k.id)))
  walk(ROOT)
  for (const n of clone.nodes) if (!reach.has(n.id)) (delete n['x-parent'], kids.get(ROOT)!.push(n), reach.add(n.id), walk(n.id))
  for (const [id, list] of kids) kids.set(id, list.filter((k) => parentId(byId, k) === id))
  return { doc: clone, byId, kids }
}

export function parentId(byId: Map<string, CanvasNode>, n: CanvasNode): string {
  const p = n['x-parent']
  return p && p !== n.id && byId.get(p)?.type === 'group' ? p : ROOT
}

export const kidsOf = (w: Work, id: string) => w.kids.get(id) ?? []
/** Never moved: pinned, made by the user, or placed by another editor (no x-by). */
export const isFixed = (n: CanvasNode) => n['x-pin'] === true || n['x-by'] === 'user' || (n['x-by'] === undefined && isPlaced(n))
export const isPlaced = (n: CanvasNode) => n['x-placed'] !== false
export const rectOf = (n: Rect): Rect => ({ x: n.x, y: n.y, width: n.width, height: n.height })
export const innerOrigin = (g: Rect): Point => ({ x: g.x + TYPE.groupPadding, y: g.y + TYPE.groupLabelHeight + TYPE.groupPadding })

export function descendants(w: Work, id: string): CanvasNode[] {
  const out: CanvasNode[] = []
  for (const k of kidsOf(w, id)) out.push(k, ...descendants(w, k.id))
  return out
}

/** Group ids from the direct parent up to the top. */
export function ancestors(w: Work, id: string): string[] {
  const out: string[] = []
  let n = w.byId.get(id)
  while (n) {
    const p = parentId(w.byId, n)
    if (p === ROOT) break
    out.push(p)
    n = w.byId.get(p)
  }
  return out
}

/** Can the engine translate this node (and its subtree)? */
export const canMove = (w: Work, n: CanvasNode) => !isFixed(n) && descendants(w, n.id).every((d) => !isFixed(d))

export function moveBy(w: Work, n: CanvasNode, dx: number, dy: number) {
  if (!dx && !dy) return
  for (const m of [n, ...descendants(w, n.id)]) {
    m.x += dx
    m.y += dy
  }
}

/** Groups in post-order (children before parents), starting below `from`; includes `from` when it is a group. */
export function postOrderGroups(w: Work, from = ROOT): string[] {
  const out: string[] = []
  const visit = (id: string) => {
    for (const k of kidsOf(w, id)) if (k.type === 'group') visit(k.id)
    if (id !== ROOT) out.push(id)
  }
  visit(from)
  return out
}

/** The direct child of container `cid` that contains (or is) node `id`. */
export function boxIn(w: Work, id: string, cid: string): string | undefined {
  let n = w.byId.get(id)
  while (n) {
    const p = parentId(w.byId, n)
    if (p === cid) return n.id
    if (p === ROOT) return undefined
    n = w.byId.get(p)
  }
  return undefined
}

/** The two sibling boxes where the paths from the root to `s` and `t` split. */
export function splitBoxes(w: Work, s: string, t: string): [CanvasNode, CanvasNode] | undefined {
  const chain = (id: string) => [id, ...ancestors(w, id)].reverse() // top-level first
  const cs = chain(s)
  const ct = chain(t)
  let i = 0
  while (i < cs.length && i < ct.length && cs[i] === ct[i]) i++
  if (i >= cs.length || i >= ct.length) return undefined // one end contains the other
  return [w.byId.get(cs[i])!, w.byId.get(ct[i])!]
}
