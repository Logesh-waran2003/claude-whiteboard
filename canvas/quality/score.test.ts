import { describe, expect, test } from 'bun:test'
import type { CanvasDoc, CanvasEdge, CanvasNode } from '../core/model'
import { approxMeasure } from '../core/measure'
import { scoreDetailed } from './score'

const text = (id: string, x: number, y: number, width = 100, height = 50, extra: Partial<CanvasNode> = {}) =>
  ({ id, type: 'text', text: id, x, y, width, height, ...extra }) as CanvasNode
const edge = (id: string, fromNode: string, toNode: string, extra: Partial<CanvasEdge> = {}) =>
  ({ id, fromNode, toNode, ...extra }) as CanvasEdge
const doc = (nodes: CanvasNode[], edges: CanvasEdge[] = []): CanvasDoc => ({ nodes, edges })
const load = async (name: string) => (await Bun.file(`${import.meta.dir}/fixtures/${name}.canvas`).json()) as CanvasDoc

describe('score: metrics on tiny docs', () => {
  test('clean pair scores 100 and area is the node bounding box', () => {
    const r = scoreDetailed(doc([text('a', 0, 0), text('b', 300, 0)], [edge('e', 'a', 'b')]), approxMeasure)
    expect(r.score).toBe(100)
    expect(r.overlaps).toEqual([])
    expect(r.area).toBe(400 * 50)
  })

  test('overlap counts only when both axes overlap by more than 2px', () => {
    expect(scoreDetailed(doc([text('a', 0, 0), text('b', 98, 0)]), approxMeasure).overlaps).toEqual([])
    const r = scoreDetailed(doc([text('a', 0, 0), text('b', 97, 0)]), approxMeasure)
    expect(r.overlaps).toEqual([['a', 'b']])
    expect(r.score).toBe(85)
  })

  test('a long edge label in a 40px gap wraps', () => {
    const r = scoreDetailed(doc([text('a', 0, 0), text('b', 140, 0)], [edge('e', 'a', 'b', { label: 'a very long label' })]), approxMeasure)
    expect(r.wraps).toEqual(['e'])
  })

  test('edge through a node that is not its end is reported once per edge-node pair', () => {
    const r = scoreDetailed(doc([text('a', 0, 0), text('b', 300, 0), text('c', 140, 0)], [edge('e', 'a', 'b')]), approxMeasure)
    expect(r.edgeThroughNode).toEqual([['e', 'c']])
  })

  test('child outside its group is reported; child inside is not', () => {
    const group = { id: 'g', type: 'group', x: 0, y: 0, width: 200, height: 200 } as CanvasNode
    const inside = text('in', 10, 10, 50, 50, { 'x-parent': 'g' })
    const outside = text('out', 190, 190, 50, 50, { 'x-parent': 'g' })
    expect(scoreDetailed(doc([group, inside]), approxMeasure).outsideGroup).toEqual([])
    expect(scoreDetailed(doc([group, outside]), approxMeasure).outsideGroup).toEqual(['out'])
  })

  test('two diagonal edges that cross are counted once', () => {
    const nodes = [text('a', 0, 0, 40, 40), text('b', 300, 300, 40, 40), text('c', 300, 0, 40, 40), text('d', 0, 300, 40, 40)]
    const r = scoreDetailed(doc(nodes, [edge('e1', 'a', 'b'), edge('e2', 'c', 'd')]), approxMeasure)
    expect(r.crossings).toBe(1)
  })

  test('edges fanning out from one shared node do not cross', () => {
    const nodes = [text('s', 0, 150, 40, 40), text('a', 300, 0, 40, 40), text('b', 300, 300, 40, 40)]
    const r = scoreDetailed(doc(nodes, [edge('e1', 's', 'a'), edge('e2', 's', 'b')]), approxMeasure)
    expect(r.crossings).toBe(0)
  })

  test('score is floored at 0', () => {
    const nodes = Array.from({ length: 12 }, (_, i) => text(`n${i}`, i, 0))
    expect(scoreDetailed(doc(nodes), approxMeasure).score).toBe(0)
  })
})

describe('score: fixtures', () => {
  test('good fixtures score 100 with no defects', async () => {
    for (const name of ['good-layered', 'good-grouped']) {
      const r = scoreDetailed(await load(name), approxMeasure)
      expect(r.score).toBe(100)
      expect(r.overlaps).toEqual([])
      expect(r.wraps).toEqual([])
      expect(r.edgeThroughNode).toEqual([])
      expect(r.outsideGroup).toEqual([])
      expect(r.crossings).toBe(0)
    }
  })

  test('bad-tight: the label of editor->server overlaps both ends and two labels wrap', async () => {
    const r = scoreDetailed(await load('bad-tight'), approxMeasure)
    expect(r.overlaps).toEqual([
      ['editor', 'e_ref'],
      ['server', 'e_ref'],
    ])
    expect(r.wraps).toEqual(['e_ref', 'e_prompt'])
    expect(r.score).toBe(50)
  })

  test('bad-diagonal: labels overlap each other and a node, and the edges pass through the middle node', async () => {
    const r = scoreDetailed(await load('bad-diagonal'), approxMeasure)
    expect(r.overlaps).toEqual([
      ['bun', 'e_saves'],
      ['bun', 'e_reads'],
      ['e_saves', 'e_reads'],
    ])
    expect(r.edgeThroughNode).toEqual([
      ['e_saves', 'bun'],
      ['e_reads', 'bun'],
    ])
    expect(r.crossings).toBe(1)
    expect(r.score).toBe(36)
  })
})

describe('score: stubs and group title strips', () => {
  test('an elbow with a diagonal segment is a stub; an axis-aligned elbow is not', () => {
    const nodes = [text('a', 0, 0), text('b', 400, 200)]
    const stub = edge('s', 'a', 'b', { fromSide: 'right', toSide: 'left', 'x-route': 'elbow', 'x-points': [{ x: 300, y: 100 }] } as Partial<CanvasEdge>)
    const clean = edge('c', 'a', 'b', { fromSide: 'right', toSide: 'left', 'x-route': 'elbow', 'x-points': [{ x: 300, y: 25 }, { x: 300, y: 225 }] } as Partial<CanvasEdge>)
    expect(scoreDetailed(doc(nodes, [stub]), approxMeasure).stubs).toEqual(['s'])
    expect(scoreDetailed(doc(nodes, [clean]), approxMeasure).stubs).toEqual([])
  })

  test('a plain diagonal edge with no x-points or elbow route is not a stub', () => {
    const r = scoreDetailed(doc([text('a', 0, 0), text('b', 400, 200)], [edge('e', 'a', 'b')]), approxMeasure)
    expect(r.stubs).toEqual([])
  })

  test('a stub costs 5 points', () => {
    const r = scoreDetailed(doc([text('a', 0, 0), text('b', 400, 200)], [edge('s', 'a', 'b', { fromSide: 'right', toSide: 'left', 'x-route': 'elbow', 'x-points': [{ x: 300, y: 100 }] } as Partial<CanvasEdge>)]), approxMeasure)
    expect(r.score).toBe(95)
  })

  test('an edge through a group title text is a through defect on the group label', () => {
    const group = { id: 'g', type: 'group', label: 'Team', x: 0, y: 0, width: 400, height: 300 } as CanvasNode
    const outside = text('v', -60, -150)
    const child = text('c', 40, 200, 160, 64, { 'x-parent': 'g' })
    const r = scoreDetailed(doc([group, outside, child], [edge('e', 'v', 'c')]), approxMeasure)
    expect(r.edgeThroughNode).toEqual([['e', 'g#label']])
  })

  test('an edge that crosses the top band away from the title text is not a defect', () => {
    const group = { id: 'g', type: 'group', label: 'Team', x: 0, y: 0, width: 400, height: 300 } as CanvasNode
    const outside = text('v', 300, -150)
    const child = text('c', 300, 200, 160, 64, { 'x-parent': 'g' })
    const r = scoreDetailed(doc([group, outside, child], [edge('e', 'v', 'c')]), approxMeasure)
    expect(r.edgeThroughNode).toEqual([])
  })

  test('an edge that joins two children of the same group does not hit its title text', () => {
    const group = { id: 'g', type: 'group', label: 'Team', x: 0, y: 0, width: 400, height: 300 } as CanvasNode
    const a = text('a', 40, 0, 100, 64, { 'x-parent': 'g' })
    const b = text('b', 260, 0, 100, 64, { 'x-parent': 'g' })
    const r = scoreDetailed(doc([group, a, b], [edge('e', 'a', 'b')]), approxMeasure)
    expect(r.edgeThroughNode).toEqual([])
  })
})

describe('score: new fixtures for stubs and title strips', () => {
  test('bad-stub: the elbow has a diagonal first segment', async () => {
    const r = scoreDetailed(await load('bad-stub'), approxMeasure)
    expect(r.stubs).toEqual(['e_stub'])
    expect(r.score).toBe(95)
  })

  test('bad-title-strip: the edge crosses the Team title text', async () => {
    const r = scoreDetailed(await load('bad-title-strip'), approxMeasure)
    expect(r.edgeThroughNode).toEqual([['e_band', 'team#label']])
    expect(r.score).toBe(92)
  })
})

describe('score: group border and edge overlap', () => {
  test('two collinear edges sharing more than 8px of run overlap', () => {
    // Ports on a shared side are spread apart, so the overlap here comes from e2's own route running along e1.
    const nodes = [text('a', 0, 0), text('b', 300, 0), text('c', 300, 200), text('d', 0, 200)]
    const e2 = edge('e2', 'd', 'c', { fromSide: 'right', toSide: 'left', 'x-route': 'elbow', 'x-points': [{ x: 120, y: 225 }, { x: 120, y: 25 }, { x: 250, y: 25 }, { x: 250, y: 225 }] } as Partial<CanvasEdge>)
    const r = scoreDetailed(doc(nodes, [edge('e1', 'a', 'b'), e2]), approxMeasure)
    expect(r.edgeOverlap).toEqual([['e1', 'e2']])
    expect(r.score).toBe(90)
  })

  test('overlap within 12px of the shared node is ignored', () => {
    const nodes = [text('a', 0, 0), text('b', 300, 0), text('c', 300, 200)]
    const r = scoreDetailed(doc(nodes, [edge('e1', 'a', 'b'), edge('e2', 'a', 'c', { fromSide: 'right', toSide: 'left', 'x-route': 'elbow', 'x-points': [{ x: 110, y: 25 }, { x: 110, y: 225 }] } as Partial<CanvasEdge>)]), approxMeasure)
    expect(r.edgeOverlap).toEqual([])
  })

  test('a node straddling a group border is a label on border; a contained node is not', () => {
    const group = { id: 'g', type: 'group', x: 0, y: 0, width: 200, height: 200 } as CanvasNode
    const straddle = text('s', 180, 50, 60, 50)
    const inside = text('i', 20, 50, 60, 50)
    expect(scoreDetailed(doc([group, straddle]), approxMeasure).labelOnBorder).toEqual(['s'])
    expect(scoreDetailed(doc([group, inside]), approxMeasure).labelOnBorder).toEqual([])
  })

  test('a child crossing its own parent border is counted once, in outsideGroup', () => {
    const group = { id: 'g', type: 'group', x: 0, y: 0, width: 200, height: 200 } as CanvasNode
    const child = text('c', 180, 50, 60, 50, { 'x-parent': 'g' })
    const r = scoreDetailed(doc([group, child]), approxMeasure)
    expect(r.outsideGroup).toEqual(['c'])
    expect(r.labelOnBorder).toEqual([])
    expect(r.score).toBe(90)
  })

  test('a node crossing a group that is not its parent is a label on border', () => {
    const g1 = { id: 'g1', type: 'group', x: 0, y: 0, width: 200, height: 200 } as CanvasNode
    const g2 = { id: 'g2', type: 'group', x: 300, y: 0, width: 200, height: 200 } as CanvasNode
    const n = text('n', 180, 50, 60, 50, { 'x-parent': 'g2' })
    const r = scoreDetailed(doc([g1, g2, n]), approxMeasure)
    expect(r.labelOnBorder).toEqual(['n'])
  })

  test('a segment within 6px of and parallel to a border for more than 24px is an edge on border', () => {
    const group = { id: 'g', type: 'group', x: 200, y: 0, width: 400, height: 300 } as CanvasNode
    const a = text('a', 0, 40, 120, 64)
    const b = text('b', 240, 200, 160, 64, { 'x-parent': 'g' })
    const along = edge('along', 'a', 'b', { fromSide: 'right', toSide: 'left', 'x-route': 'elbow', 'x-points': [{ x: 203, y: 72 }, { x: 203, y: 232 }] } as Partial<CanvasEdge>)
    expect(scoreDetailed(doc([group, a, b], [along]), approxMeasure).edgeOnBorder).toEqual(['along'])
    const away = edge('away', 'a', 'b', { fromSide: 'right', toSide: 'left', 'x-route': 'elbow', 'x-points': [{ x: 260, y: 72 }, { x: 260, y: 232 }] } as Partial<CanvasEdge>)
    expect(scoreDetailed(doc([group, a, b], [away]), approxMeasure).edgeOnBorder).toEqual([])
  })
})

describe('score: new fixtures', () => {
  test('bad-edge-overlap: an elbow route runs along the direct edge', async () => {
    const r = scoreDetailed(await load('bad-edge-overlap'), approxMeasure)
    expect(r.edgeOverlap).toEqual([['e_direct', 'e_elbow']])
    expect(r.score).toBe(90)
  })

  test('bad-label-border: the handoff label straddles the Team border', async () => {
    const r = scoreDetailed(await load('bad-label-border'), approxMeasure)
    expect(r.labelOnBorder).toEqual(['e_handoff'])
    expect(r.score).toBe(90)
  })

  test('bad-edge-border: the elbow runs along the Core left border', async () => {
    const r = scoreDetailed(await load('bad-edge-border'), approxMeasure)
    expect(r.edgeOnBorder).toEqual(['e_run'])
    expect(r.score).toBe(90)
  })
})
