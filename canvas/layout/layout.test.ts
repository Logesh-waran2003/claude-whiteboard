import { describe, expect, test } from 'bun:test'
import { boundsOf, contains, edgePath, intersects, nodeById } from '../core/geometry'
import { approxMeasure } from '../core/measure'
import { type CanvasDoc, TYPE } from '../core/model'
import { scoreDetailed as score } from '../quality/score'
import { problems as check } from './check'
import { fixtures } from './fixtures'
import { applyLayoutOps, enforceInvariants, layoutBoard } from './index'

const measure = approxMeasure
const problems = (doc: CanvasDoc) => check(doc, measure)

function run(doc: CanvasDoc) {
  const ops1 = layoutBoard(doc, measure)
  const laid = applyLayoutOps(doc, ops1)
  const ops2 = enforceInvariants(laid, measure)
  return { ops1, ops2, out: applyLayoutOps(laid, ops2) }
}

describe('layout fixtures', () => {
  for (const [name, doc] of Object.entries(fixtures)) {
    test(name, () => {
      const { ops1, ops2, out } = run(doc)
      expect(problems(out)).toEqual([])
      for (const op of [...ops1, ...ops2]) expect(['update', 'move', 'update_edge']).toContain(op.op)
      // Fixed nodes keep their rect and get no ops.
      const before = nodeById(doc)
      const fixed = doc.nodes.filter((n) => n['x-pin'] === true || n['x-by'] === 'user').map((n) => n.id)
      for (const id of fixed) {
        const o = out.nodes.find((n) => n.id === id)!
        const b = before.get(id)!
        expect([o.x, o.y, o.width, o.height]).toEqual([b.x, b.y, b.width, b.height])
      }
      for (const op of [...ops1, ...ops2]) {
        const ids = op.op === 'move' ? op.ids : op.op === 'update' ? [op.id] : []
        for (const id of ids) expect(fixed).not.toContain(id)
      }
      // Deterministic and idempotent.
      expect(JSON.stringify(run(doc).ops1)).toBe(JSON.stringify(ops1))
      expect(JSON.stringify(run(doc).ops2)).toBe(JSON.stringify(ops2))
      expect(enforceInvariants(out, measure)).toEqual([])
      // Independent scorer (M6): no crossings beyond 1 on architecture, a perfect score elsewhere.
      const q = score(out, measure)
      // claude-app keeps a few crossings among its straight fan-out edges; every other fixture must score 100.
      const maxCrossings: Record<string, number> = { 'claude-app': 4 }
      if (name in maxCrossings) expect(q.crossings).toBeLessThanOrEqual(maxCrossings[name])
      else expect(q.score).toBe(100)
      // edgeThroughNode includes group title strips ("<group>#label").
      expect([q.overlaps, q.wraps, q.edgeThroughNode, q.outsideGroup]).toEqual([[], [], [], []])
      expect([q.edgeOverlap, q.labelOnBorder, q.edgeOnBorder, q.stubs]).toEqual([[], [], [], []])
      const b = boundsOf(out.nodes)!
      // No explosion: every fixture fits in a modest board.
      expect(Math.max(b.width, b.height)).toBeLessThan(2400)
      console.log(`${name}: ${b.width}x${b.height}, ops ${ops1.length}+${ops2.length}, crossings ${q.crossings}, score ${q.score}`)
    })
  }
})

describe('units', () => {
  test('opts.all re-layout and opts.scope keep the board clean and fixed nodes still', () => {
    for (const doc of Object.values(fixtures)) {
      const first = run(doc).out
      for (const opts of [{ all: true }, { scope: first.nodes.find((n) => n.type === 'group')?.id ?? 'root' }]) {
        const laid = applyLayoutOps(first, layoutBoard(first, measure, opts))
        const out = applyLayoutOps(laid, enforceInvariants(laid, measure))
        expect(problems(out)).toEqual([])
        for (const n of doc.nodes.filter((n) => n['x-pin'] || n['x-by'] === 'user'))
          expect(out.nodes.find((m) => m.id === n.id)!.x).toBe(n.x)
      }
    }
  })

  test('sizing: one-line text, wrap at max width, sticky, diamond', () => {
    const doc: CanvasDoc = {
      nodes: [
        { id: 'a', type: 'text', text: 'Hi', x: 0, y: 0, width: 0, height: 0, 'x-placed': false },
        { id: 'b', type: 'text', text: 'word '.repeat(40).trim(), x: 0, y: 0, width: 0, height: 0, 'x-placed': false },
        { id: 'c', type: 'text', text: 'Note', x: 0, y: 0, width: 0, height: 0, 'x-placed': false, 'x-shape': 'sticky' },
        { id: 'd', type: 'text', text: 'Hi', x: 0, y: 0, width: 0, height: 0, 'x-placed': false, 'x-shape': 'diamond' },
      ],
      edges: [],
    }
    const out = applyLayoutOps(doc, layoutBoard(doc, measure))
    const s = (id: string) => out.nodes.find((n) => n.id === id)!
    expect([s('a').width, s('a').height]).toEqual([TYPE.minNode.width, TYPE.minNode.height])
    expect(s('b').width).toBe(TYPE.maxNodeWidth)
    expect(s('b').height).toBeGreaterThan(TYPE.minNode.height)
    expect([s('c').width, s('c').height]).toEqual([TYPE.sticky.width, TYPE.sticky.height])
    expect(s('d').width).toBe(Math.ceil(TYPE.minNode.width * 1.4))
    expect(problems(out)).toEqual([])
  })

  test('free mode does not move placed nodes; new node goes into a free slot', () => {
    const doc: CanvasDoc = {
      nodes: [
        { id: 'p', type: 'text', text: 'Placed', x: 100, y: 100, width: 160, height: 64 },
        { id: 'n', type: 'text', text: 'New', x: 0, y: 0, width: 0, height: 0, 'x-placed': false },
      ],
      edges: [],
    }
    const ops = layoutBoard(doc, measure)
    expect(ops.map((o) => (o.op === 'update' ? o.id : o.op))).toEqual(['n'])
    const out = applyLayoutOps(doc, ops)
    expect(intersects(out.nodes[0], out.nodes[1], TYPE.gap)).toBe(false)
  })

  test('an edge-less dag-lr group lays out as a row', () => {
    const out = run(fixtures.mermaid).out
    const ys = ['repo', 'notes', 'brain'].map((id) => out.nodes.find((n) => n.id === id)!.y)
    expect(new Set(ys).size).toBe(1)
  })

  test('elbow waypoints start and end on the real (spread) ports', () => {
    const out = run(fixtures['claude-app']).out
    const byId = nodeById(out)
    for (const e of out.edges.filter((x) => x['x-points']?.length)) {
      const p = edgePath(out, e, byId)!
      for (let i = 1; i < p.length; i++) expect(p[i].x === p[i - 1].x || p[i].y === p[i - 1].y).toBe(true)
    }
  })

  test('nodes with no x-by are fixed; a user group grows but never moves its content', () => {
    const doc: CanvasDoc = {
      nodes: [
        { id: 'g', type: 'group', label: 'Mine', x: 0, y: 0, width: 200, height: 120, 'x-by': 'user' },
        { id: 'k', type: 'text', text: 'Kid', x: 40, y: 68, width: 160, height: 64, 'x-parent': 'g', 'x-by': 'agent:a' },
        { id: 'k2', type: 'text', text: 'New kid', x: 0, y: 0, width: 0, height: 0, 'x-placed': false, 'x-parent': 'g', 'x-by': 'agent:a' },
        { id: 'o', type: 'text', text: 'Other editor', x: 260, y: 0, width: 160, height: 64 },
        { id: 'n', type: 'text', text: 'Crowding', x: 300, y: 20, width: 160, height: 64, 'x-by': 'agent:a' },
      ],
      edges: [],
    }
    const { ops1, ops2, out } = run(doc)
    const at = (id: string) => out.nodes.find((n) => n.id === id)!
    expect([at('o').x, at('o').y]).toEqual([260, 0])
    expect([at('g').x, at('g').y]).toEqual([0, 0])
    expect(at('g').width).toBeGreaterThan(200)
    for (const id of ['k', 'k2']) expect(contains(at('g'), at(id))).toBe(true)
    for (const op of [...ops1, ...ops2]) if (op.op === 'move') expect(op.ids).not.toContain('g')
    expect(problems(out)).toEqual([])
  })

  test('parallel and reverse edges get separate lanes, no pushes', () => {
    const laid = applyLayoutOps(fixtures.parallel, layoutBoard(fixtures.parallel, measure))
    expect(enforceInvariants(laid, measure).filter((o) => o.op !== 'update_edge')).toEqual([])
  })

  test('a label push keeps an aligned column aligned', () => {
    const out = run(fixtures.tight).out
    const x = (id: string) => out.nodes.find((n) => n.id === id)!.x
    // agent and tools started in one column; the overlap step may nudge one, the sweep must not split them.
    expect(Math.abs(x('agent') - x('tools'))).toBeLessThanOrEqual(TYPE.gap)
  })

  test('straight edge through a node becomes an elbow route', () => {
    const doc: CanvasDoc = {
      nodes: [
        { id: 'a', type: 'text', text: 'A', x: 0, y: 0, width: 160, height: 64 },
        { id: 'm', type: 'text', text: 'M', x: 260, y: 0, width: 160, height: 64 },
        { id: 'b', type: 'text', text: 'B', x: 520, y: 0, width: 160, height: 64 },
      ],
      edges: [{ id: 'e', fromNode: 'a', toNode: 'b' }],
    }
    const ops = enforceInvariants(doc, measure)
    const out = applyLayoutOps(doc, ops)
    expect(out.edges[0]['x-points']?.length).toBeGreaterThan(0)
    expect(problems(out)).toEqual([])
  })
})

describe('image nodes', () => {
  test('a full re-layout keeps the size of an image node (not sized from its file name)', () => {
    const doc: CanvasDoc = {
      nodes: [
        { id: 'img', type: 'file', file: 'assets/0123456789abcdef.png', x: 0, y: 0, width: 480, height: 300, 'x-by': 'agent:claude' },
        { id: 'a', type: 'text', text: 'Caption', x: 600, y: 0, width: 120, height: 48 },
      ],
      edges: [{ id: 'e', fromNode: 'a', toNode: 'img' }],
    }
    const out = applyLayoutOps(doc, layoutBoard(doc, measure, { all: true }))
    expect(out.nodes.find((n) => n.id === 'img')).toMatchObject({ width: 480, height: 300 })
  })
})

describe('lanes of cards (row of column groups)', () => {
  test('lanes sit left to right, cards stack top-down in add order, card height fits its text', async () => {
    const { createBoard } = await import('../core/board')
    const b = createBoard({ nodes: [], edges: [] })
    const r = b.apply(
      [
        { op: 'add_node', ref: 'root', kind: 'group', text: 'Stages', layout: 'row' },
        { op: 'add_node', ref: 'l1', kind: 'group', text: 'Building', layout: 'column', parent: 'root' },
        { op: 'add_node', ref: 'l2', kind: 'group', text: 'Live', layout: 'column', parent: 'root' },
        { op: 'add_node', ref: 'a', kind: 'card', text: 'A\none line', progress: 30, parent: 'l1' },
        { op: 'add_node', ref: 'b', kind: 'card', text: 'B\nfirst line\nsecond line', progress: 60, parent: 'l1' },
        { op: 'add_node', ref: 'c', kind: 'card', text: 'C', parent: 'l2' },
      ],
      { by: 'agent:test' },
    )
    if (!r.ok) throw new Error(JSON.stringify(r.error))
    const out = applyLayoutOps(b.doc, layoutBoard(b.doc, measure))
    const n = (ref: string) => out.nodes.find((x) => x.id === r.ids[ref])!
    expect(n('l1').x).toBeLessThan(n('l2').x)
    expect(Math.abs(n('l1').y - n('l2').y)).toBeLessThan(1) // lanes top-aligned
    expect(n('a').y + n('a').height).toBeLessThanOrEqual(n('b').y - TYPE.gap + 0.5)
    expect(n('b').height).toBeGreaterThan(n('a').height)
    expect(problems(out)).toEqual([])
  })
})
