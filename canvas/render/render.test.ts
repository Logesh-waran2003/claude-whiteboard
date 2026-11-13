import { describe, expect, test } from 'bun:test'
import { edgePath } from '../core/geometry'
import { approxMeasure } from '../core/measure'
import type { CanvasDoc, CanvasNode } from '../core/model'
import { fitCamera, panBy, toScreen, toWorld, viewportOf, zoomAt } from './camera'
import { buildScene, cull, hitTest, marqueeSelect, moveRoots, movingSet, previewDoc, resizeRect } from './scene'
import { wrapText } from './style'

const node = (id: string, x: number, y: number, w = 100, h = 50, extra: Partial<CanvasNode> = {}) =>
  ({ id, type: 'text', text: id, x, y, width: w, height: h, ...extra }) as CanvasNode

const doc: CanvasDoc = {
  nodes: [
    { id: 'g', type: 'group', label: 'G', x: 0, y: 0, width: 400, height: 300 },
    node('a', 40, 60, 100, 50, { 'x-parent': 'g' }),
    node('b', 240, 60, 100, 50, { 'x-parent': 'g' }),
    node('c', 600, 60),
  ],
  edges: [{ id: 'e', fromNode: 'b', toNode: 'c' }],
}
const scene = buildScene(doc)

describe('camera', () => {
  test('world <-> screen round trip', () => {
    const cam = { x: 100, y: -50, zoom: 2 }
    expect(toWorld(cam, toScreen(cam, { x: 7, y: 9 }))).toEqual({ x: 7, y: 9 })
  })
  test('zoomAt keeps the point under the cursor fixed and clamps', () => {
    const cam = { x: 10, y: 20, zoom: 1 }
    const at = { x: 300, y: 200 }
    const before = toWorld(cam, at)
    const z = zoomAt(cam, at, 2.5)
    expect(toWorld(z, at).x).toBeCloseTo(before.x)
    expect(toWorld(z, at).y).toBeCloseTo(before.y)
    expect(zoomAt(cam, at, 99).zoom).toBe(4)
    expect(zoomAt(cam, at, 0.001).zoom).toBe(0.1)
  })
  test('pan moves by screen px / zoom', () => {
    expect(panBy({ x: 0, y: 0, zoom: 2 }, 100, -40)).toEqual({ x: 50, y: -20, zoom: 2 })
  })
  test('fit centres bounds and caps zoom at 1', () => {
    const size = { width: 1000, height: 800 }
    const big = fitCamera({ x: 0, y: 0, width: 4000, height: 1000 }, size, 50)
    expect(big.zoom).toBeCloseTo(900 / 4000)
    const vp = viewportOf(big, size)
    expect(vp.x + vp.width / 2).toBeCloseTo(2000)
    expect(fitCamera({ x: 0, y: 0, width: 10, height: 10 }, size).zoom).toBe(1)
  })
})

describe('hit testing', () => {
  test('node inside a group wins over the group', () => {
    expect(hitTest(scene, { x: 50, y: 70 })).toBe('a')
  })
  test('group background and label select the group', () => {
    expect(hitTest(scene, { x: 10, y: 10 })).toBe('g')
    expect(hitTest(scene, { x: 200, y: 250 })).toBe('g')
  })
  test('edge within tolerance, empty space misses', () => {
    expect(hitTest(scene, { x: 450, y: 87 })).toBe('e')
    expect(hitTest(scene, { x: 450, y: 120 })).toBeUndefined()
  })
})

describe('marquee', () => {
  test('selects only fully contained nodes', () => {
    expect(marqueeSelect(doc, { x: 30, y: 50, width: 330, height: 70 })).toEqual(['a', 'b'])
    expect(marqueeSelect(doc, { x: 30, y: 50, width: 100, height: 70 })).toEqual([])
    expect(marqueeSelect(doc, { x: -10, y: -10, width: 1000, height: 500 })).toEqual(['g', 'a', 'b', 'c'])
  })
})

describe('move', () => {
  const byId = scene.byId
  test('children of a selected group are not moved twice', () => {
    expect(moveRoots(byId, ['a', 'g', 'c'])).toEqual(['g', 'c'])
  })
  test('moving a group previews its children too; other nodes keep identity', () => {
    const moved = movingSet(doc, ['g'])
    expect([...moved].sort()).toEqual(['a', 'b', 'g'])
    const p = previewDoc(doc, moved, 10, 5)
    expect(p.nodes[1]).toMatchObject({ x: 50, y: 65 })
    expect(p.nodes[3]).toBe(doc.nodes[3])
  })
  test('edge geometry is reused when its ends keep identity', () => {
    const next = buildScene(previewDoc(doc, new Set(['a']), 10, 0), scene)
    expect(next.edges[0]).toBe(scene.edges[0])
    const moved = buildScene(previewDoc(doc, new Set(['c']), 10, 0), scene)
    expect(moved.edges[0]).not.toBe(scene.edges[0])
  })
})

describe('resize', () => {
  const r = { x: 100, y: 100, width: 200, height: 100 }
  test('se grows, nw keeps the opposite corner', () => {
    expect(resizeRect(r, 'se', 50, 20)).toEqual({ x: 100, y: 100, width: 250, height: 120 })
    expect(resizeRect(r, 'nw', 30, 10)).toEqual({ x: 130, y: 110, width: 170, height: 90 })
  })
  test('min size 40x24 holds the fixed side', () => {
    expect(resizeRect(r, 'w', 500, 0)).toEqual({ x: 260, y: 100, width: 40, height: 100 })
    expect(resizeRect(r, 'n', 0, 500)).toEqual({ x: 100, y: 176, width: 200, height: 24 })
  })
  test('shift keeps the ratio', () => {
    const out = resizeRect(r, 'se', 100, 0, true)
    expect(out).toEqual({ x: 100, y: 100, width: 300, height: 150 })
    const side = resizeRect(r, 'e', 100, 0, true)
    expect(side.width / side.height).toBeCloseTo(2)
  })
})

describe('culling', () => {
  test('only items near the viewport', () => {
    const v = cull(scene, { x: 0, y: 0, width: 200, height: 200 }, 0)
    expect(v.nodes.map((n) => n.id)).toEqual(['g', 'a'])
    expect(v.edges).toEqual([])
    const far = cull(scene, { x: 450, y: 0, width: 300, height: 200 }, 0)
    expect(far.nodes.map((n) => n.id)).toEqual(['c'])
    expect(far.edges.map((e) => e.edge.id)).toEqual(['e'])
  })
})

describe('text', () => {
  test('wrapped lines match the height measure computes', () => {
    const text = 'Agents and the user edit the same board, with one undo stack.'
    const lines = wrapText(text, approxMeasure, 16, 168)
    const h = approxMeasure(text, { fontSize: 16, maxWidth: 168 }).height
    expect(lines.length).toBe(Math.round(h / (16 * 1.35)))
    expect(lines.length).toBeGreaterThan(1)
  })
})

// ---------------------------------------------------------------- M3: create, connect, re-parent, paste, elbow

import { createBoard } from '../core/board'
import { TYPE } from '../core/model'
import { DEFAULT_SIZE, connectOps, copyPayload, createOp, createRect, parsePayload, pasteOps, reparentOps } from './ops'
import { elbowPath, groupAt } from './scene'

describe('create at point', () => {
  test('click = default size from TYPE centred on the point', () => {
    expect(createRect('rect', { x: 100, y: 100 })).toEqual({ x: 20, y: 68, width: TYPE.minNode.width, height: TYPE.minNode.height })
    expect(createRect('sticky', { x: 0, y: 0 })).toEqual({ x: -100, y: -100, width: 200, height: 200 })
    expect(DEFAULT_SIZE.ellipse.width).toBeGreaterThan(TYPE.minNode.width)
  })
  test('a tiny drag is still a click; a real drag gives that box with min 40x24', () => {
    expect(createRect('rect', { x: 0, y: 0 }, { x: 3, y: 2 }).width).toBe(TYPE.minNode.width)
    expect(createRect('rect', { x: 50, y: 50 }, { x: 10, y: 20 })).toEqual({ x: 10, y: 20, width: 40, height: 30 })
    expect(createRect('rect', { x: 0, y: 0 }, { x: 300, y: 10 })).toEqual({ x: 0, y: 0, width: 300, height: 24 })
  })
  test('created inside a group gets that group as parent', () => {
    expect(createOp(doc, 'rect', { x: 150, y: 150, width: 40, height: 40 })).toMatchObject({ op: 'add_node', kind: 'rect', parent: 'g' })
    expect(createOp(doc, 'rect', { x: 800, y: 800, width: 40, height: 40 })).not.toHaveProperty('parent')
  })
})

describe('connect', () => {
  test('to an existing node: edge with sides', () => {
    const { ops, newNode } = connectOps(doc, doc.nodes[1], 'right', doc.nodes[3], { x: 0, y: 0 })
    expect(newNode).toBeUndefined()
    expect(ops).toEqual([{ op: 'add_edge', ref: 'edge', from: 'a', to: 'c', fromSide: 'right', toSide: 'left' }])
  })
  test('to empty canvas: new rect at the point, then the edge (valid on the real store)', () => {
    const b = createBoard(doc)
    const { ops, newNode } = connectOps(doc, doc.nodes[3], 'bottom', undefined, { x: 650, y: 400 })
    const res = b.apply(ops, { by: 'user' })
    expect(res.ok).toBe(true)
    if (!res.ok) return
    const id = res.ids[newNode!]
    expect(b.doc.nodes.find((n) => n.id === id)).toMatchObject({ x: 570, y: 368, width: 160 })
    expect(b.doc.edges.at(-1)).toMatchObject({ fromNode: 'c', toNode: id, fromSide: 'bottom', toSide: 'top' })
  })
})

describe('re-parent on drop', () => {
  test('centre ends inside a group -> parent; outside all groups -> ""; same group -> no op', () => {
    expect(reparentOps(doc, ['c'], -500, 0)).toEqual([{ op: 'update', id: 'c', parent: 'g' }])
    expect(reparentOps(doc, ['a'], 0, 400)).toEqual([{ op: 'update', id: 'a', parent: '' }])
    expect(reparentOps(doc, ['a'], 20, 20)).toEqual([])
  })
  test('a moved group never parents itself or its children', () => {
    expect(reparentOps(doc, ['g'], 10, 10)).toEqual([])
  })
  test('move + reparent is one valid batch (one undo step) on the real store', () => {
    const b = createBoard(doc)
    const res = b.apply([{ op: 'move', ids: ['c'], dx: -500, dy: 0 }, ...reparentOps(doc, ['c'], -500, 0)], { by: 'user' })
    expect(res.ok).toBe(true)
    expect(b.doc.nodes.find((n) => n.id === 'c')).toMatchObject({ x: 100, 'x-parent': 'g' })
    b.undo()
    expect(b.doc.nodes.find((n) => n.id === 'c')).toMatchObject({ x: 600 })
    expect(b.doc.nodes.find((n) => n.id === 'c')).not.toHaveProperty('x-parent')
  })
})

describe('copy / paste', () => {
  test('copying a group takes its children and internal edges only', () => {
    const p = copyPayload(doc, ['g'])
    expect(p.nodes.map((n) => n.id)).toEqual(['g', 'a', 'b'])
    expect(p.edges).toEqual([])
    expect(copyPayload(doc, ['b', 'c']).edges.map((e) => e.id)).toEqual(['e'])
  })
  test('paste remaps ids, parents and edge ends to the new copies, offset applied', () => {
    const b = createBoard(doc)
    const payload = parsePayload(JSON.stringify(copyPayload(doc, ['g', 'c'])))!
    const { ops, refs } = pasteOps(payload, doc, 24)
    const res = b.apply(ops, { by: 'user' })
    expect(res.ok).toBe(true)
    if (!res.ok) return
    const id = (old: string) => res.ids[`p:${old}`]
    expect(refs.length).toBe(5)
    expect(new Set([id('g'), id('a'), id('b'), id('c')]).size).toBe(4)
    expect(b.doc.nodes.find((n) => n.id === id('a'))).toMatchObject({ x: 64, y: 84, 'x-parent': id('g'), text: 'a' })
    expect(b.doc.edges.find((e) => e.id === res.ids['p:e'])).toMatchObject({ fromNode: id('b'), toNode: id('c') })
    expect(b.doc.nodes.length).toBe(8)
  })
  test('a pasted child whose group was not copied stays in the original group', () => {
    const { ops } = pasteOps(copyPayload(doc, ['a']), doc, 24)
    expect(ops[0]).toMatchObject({ op: 'add_node', parent: 'g', x: 64 })
  })
  test('non-canvas clipboard text is ignored', () => {
    expect(parsePayload('hello')).toBeUndefined()
    expect(parsePayload('{"nodes":[]}')).toBeUndefined()
  })
})

describe('elbow fallback and label background', () => {
  test('horizontal sides: horizontal-vertical-horizontal through the mid x', () => {
    expect(elbowPath({ x: 0, y: 0 }, 'right', { x: 100, y: 50 }, 'left')).toEqual([
      { x: 0, y: 0 },
      { x: 50, y: 0 },
      { x: 50, y: 50 },
      { x: 100, y: 50 },
    ])
  })
  test('vertical sides use mid y; mixed sides bend once; aligned ends stay straight', () => {
    expect(elbowPath({ x: 0, y: 0 }, 'bottom', { x: 100, y: 80 }, 'top')[1]).toEqual({ x: 0, y: 40 })
    expect(elbowPath({ x: 0, y: 0 }, 'right', { x: 100, y: 80 }, 'top')).toEqual([{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 80 }])
    expect(elbowPath({ x: 0, y: 0 }, 'right', { x: 100, y: 0 }, 'left')).toHaveLength(2)
  })
  test('scene uses the fallback for elbow edges without x-points, and finds the label group', () => {
    const d: CanvasDoc = {
      nodes: [...doc.nodes.slice(0, 2), node('d', 240, 200)].map((n) => ({ ...n, 'x-parent': n.id === 'g' ? undefined : 'g' })) as CanvasNode[],
      edges: [{ id: 'x', fromNode: 'a', toNode: 'd', 'x-route': 'elbow', label: 'go' }],
    }
    const s = buildScene(d)
    expect(s.edges[0].path.length).toBe(4)
    expect(s.edges[0].labelGroup?.id).toBe('g')
    expect(groupAt(d, { x: 1000, y: 1000 })).toBeUndefined()
  })
})

describe('edges follow core edgePath', () => {
  test('adding an edge on the same side re-spreads the ports of the edges already there', () => {
    const d1: CanvasDoc = { nodes: [node('p', 0, 0), node('q', 300, -100), node('r', 300, 100)], edges: [{ id: 'e1', fromNode: 'p', toNode: 'q' }] }
    const s1 = buildScene(d1)
    const d2: CanvasDoc = { ...d1, edges: [...d1.edges, { id: 'e2', fromNode: 'p', toNode: 'r' }] }
    const s2 = buildScene(d2, s1)
    for (const g of s2.edges) expect(g.path).toEqual(edgePath(d2, g.edge)!)
    expect(s2.edges[0].path[0]).not.toEqual(s1.edges[0].path[0])
    const s3 = buildScene({ ...d1 }, s2) // removing e2 moves e1 back to the side midpoint
    expect(s3.edges[0].path).toEqual(edgePath(d1, d1.edges[0])!)
  })
  test('the elbow fallback starts and ends at the core port points', () => {
    const d: CanvasDoc = {
      nodes: [node('p', 0, 0), node('q', 300, 100), node('r', 300, 200)],
      edges: [
        { id: 'e1', fromNode: 'p', toNode: 'q', 'x-route': 'elbow' },
        { id: 'e2', fromNode: 'p', toNode: 'r', 'x-route': 'elbow' },
      ],
    }
    const s = buildScene(d)
    for (const g of s.edges) {
      const core = edgePath(d, g.edge)!
      expect(g.path[0]).toEqual(core[0])
      expect(g.path.at(-1)).toEqual(core.at(-1)!)
    }
  })
})
