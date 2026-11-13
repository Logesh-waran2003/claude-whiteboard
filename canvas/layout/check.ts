// Readability check used by the tests (same rules the quality benchmark scores).
import { contains, edgeLabelBox, edgePath, intersects, nodeById, segmentHitsRect } from '../core/geometry'
import { type CanvasDoc, type Measure, type Rect, TYPE } from '../core/model'

/** Readability problems, using the shared geometry helpers. */
export function problems(doc: CanvasDoc, measure: Measure): string[] {
  const out: string[] = []
  const byId = nodeById(doc)
  const boxes: { id: string; rect: Rect }[] = []
  for (const n of doc.nodes) {
    if (n['x-placed'] === false) out.push(`unplaced ${n.id}`)
    boxes.push({ id: n.id, rect: n.type === 'group' ? { ...n, height: TYPE.groupLabelHeight } : n })
  }
  for (const e of doc.edges) {
    const path = edgePath(doc, e, byId)!
    if (e.label) {
      const lb = edgeLabelBox(path, e.label, measure)
      if (lb.wrapped) out.push(`wrap ${e.id}`)
      boxes.push({ id: `label:${e.id}`, rect: lb.box })
    }
    const ends = new Set([e.fromNode, e.toNode])
    for (const n of doc.nodes) {
      if (ends.has(n.id) || n.type === 'group') continue
      if (path.slice(1).some((q, i) => segmentHitsRect(path[i], q, n))) out.push(`edge ${e.id} through ${n.id}`)
    }
  }
  for (let i = 0; i < boxes.length; i++)
    for (let j = 0; j < i; j++) if (intersects(boxes[i].rect, boxes[j].rect)) out.push(`overlap ${boxes[j].id} ${boxes[i].id}`)
  // Sibling groups must not overlap each other or sibling nodes either.
  for (const a of doc.nodes)
    for (const b of doc.nodes)
      if (a.id < b.id && (a.type === 'group' || b.type === 'group') && a['x-parent'] === b['x-parent'] && intersects(a, b))
        out.push(`overlap ${a.id} ${b.id}`)
  for (const n of doc.nodes) {
    const g = n['x-parent'] && byId.get(n['x-parent'])
    if (g && !contains(g, n)) out.push(`outside ${n.id}`)
  }
  return out
}
