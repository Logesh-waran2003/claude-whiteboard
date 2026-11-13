import { describe, expect, test } from 'bun:test'
import { Board, createBoard, fromJSON } from './board'
import { TYPE, type ApplyFail, type ApplyOptions, type CanvasDoc, type Op, type OpError } from './model'

const U = { by: 'user' }
const A = { by: 'agent:test' }

function ok(b: Board, ops: Op[], opts: ApplyOptions = A) {
  const r = b.apply(ops, opts)
  if (!r.ok) throw new Error(JSON.stringify(r.error))
  return r
}
function err(b: Board, ops: unknown[], opts: ApplyOptions = A): OpError {
  const before = b.doc
  const v = b.version
  const r = b.apply(ops as Op[], opts)
  expect(r.ok).toBe(false)
  expect(b.doc).toBe(before) // atomic: same object
  expect(b.version).toBe(v)
  return (r as ApplyFail).error as OpError
}
const node = (b: Board, id: string) => b.doc.nodes.find((n) => n.id === id)! as Record<string, unknown>
const edge = (b: Board, id: string) => b.doc.edges.find((e) => e.id === id)! as Record<string, unknown>

describe('add_node', () => {
  test('defaults, refs, x-by, x-placed', () => {
    const b = createBoard()
    const r = ok(b, [
      { op: 'add_node', ref: 'a', text: 'A' },
      { op: 'add_node', ref: 's', kind: 'sticky', x: 10, y: 20 },
      { op: 'add_edge', ref: 'e', from: 'a', to: 's' },
    ])
    expect(r.version).toBe(1)
    expect(Object.keys(r.ids).sort()).toEqual(['a', 'e', 's'])
    expect(r.ids.a).toMatch(/^[0-9a-z]{8}$/)
    const a = node(b, r.ids.a)
    expect(a).toMatchObject({ type: 'text', text: 'A', x: 0, y: 0, ...TYPE.minNode, 'x-shape': 'rect', 'x-by': 'agent:test', 'x-placed': false })
    expect(node(b, r.ids.s)).toMatchObject({ x: 10, y: 20, ...TYPE.sticky, 'x-shape': 'sticky' })
    expect('x-placed' in node(b, r.ids.s)).toBe(false)
    expect(edge(b, r.ids.e)).toMatchObject({ fromNode: r.ids.a, toNode: r.ids.s, toEnd: 'arrow', 'x-by': 'agent:test' })
  })

  test('group, file, link, parent, role, pin, color', () => {
    const b = createBoard()
    const r = ok(b, [
      { op: 'add_node', ref: 'g', kind: 'group', text: 'G', layout: 'grid' },
      { op: 'add_node', ref: 'f', file: 'a.md', parent: 'g', role: 'doc', pin: true, color: '3' },
      { op: 'add_node', ref: 'l', url: 'https://x.y', kind: 'ellipse', color: '#aabbcc' },
    ])
    expect(node(b, r.ids.g)).toMatchObject({ type: 'group', label: 'G', 'x-layout': 'grid' })
    expect(node(b, r.ids.f)).toMatchObject({ type: 'file', file: 'a.md', 'x-parent': r.ids.g, 'x-role': 'doc', 'x-pin': true, color: '3' })
    expect(node(b, r.ids.l)).toMatchObject({ type: 'link', url: 'https://x.y', 'x-shape': 'ellipse', color: '#aabbcc' })
  })

  test('new groups go after the last group, others to the end', () => {
    const b = createBoard()
    const r = ok(b, [
      { op: 'add_node', ref: 'g1', kind: 'group' },
      { op: 'add_node', ref: 'n1' },
      { op: 'add_node', ref: 'g2', kind: 'group' },
      { op: 'add_node', ref: 'n2' },
    ])
    expect(b.doc.nodes.map((n) => n.id)).toEqual([r.ids.g1, r.ids.g2, r.ids.n1, r.ids.n2])
  })

  test('explicit id; duplicate id and duplicate ref fail', () => {
    const b = createBoard()
    ok(b, [{ op: 'add_node', id: 'n1' }])
    expect(err(b, [{ op: 'add_node', id: 'n1' }])).toMatchObject({ opIndex: 0, field: 'id' })
    expect(err(b, [{ op: 'add_node', ref: 'r' }, { op: 'add_node', ref: 'r' }])).toMatchObject({ opIndex: 1, field: 'ref' })
    expect(err(b, [{ op: 'add_node', id: 'root' }])).toMatchObject({ field: 'id' })
  })

  test('arrow variants and route', () => {
    const b = createBoard()
    ok(b, [{ op: 'add_node', id: 'a' }, { op: 'add_node', id: 'b' }])
    ok(b, [
      { op: 'add_edge', id: 'e1', from: 'a', to: 'b', arrow: 'none' },
      { op: 'add_edge', id: 'e2', from: 'a', to: 'b', arrow: 'both', route: 'elbow', label: 'L' },
    ])
    expect(edge(b, 'e1').toEnd).toBe('none')
    expect(edge(b, 'e2')).toMatchObject({ fromEnd: 'arrow', toEnd: 'arrow', 'x-route': 'elbow', label: 'L' })
  })
})

describe('validation errors', () => {
  const b = createBoard()
  ok(b, [{ op: 'add_node', id: 'a' }, { op: 'add_node', id: 'g', kind: 'group' }, { op: 'add_edge', id: 'e', from: 'a', to: 'g' }])
  const cases: [string, unknown[], Partial<OpError>][] = [
    ['unknown op', [{ op: 'explode' }], { field: 'op' }],
    ['op not object', [42], { opIndex: 0 }],
    ['unknown field', [{ op: 'add_node', colour: '1' }], { field: 'colour' }],
    ['bad kind', [{ op: 'add_node', kind: 'star' }], { field: 'kind' }],
    ['NaN x', [{ op: 'add_node', x: NaN }], { field: 'x' }],
    ['Infinity y', [{ op: 'add_node', y: Infinity }], { field: 'y' }],
    ['string x', [{ op: 'add_node', x: '5' }], { field: 'x' }],
    ['zero width', [{ op: 'add_node', width: 0 }], { field: 'width' }],
    ['negative height', [{ op: 'add_node', height: -1 }], { field: 'height' }],
    ['text not string', [{ op: 'add_node', text: 5 }], { field: 'text' }],
    ['pin not bool', [{ op: 'add_node', pin: 'yes' }], { field: 'pin' }],
    ['bad layout', [{ op: 'add_node', kind: 'group', layout: 'tree' }], { field: 'layout' }],
    ['layout on non-group', [{ op: 'add_node', layout: 'grid' }], { field: 'layout' }],
    ['file and url', [{ op: 'add_node', file: 'a', url: 'b' }], { field: 'url' }],
    ['group with file', [{ op: 'add_node', kind: 'group', file: 'a' }], { field: 'file' }],
    ['parent missing', [{ op: 'add_node', parent: 'nope' }], { field: 'parent' }],
    ['parent not group', [{ op: 'add_node', parent: 'a' }], { field: 'parent' }],
    ['edge from missing', [{ op: 'add_edge', from: 'nope', to: 'a' }], { field: 'from' }],
    ['edge to an edge', [{ op: 'add_edge', from: 'a', to: 'e' }], { field: 'to' }],
    ['edge from required', [{ op: 'add_edge', to: 'a' }], { field: 'from' }],
    ['bad arrow', [{ op: 'add_edge', from: 'a', to: 'a', arrow: 'start' }], { field: 'arrow' }],
    ['bad side', [{ op: 'add_edge', from: 'a', to: 'a', fromSide: 'up' }], { field: 'fromSide' }],
    ['bad route', [{ op: 'add_edge', from: 'a', to: 'a', route: 'curvy' }], { field: 'route' }],
    ['update unknown id', [{ op: 'update', id: 'nope', x: 1 }], { field: 'id' }],
    ['update kind group->rect', [{ op: 'update', id: 'g', kind: 'rect' }], { field: 'kind' }],
    ['update kind rect->group', [{ op: 'update', id: 'a', kind: 'group' }], { field: 'kind' }],
    ['update file on text node', [{ op: 'update', id: 'a', file: 'x' }], { field: 'file' }],
    ['update layout on non-group', [{ op: 'update', id: 'a', layout: 'grid' }], { field: 'layout' }],
    ['parent self cycle', [{ op: 'update', id: 'g', parent: 'g' }], { field: 'parent' }],
    ['update_edge on node', [{ op: 'update_edge', id: 'a', label: 'x' }], { field: 'id' }],
    ['update_edge bad points', [{ op: 'update_edge', id: 'e', points: [{ x: 1 }] }], { field: 'points[0]' }],
    ['update_edge points not array', [{ op: 'update_edge', id: 'e', points: 'x' }], { field: 'points' }],
    ['move empty ids', [{ op: 'move', ids: [], dx: 1, dy: 1 }], { field: 'ids' }],
    ['move edge id', [{ op: 'move', ids: ['e'], dx: 1, dy: 1 }], { field: 'ids[0]' }],
    ['move missing dx', [{ op: 'move', ids: ['a'], dy: 1 }], { field: 'dx' }],
    ['move id not string', [{ op: 'move', ids: [1], dx: 1, dy: 1 }], { field: 'ids[0]' }],
    ['remove missing', [{ op: 'remove', ids: ['a', 'nope'] }], { field: 'ids[1]' }],
    ['set_layout non-group', [{ op: 'set_layout', group: 'a', layout: 'grid' }], { field: 'group' }],
    ['set_layout bad layout', [{ op: 'set_layout', group: 'root', layout: 'x' }], { field: 'layout' }],
    ['reorder bad to', [{ op: 'reorder', id: 'a', to: 'top' }], { field: 'to' }],
    ['reorder missing', [{ op: 'reorder', id: 'zz', to: 'front' }], { field: 'id' }],
  ]
  for (const [name, ops, expected] of cases) test(name, () => expect(err(b, ops)).toMatchObject(expected))

  test('color message says what is wrong and what is allowed', () => {
    const e = err(b, [{ op: 'add_node', color: 'purple' }])
    expect(e).toEqual({ opIndex: 0, field: 'color', message: 'color "purple" is not valid; use "1".."6" or "#rrggbb"' })
    expect(err(b, [{ op: 'add_node', color: '7' }]).field).toBe('color')
    expect(err(b, [{ op: 'add_node', color: '#abc' }]).field).toBe('color')
  })

  test('parent cycle through nesting', () => {
    const c = createBoard()
    ok(c, [{ op: 'add_node', id: 'g1', kind: 'group' }, { op: 'add_node', id: 'g2', kind: 'group', parent: 'g1' }])
    expect(err(c, [{ op: 'update', id: 'g1', parent: 'g2' }])).toMatchObject({ field: 'parent' })
  })

  test('atomic: later failure undoes earlier ops in the batch', () => {
    const before = b.doc
    const e = err(b, [{ op: 'add_node', ref: 'x' }, { op: 'update', id: 'a', x: 5 }, { op: 'add_edge', from: 'x', to: 'nope' }])
    expect(e.opIndex).toBe(2)
    expect(b.doc).toBe(before)
    expect(b.canRedo()).toBe(false)
  })
})

describe('update / update_edge', () => {
  test('fields, group label, x-placed cleared', () => {
    const b = createBoard()
    ok(b, [{ op: 'add_node', id: 'a' }, { op: 'add_node', id: 'g', kind: 'group' }, { op: 'add_edge', id: 'e', from: 'a', to: 'g' }])
    ok(b, [
      { op: 'update', id: 'a', x: 5, text: 'hi', kind: 'diamond', role: 'svc', pin: true, parent: 'g', width: 300 },
      { op: 'update', id: 'g', text: 'Group', layout: 'dag-lr' },
      { op: 'update_edge', id: 'e', label: 'L', color: '2', route: 'elbow', points: [{ x: 1, y: 2 }], toSide: 'left' },
    ])
    const a = node(b, 'a')
    expect(a).toMatchObject({ x: 5, y: 0, text: 'hi', 'x-shape': 'diamond', 'x-role': 'svc', 'x-pin': true, 'x-parent': 'g', width: 300 })
    expect('x-placed' in a).toBe(false)
    expect(node(b, 'g')).toMatchObject({ label: 'Group', 'x-layout': 'dag-lr' })
    expect(edge(b, 'e')).toMatchObject({ label: 'L', color: '2', 'x-route': 'elbow', 'x-points': [{ x: 1, y: 2 }], toSide: 'left' })
    ok(b, [{ op: 'update', id: 'a', parent: '' }])
    expect('x-parent' in node(b, 'a')).toBe(false)
  })
})

describe('move / remove / set_layout / reorder', () => {
  function nested() {
    const b = createBoard()
    ok(b, [
      { op: 'add_node', id: 'g', kind: 'group', x: 0, y: 0 },
      { op: 'add_node', id: 'g2', kind: 'group', parent: 'g', x: 10, y: 10 },
      { op: 'add_node', id: 'c1', parent: 'g', x: 20, y: 20 },
      { op: 'add_node', id: 'c2', parent: 'g2', x: 30, y: 30 },
      { op: 'add_node', id: 'out', x: 500, y: 500 },
      { op: 'add_edge', id: 'in', from: 'c1', to: 'c2' },
      { op: 'add_edge', id: 'cross', from: 'c1', to: 'out' },
      { op: 'update_edge', id: 'in', points: [{ x: 25, y: 25 }] },
      { op: 'update_edge', id: 'cross', points: [{ x: 100, y: 100 }] },
    ])
    return b
  }

  test('moving a group moves descendants once and shifts inner edge points', () => {
    const b = nested()
    ok(b, [{ op: 'move', ids: ['g', 'c1', 'g'], dx: 5, dy: -5 }])
    expect([node(b, 'g').x, node(b, 'g2').x, node(b, 'c1').x, node(b, 'c2').x, node(b, 'out').x]).toEqual([5, 15, 25, 35, 500])
    expect(node(b, 'c2').y).toBe(25)
    expect(edge(b, 'in')['x-points']).toEqual([{ x: 30, y: 20 }])
    expect(edge(b, 'cross')['x-points']).toEqual([{ x: 100, y: 100 }])
  })

  test('removing a group un-parents direct children; removing a node removes its edges', () => {
    const b = nested()
    ok(b, [{ op: 'remove', ids: ['g'] }])
    expect(node(b, 'g')).toBeUndefined()
    expect('x-parent' in node(b, 'g2')).toBe(false)
    expect('x-parent' in node(b, 'c1')).toBe(false)
    expect(node(b, 'c2')['x-parent']).toBe('g2')
    ok(b, [{ op: 'remove', ids: ['c1'] }])
    expect(b.doc.edges).toEqual([])
    ok(b, [{ op: 'add_edge', id: 'e', from: 'c2', to: 'out' }])
    ok(b, [{ op: 'remove', ids: ['e'] }])
    expect(b.doc.edges).toEqual([])
    expect(b.doc.nodes.length).toBe(3)
  })

  test('set_layout root and group', () => {
    const b = nested()
    ok(b, [{ op: 'set_layout', group: 'root', layout: 'dag-tb' }, { op: 'set_layout', group: 'g2', layout: 'free' }])
    expect(b.doc['x-layout']).toBe('dag-tb')
    expect(node(b, 'g2')['x-layout']).toBe('free')
    expect(b.diffSince(b.version - 1).changed.sort()).toEqual(['g2', 'root'])
  })

  test('reorder keeps groups before non-groups', () => {
    const b = nested() // g, g2, c1, c2, out
    ok(b, [{ op: 'reorder', id: 'out', to: 'back' }])
    expect(b.doc.nodes.map((n) => n.id)).toEqual(['g', 'g2', 'out', 'c1', 'c2'])
    ok(b, [{ op: 'reorder', id: 'out', to: 'front' }])
    expect(b.doc.nodes.map((n) => n.id)).toEqual(['g', 'g2', 'c1', 'c2', 'out'])
    ok(b, [{ op: 'reorder', id: 'g', to: 'front' }])
    expect(b.doc.nodes.map((n) => n.id)).toEqual(['g2', 'g', 'c1', 'c2', 'out'])
    ok(b, [{ op: 'reorder', id: 'g', to: 'back' }])
    expect(b.doc.nodes.map((n) => n.id)).toEqual(['g', 'g2', 'c1', 'c2', 'out'])
    expect(b.diffSince(b.version - 1).changed).toEqual(['g'])
  })
})

describe('identity, versions, subscribe', () => {
  test('untouched nodes and edges keep identity; doc is a new object', () => {
    const b = createBoard()
    ok(b, [{ op: 'add_node', id: 'a' }, { op: 'add_node', id: 'b' }, { op: 'add_edge', id: 'e', from: 'a', to: 'b' }])
    const before = b.doc
    ok(b, [{ op: 'update', id: 'a', x: 9 }])
    expect(b.doc).not.toBe(before)
    expect(b.doc.nodes[1]).toBe(before.nodes[1])
    expect(b.doc.edges[0]).toBe(before.edges[0])
    expect(b.doc.nodes[0]).not.toBe(before.nodes[0])
    expect(before.nodes[0].x).toBe(0) // old doc not mutated
  })

  test('subscribe fires on apply, undo, redo; unsubscribe stops it', () => {
    const b = createBoard()
    const seen: number[] = []
    const off = b.subscribe((doc, v) => {
      expect(doc).toBe(b.doc)
      seen.push(v)
    })
    ok(b, [{ op: 'add_node' }])
    b.undo()
    b.redo()
    err(b, [{ op: 'remove', ids: ['nope'] }])
    off()
    ok(b, [{ op: 'add_node' }])
    expect(seen).toEqual([1, 2, 3])
  })

  test('empty batch is a no-op', () => {
    const b = createBoard()
    expect(b.apply([], U)).toEqual({ ok: true, version: 0, ids: {} })
    expect(b.canUndo()).toBe(false)
  })
})

describe('stale baseVersion and diffSince', () => {
  test('stale baseVersion is rejected with the diff', () => {
    const b = createBoard()
    ok(b, [{ op: 'add_node', id: 'a' }]) // v1, agent reads here
    ok(b, [{ op: 'add_node', id: 'b' }, { op: 'update', id: 'a', x: 3 }], U) // v2 user change
    const before = b.doc
    const r = b.apply([{ op: 'remove', ids: ['a'] }], { by: 'agent:x', baseVersion: 1 })
    expect(r.ok).toBe(false)
    expect(b.doc).toBe(before)
    const e = (r as ApplyFail).error as { stale: true; message: string; diff: unknown }
    expect(e.stale).toBe(true)
    expect(e.message).toContain('baseVersion 1 is stale')
    expect(e.diff).toEqual({ from: 1, to: 2, added: ['b'], changed: ['a'], removed: [] })
    expect(b.apply([{ op: 'remove', ids: ['a'] }], { by: 'agent:x', baseVersion: 2 }).ok).toBe(true)
  })

  test('net effect: added-then-removed is nothing, added-then-changed is added', () => {
    const b = createBoard()
    ok(b, [{ op: 'add_node', id: 'keep' }, { op: 'add_node', id: 'old' }]) // v1
    ok(b, [{ op: 'add_node', id: 'tmp' }, { op: 'add_node', id: 'new' }]) // v2
    ok(b, [{ op: 'remove', ids: ['tmp', 'old'] }, { op: 'update', id: 'new', x: 4 }]) // v3
    ok(b, [{ op: 'update', id: 'keep', x: 1 }]) // v4
    expect(b.diffSince(1)).toEqual({ from: 1, to: 4, added: ['new'], changed: ['keep'], removed: ['old'] })
    expect(b.diffSince(4)).toEqual({ from: 4, to: 4, added: [], changed: [], removed: [] })
    // undo is a version too: undoing v4 restores keep -> still a change since v3
    b.undo()
    expect(b.version).toBe(5)
    expect(b.diffSince(4)).toMatchObject({ changed: ['keep'] })
    // removed then re-added (via undo) is "changed"
    const c = createBoard()
    ok(c, [{ op: 'add_node', id: 'a' }])
    ok(c, [{ op: 'remove', ids: ['a'] }])
    c.undo()
    expect(c.diffSince(1)).toMatchObject({ added: [], changed: ['a'], removed: [] })
  })

  test('versions older than the kept history report everything as changed', () => {
    const b = createBoard()
    ok(b, [{ op: 'add_node', id: 'a' }])
    for (let i = 0; i < 520; i++) ok(b, [{ op: 'move', ids: ['a'], dx: 1, dy: 0 }], { by: 'user', mergeWithPrevious: true })
    ok(b, [{ op: 'add_node', id: 'b' }])
    expect(b.diffSince(0)).toEqual({ from: 0, to: 522, added: [], changed: ['a', 'b'], removed: [] })
    expect(b.diffSince(521)).toEqual({ from: 521, to: 522, added: ['b'], changed: [], removed: [] })
  })
})

describe('undo / redo', () => {
  test('mergeWithPrevious makes one undo step', () => {
    const b = createBoard()
    ok(b, [{ op: 'add_node', id: 'a' }])
    const afterAdd = b.doc
    ok(b, [{ op: 'move', ids: ['a'], dx: 1, dy: 0 }], U)
    ok(b, [{ op: 'move', ids: ['a'], dx: 1, dy: 0 }], { by: 'user', mergeWithPrevious: true })
    ok(b, [{ op: 'move', ids: ['a'], dx: 1, dy: 0 }], { by: 'user', mergeWithPrevious: true })
    expect(node(b, 'a').x).toBe(3)
    expect(b.undo()).toBe(true)
    expect(b.doc).toBe(afterAdd)
    expect(b.undo()).toBe(true)
    expect(b.doc.nodes).toEqual([])
    expect(b.undo()).toBe(false)
    expect(b.canUndo()).toBe(false)
  })

  test('new apply clears redo', () => {
    const b = createBoard()
    ok(b, [{ op: 'add_node' }])
    b.undo()
    expect(b.canRedo()).toBe(true)
    ok(b, [{ op: 'add_node' }])
    expect(b.canRedo()).toBe(false)
    expect(b.redo()).toBe(false)
  })

  test('20-op random sequence round-trips deep-equal through undo and redo', () => {
    let seed = 42
    const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648)
    const pick = <T,>(xs: T[]) => xs[Math.floor(rnd() * xs.length)]
    const b = createBoard()
    const snaps: string[] = [JSON.stringify(b.doc)]
    let applied = 0
    while (applied < 20) {
      const nodes = b.doc.nodes.map((n) => n.id)
      const groups = b.doc.nodes.filter((n) => n.type === 'group').map((n) => n.id)
      const edges = b.doc.edges.map((e) => e.id)
      const choices: Op[] = [
        { op: 'add_node', text: `n${applied}`, x: Math.round(rnd() * 500), y: 7, ...(groups.length ? { parent: pick(groups) } : {}) },
        { op: 'add_node', kind: 'group' },
      ]
      if (nodes.length) {
        const id = pick(nodes)
        choices.push(
          { op: 'add_edge', from: id, to: pick(nodes) },
          { op: 'move', ids: [id], dx: 3, dy: 4 },
          { op: 'update', id, color: pick(['1', '2', '#00ff00']) },
          { op: 'reorder', id, to: pick(['front', 'back'] as const) },
          { op: 'remove', ids: [id] },
        )
      }
      if (edges.length) choices.push({ op: 'update_edge', id: pick(edges), points: [{ x: 1, y: 1 }] })
      if (groups.length) choices.push({ op: 'set_layout', group: pick(groups), layout: 'grid' }, { op: 'set_layout', group: 'root', layout: 'dag-lr' })
      ok(b, [pick(choices)])
      snaps.push(JSON.stringify(b.doc))
      applied++
    }
    const docs: CanvasDoc[] = []
    for (let i = 20; i > 0; i--) {
      expect(b.undo()).toBe(true)
      expect(JSON.parse(JSON.stringify(b.doc))).toEqual(JSON.parse(snaps[i - 1]))
      docs.push(b.doc)
    }
    expect(b.canUndo()).toBe(false)
    for (let i = 1; i <= 20; i++) {
      expect(b.redo()).toBe(true)
      expect(JSON.stringify(b.doc)).toBe(snaps[i])
    }
    expect(b.version).toBe(60)
  })
})

describe('JSON Canvas I/O', () => {
  const text = JSON.stringify(
    {
      'x-meta': { title: 'Board', tags: ['a'] },
      nodes: [
        { id: 'g', type: 'group', x: 0, y: 0, width: 400, height: 300, label: 'G', background: 'bg.png', 'x-layout': 'grid' },
        { id: 'a', type: 'text', text: 'A', x: 10, y: 10, width: 100, height: 50, color: '1', 'x-foo': { deep: [1, 2] }, 'x-parent': 'g' },
        { id: 'f', type: 'file', file: 'note.md', subpath: '#h', x: 200, y: 10, width: 100, height: 50 },
      ],
      edges: [{ id: 'e', fromNode: 'a', fromSide: 'right', toNode: 'f', toEnd: 'arrow', label: 'x', 'x-bar': true }],
      'x-layout': 'free',
    },
    null,
    2,
  )

  test('round trip is byte-for-byte and keeps unknown fields', () => {
    const b = fromJSON(text)
    expect(b.version).toBe(0)
    expect(b.canUndo()).toBe(false)
    expect(b.toJSON()).toBe(text)
  })

  test('unknown fields survive edits, and edits + undo return to the same text', () => {
    const b = fromJSON(text)
    ok(b, [{ op: 'move', ids: ['g'], dx: 10, dy: 0 }, { op: 'add_node', text: 'new' }])
    const doc = JSON.parse(b.toJSON())
    expect(doc['x-meta']).toEqual({ title: 'Board', tags: ['a'] })
    expect(doc.nodes[1]['x-foo']).toEqual({ deep: [1, 2] })
    expect(doc.nodes[1].x).toBe(20)
    expect(Object.keys(doc)).toEqual(['x-meta', 'nodes', 'edges', 'x-layout'])
    b.undo()
    expect(b.toJSON()).toBe(text)
  })

  test('missing arrays default to empty; invalid docs throw precise errors', () => {
    expect(fromJSON('{}').doc).toEqual({ nodes: [], edges: [] })
    expect(() => fromJSON('[]')).toThrow('canvas must be a JSON object')
    expect(() => fromJSON('{"nodes":{}}')).toThrow('"nodes" must be an array')
    expect(() => fromJSON('{"nodes":[{"id":"a","type":"text","x":0,"y":0,"width":1}]}')).toThrow('nodes[0].height must be a finite number')
    expect(() => fromJSON('{"nodes":[{"id":"a","type":"shape","x":0,"y":0,"width":1,"height":1}]}')).toThrow('nodes[0].type')
    expect(() => fromJSON('{"nodes":[{"type":"text","x":0,"y":0,"width":1,"height":1}]}')).toThrow('nodes[0].id')
    expect(() => fromJSON('{"edges":[{"id":"e","fromNode":"a"}]}')).toThrow('edges[0].toNode must be a string')
    expect(() =>
      fromJSON('{"nodes":[{"id":"a","type":"text","x":0,"y":0,"width":1,"height":1}],"edges":[{"id":"a","fromNode":"a","toNode":"a"}]}'),
    ).toThrow('duplicate')
  })
})
