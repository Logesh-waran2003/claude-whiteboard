import { describe, expect, test } from 'bun:test'
import { createBoard } from '../core/board'
import { approxMeasure } from '../core/measure'
import type { Op } from '../core/model'
import { toSVG } from './export-svg'
import { parseMermaid } from './mermaid'
import { AgentSession } from './session'
import { createTools } from './tools'

const session = () => new AgentSession(createBoard(), approxMeasure)

/** The architecture fixture (canvas/layout/fixtures.ts) in Mermaid. */
export const ARCHITECTURE = `flowchart TB
  subgraph browser [Browser]
    direction LR
    editor[Editor UI]
    canvas[Canvas renderer]
    chat[Chat panel]
  end
  subgraph server [Local server]
    direction LR
    api[HTTP API]
    store[Board store]
    runner[Agent runner]
  end
  subgraph context [Context]
    direction LR
    sdk[Claude Agent SDK]
    mcp[MCP tools]
    files((Project files))
  end
  editor -->|ops| canvas
  chat -->|prompt| api
  api -->|start run| runner
  runner -->|query| sdk
  sdk -->|tool call| mcp
  mcp -->|apply ops| store
  store -->|doc update| canvas
  sdk -->|reads| files`

const ok = (src: string) => {
  const r = parseMermaid(src)
  if (!r.ok) throw new Error(`line ${r.line}: ${r.message}`)
  return r
}
const adds = (ops: Op[]) => ops.filter((o) => o.op === 'add_node') as Extract<Op, { op: 'add_node' }>[]
const edges = (ops: Op[]) => ops.filter((o) => o.op === 'add_edge') as Extract<Op, { op: 'add_edge' }>[]

describe('mermaid parser', () => {
  test('header direction sets the root layout', () => {
    for (const [h, l] of [['flowchart LR', 'dag-lr'], ['graph TD', 'dag-tb'], ['graph TB', 'dag-tb'], ['flowchart RL', 'dag-lr'], ['flowchart BT', 'dag-tb'], ['flowchart', 'dag-tb']])
      expect(ok(`${h}\nA-->B`).ops[0]).toEqual({ op: 'set_layout', group: 'root', layout: l as never })
  })

  test('node shapes', () => {
    const r = ok('flowchart LR\nA\nB[box]\nC(round)\nD([stadium])\nE((circle))\nF{choice}\nG>flag]\nH["text (x)"]')
    const n = Object.fromEntries(adds(r.ops).map((o) => [o.id, [o.kind, o.text]]))
    expect(n).toEqual({
      A: ['rect', 'A'], B: ['rect', 'box'], C: ['rect', 'round'], D: ['rect', 'stadium'],
      E: ['ellipse', 'circle'], F: ['diamond', 'choice'], G: ['rect', 'flag'], H: ['rect', 'text (x)'],
    })
    expect(adds(r.ops).every((o) => o.x === undefined && o.y === undefined)).toBe(true)
  })

  test('edge kinds and labels', () => {
    const r = ok('flowchart LR\nA --> B\nB --- C\nC -.-> D\nD ==> E\nE -- yes --> F\nF -->|no| G\nG <--> H\nH -. maybe .-> I')
    expect(edges(r.ops).map((e) => [e.from, e.to, e.label, e.arrow])).toEqual([
      ['A', 'B', undefined, undefined],
      ['B', 'C', undefined, 'none'],
      ['C', 'D', undefined, undefined],
      ['D', 'E', undefined, undefined],
      ['E', 'F', 'yes', undefined],
      ['F', 'G', 'no', undefined],
      ['G', 'H', undefined, 'both'],
      ['H', 'I', 'maybe', undefined],
    ])
  })

  test('chains and & fan-out', () => {
    const r = ok('flowchart TD\nA --> B --> C\nA --> D & E\nX & Y --> Z')
    expect(edges(r.ops).map((e) => `${e.from}>${e.to}`)).toEqual(['A>B', 'B>C', 'A>D', 'A>E', 'X>Z', 'Y>Z'])
  })

  test('nested subgraphs, titles and direction', () => {
    const r = ok(`flowchart TB
  %% a comment
  subgraph outer [Outer box]
    direction LR
    A
    subgraph inner ["Inner (x)"]
      B --> C
    end
  end
  subgraph Solo
    D
  end
  A --> B; C --> D`)
    const groups = adds(r.ops).filter((o) => o.kind === 'group')
    expect(groups.map((g) => [g.id, g.text, g.layout, g.parent])).toEqual([
      ['outer', 'Outer box', 'dag-lr', undefined],
      ['inner', 'Inner (x)', 'dag-tb', 'outer'],
      ['Solo', 'Solo', 'dag-tb', undefined],
    ])
    const parent = Object.fromEntries(adds(r.ops).filter((o) => o.kind !== 'group').map((o) => [o.id, o.parent]))
    expect(parent).toEqual({ A: 'outer', B: 'inner', C: 'inner', D: 'Solo' })
    expect(edges(r.ops)).toHaveLength(3)
  })

  test('classDef/class/style/click are ignored with a warning', () => {
    const r = ok('flowchart LR\nA:::hot --> B\nclassDef hot fill:#f00\nclass A hot\nstyle B fill:#0f0\nclick A "http://x"')
    expect(r.warnings).toHaveLength(4)
    expect(adds(r.ops).map((o) => o.id)).toEqual(['A', 'B'])
  })

  test('syntax errors return a line number', () => {
    expect(parseMermaid('flowchart LR\nA --> B\nC -> D')).toMatchObject({ ok: false, line: 3 })
    expect(parseMermaid('flowchart LR\nA[open --> B')).toMatchObject({ ok: false, line: 2 })
    expect(parseMermaid('flowchart LR\nsubgraph g\nA\n')).toMatchObject({ ok: false, line: 2 })
    expect(parseMermaid('sequenceDiagram\nA->>B: hi')).toMatchObject({ ok: false, line: 1 })
    expect(parseMermaid('flowchart LR\nend')).toMatchObject({ ok: false, line: 2 })
  })

  test('a reply edge is routed as an elbow', () => {
    const r = ok('flowchart LR\nA -->|1 ask| B\nB -->|2 answer| A')
    expect(edges(r.ops).map((e) => e.route)).toEqual([undefined, 'elbow'])
  })

  test('existing nodes are reused and taken ids avoided', () => {
    const r = ok('flowchart LR\napi --> db')
    expect(adds(r.ops)).toHaveLength(2)
    const r2 = parseMermaid('flowchart LR\napi --> db', { existingNodes: new Set(['api']), takenIds: new Set(['api', 'db']) })
    if (!r2.ok) throw new Error()
    expect(adds(r2.ops).map((o) => o.id)).toEqual(['db_2'])
    expect(edges(r2.ops)[0]).toMatchObject({ from: 'api', to: 'db_2' })
  })
})

describe('session', () => {
  test('outline format', () => {
    const s = session()
    s.apply({ agent: 'a', ops: [
      { op: 'add_node', id: 'g', kind: 'group', text: 'Server', layout: 'dag-lr' },
      { op: 'add_node', id: 'n1', text: 'HTTP API', parent: 'g', role: 'service' },
      { op: 'add_node', id: 'n2', text: 'Store', parent: 'g' },
      { op: 'add_edge', id: 'e1', from: 'n1', to: 'n2', label: 'writes' },
    ] })
    const { outline } = s.readBoard({ agent: 'a' })
    const lines = outline.split('\n')
    expect(lines[0]).toMatch(/^board v\d+ layout:free nodes:3 edges:1$/)
    expect(lines[1]).toMatch(/^g \[group\] "Server" @-?\d+,-?\d+ \d+x\d+ layout:dag-lr by:agent:a$/)
    expect(lines[2]).toMatch(/^  n1 \[rect\] "HTTP API" @-?\d+,-?\d+ \d+x\d+ in:g role:service by:agent:a$/)
    expect(lines[3]).toMatch(/^  n2 \[rect\] "Store" @/)
    expect(lines.slice(4)).toEqual(['edges:', '  e1: n1 -> n2 "writes"'])
  })

  test('per-agent diff names the user and skips own changes', () => {
    const board = createBoard()
    const s = new AgentSession(board, approxMeasure)
    s.apply({ agent: 'a', ops: [{ op: 'add_node', id: 'n3', text: 'Auth' }, { op: 'add_node', id: 'n4', text: 'DB' }, { op: 'add_edge', id: 'e2', from: 'n3', to: 'n4' }] })
    expect(s.readBoard({ agent: 'a' }).diff).toEqual([])
    expect(s.readBoard({ agent: 'b' }).diff).toEqual([]) // first read: nothing to compare
    board.apply([{ op: 'move', ids: ['n3'], dx: 40, dy: 0 }], { by: 'user' })
    board.apply([{ op: 'add_node', id: 'n9', text: 'Auth', x: 900, y: 0 }], { by: 'user' })
    board.apply([{ op: 'remove', ids: ['e2'] }], { by: 'user' })
    s.apply({ agent: 'b', ops: [{ op: 'update', id: 'n4', text: 'Postgres' }] })
    const a = s.readBoard({ agent: 'a' }).diff
    expect(a).toContain('user moved n3')
    expect(a).toContain('user added n9 [rect] "Auth"')
    expect(a).toContain('user removed e2')
    expect(a).toContain('agent:b renamed n4 to "Postgres"')
    expect(s.readBoard({ agent: 'a' }).diff).toEqual([])
    expect(s.readBoard({ agent: 'b' }).diff).not.toContain('agent:b renamed n4 to "Postgres"')
  })

  test('apply returns quality and one undo step covers ops + layout', () => {
    const board = createBoard()
    const s = new AgentSession(board, approxMeasure)
    const r = s.apply({ agent: 'a', ops: [{ op: 'add_node', ref: 'x', text: 'One' }, { op: 'add_node', ref: 'y', text: 'Two' }, { op: 'add_edge', from: 'x', to: 'y', label: 'calls' }] })
    if (!r.ok) throw new Error(JSON.stringify(r))
    expect(r.quality.score).toBe(100)
    expect(Object.keys(r.ids)).toEqual(['x', 'y'])
    expect(board.doc.nodes.every((n) => n['x-placed'] === undefined)).toBe(true)
    expect(s.undo({ agent: 'a' }).ok).toBe(true)
    expect(board.doc.nodes).toHaveLength(0)
    expect(board.canUndo()).toBe(false)
  })

  test('undo refuses after a user change', () => {
    const board = createBoard()
    const s = new AgentSession(board, approxMeasure)
    s.apply({ agent: 'a', ops: [{ op: 'add_node', id: 'n', text: 'One' }] })
    board.apply([{ op: 'add_node', text: 'mine', x: 500, y: 500 }], { by: 'user' })
    expect(s.undo({ agent: 'a' }).ok).toBe(false)
    expect(board.doc.nodes).toHaveLength(2)
  })

  test('failure returns the board error unchanged plus a hint', () => {
    const board = createBoard()
    const s = new AgentSession(board, approxMeasure)
    const ops: Op[] = [{ op: 'add_edge', from: 'nope', to: 'also' }]
    const direct = createBoard().apply(ops, { by: 'agent:a' })
    const r = s.apply({ agent: 'a', ops })
    expect(r.ok).toBe(false)
    if (r.ok || direct.ok) throw new Error()
    expect(r.error).toEqual(direct.error)
    expect(r.hint).toMatch(/missing id/)
    const stale = s.apply({ agent: 'a', ops: [], baseVersion: 99 })
    expect(stale).toMatchObject({ ok: false, error: { stale: true } })
  })

  test('quality hint names the worst problem', () => {
    const board = createBoard()
    const s = new AgentSession(board, approxMeasure)
    board.apply([{ op: 'add_node', id: 'p', text: 'A', x: 0, y: 0 }, { op: 'add_node', id: 'q', text: 'B', x: 20, y: 10 }], { by: 'user' })
    const c = s.check()
    expect(c.overlaps).toEqual([['p', 'q']])
    expect(c.hint).toMatch(/^p overlaps q/)
  })

  test('draw_mermaid of the architecture fixture scores >= 95 with no overlaps or wraps', () => {
    const s = session()
    const r = s.fromMermaid({ agent: 'a', source: ARCHITECTURE })
    if (!r.ok) throw new Error(JSON.stringify(r))
    expect(r.quality.score).toBeGreaterThanOrEqual(95)
    expect(r.quality.overlaps).toEqual([])
    expect(r.quality.wraps).toEqual([])
    expect(r.quality.outsideGroup).toEqual([])
    expect(s.doc.nodes).toHaveLength(12)
  })

  test('draw_mermaid syntax error returns line and hint, board unchanged', () => {
    const s = session()
    const r = s.fromMermaid({ agent: 'a', source: 'flowchart LR\nA --> B\nC ->> D' })
    expect(r).toMatchObject({ ok: false, error: { line: 3 } })
    expect(s.doc.nodes).toHaveLength(0)
  })

  test('load (file changed on disk) keeps versions increasing and reports user changes', () => {
    const s = session()
    s.apply({ agent: 'a', ops: [{ op: 'add_node', id: 'n1', text: 'One' }] })
    s.readBoard({ agent: 'a' })
    const v = s.version
    const doc = structuredClone(s.doc)
    ;(doc.nodes[0] as { text: string }).text = 'Renamed in Obsidian'
    s.load(createBoard(doc))
    expect(s.version).toBeGreaterThan(v)
    expect(s.readBoard({ agent: 'a' }).diff).toEqual(['user renamed n1 to "Renamed in Obsidian"'])
  })

  test('nodes without x-by are user content: outline by:unknown, diff says user', () => {
    const s = session()
    s.apply({ agent: 'a', ops: [{ op: 'add_node', id: 'n1', text: 'One' }] })
    s.readBoard({ agent: 'a' })
    const doc = structuredClone(s.doc)
    doc.nodes.push({ id: 'ob', type: 'text', text: 'From Obsidian', x: 600, y: 0, width: 160, height: 64 })
    s.load(createBoard(doc))
    const r = s.readBoard({ agent: 'a' })
    expect(r.diff).toEqual(['user added ob [rect] "From Obsidian"'])
    expect(r.outline).toContain('ob [rect] "From Obsidian" @600,0 160x64 by:unknown')
    expect(s.undo({ agent: 'a' }).ok).toBe(false)
    const fresh = session()
    fresh.load(createBoard({ nodes: [{ id: 'p', type: 'text', text: 'A', x: 0, y: 0, width: 160, height: 64 }, { id: 'q', type: 'text', text: 'B', x: 20, y: 10, width: 160, height: 64, 'x-by': 'agent:z' }], edges: [] }))
    expect(fresh.check().hint).toContain('"ids":["q"]')
  })

  test('draw_mermaid returns every Mermaid id and the created edge ids', () => {
    const s = session()
    s.apply({ agent: 'a', ops: [{ op: 'add_node', id: 'db', text: 'Taken' }] })
    const r = s.fromMermaid({ agent: 'a', source: 'flowchart LR\nsubgraph g [G]\napi --> db\nend\nui --> api' })
    if (!r.ok) throw new Error(JSON.stringify(r))
    expect(r.ids).toEqual({ g: 'g', api: 'api', db: 'db', ui: 'ui' })
    expect(r.edges).toEqual(['api-db', 'ui-api'])
    for (const id of [...Object.values(r.ids), ...r.edges!]) expect([...s.doc.nodes, ...s.doc.edges].some((x) => x.id === id)).toBe(true)
  })

  test('find and layout', () => {
    const s = session()
    s.fromMermaid({ agent: 'a', source: 'flowchart LR\napi[HTTP API] -->|writes| db((Store))' })
    expect(s.find({ text: 'http' })).toEqual([expect.stringMatching(/^api \[rect\] "HTTP API"/)])
    expect(s.find({ text: 'writes' })).toEqual(['api-db: api -> db "writes"'])
    expect(s.layout({ agent: 'a', all: true }).ok).toBe(true)
  })
})

describe('svg export', () => {
  test('well-formed and contains every node text', () => {
    const s = session()
    s.fromMermaid({ agent: 'a', source: ARCHITECTURE + '\n  amp["a < b & c"]' })
    const svg = toSVG(s.doc, approxMeasure)
    const stack: string[] = []
    for (const m of svg.matchAll(/<(\/?)([a-zA-Z]+)[^>]*?(\/?)>/g)) {
      if (m[3]) continue
      if (m[1]) expect(stack.pop()).toBe(m[2])
      else stack.push(m[2])
    }
    expect(stack).toEqual([])
    expect(svg.startsWith('<svg')).toBe(true)
    const text = [...svg.matchAll(/<text[^>]*>([^<]*)<\/text>/g)].map((m) => m[1]).join(' ')
    for (const n of s.doc.nodes) {
      const t = n.type === 'group' ? n.label! : n.type === 'text' ? n.text : ''
      for (const w of t.replace(/&/g, '&amp;').replace(/</g, '&lt;').split(/\s+/)) expect(text).toContain(w)
    }
    const part = toSVG(s.doc, approxMeasure, { ids: ['server'] })
    expect(part).toContain('HTTP API')
    expect(part).not.toContain('Editor UI')
  })
})

describe('tools', () => {
  test('every tool has a description and get_skill returns the skill', async () => {
    const tools = createTools({ session: session(), agent: 'a' })
    expect(tools.map((t) => t.name)).toEqual(['get_skill', 'read_board', 'apply', 'draw_mermaid', 'layout', 'check', 'find', 'snapshot', 'undo', 'focus'])
    const skill = await tools[0].run({})
    expect(skill.text).toContain('name: board')
    for (const ref of ['architecture', 'flow', 'sequence', 'er', 'stickies', 'matrix']) expect((await tools[0].run({ name: ref })).text.length).toBeGreaterThan(200)
    expect((await tools.find((t) => t.name === 'focus')!.run({ ids: ['x'] })).text).toMatch(/no-op/)
  })
})
