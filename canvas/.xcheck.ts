// Cross-check: layout ops through the real Board, scored by the independent quality scorer.
import { createBoard } from './core/board'
import { approxMeasure } from './core/measure'
import { layoutBoard, enforceInvariants } from './layout'
import { fixtures } from './layout/fixtures'
import { score } from './quality/score'
for (const [name, doc] of Object.entries(fixtures)) {
  const b = createBoard(structuredClone(doc))
  const before = score(b.doc, approxMeasure).score
  const r1 = b.apply(layoutBoard(b.doc, approxMeasure), { by: 'layout' })
  const r2 = b.apply(enforceInvariants(b.doc, approxMeasure), { by: 'layout', mergeWithPrevious: true })
  const q = score(b.doc, approxMeasure)
  console.log(name.padEnd(13), 'apply', r1.ok, r2.ok, (r1 as any).error?.message ?? '', '| score', before, '->', q.score, JSON.stringify({ o: q.overlaps, w: q.wraps, t: q.edgeThroughNode, out: q.outsideGroup, x: q.crossings }))
}
