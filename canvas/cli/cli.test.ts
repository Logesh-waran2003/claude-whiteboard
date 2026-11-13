import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { existsSync, readFileSync, readdirSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fromJSON } from '../core/board'

const ROOT = resolve(import.meta.dir, '../..')
const MAIN = resolve(import.meta.dir, 'main.ts')
const FIXTURES = resolve(ROOT, 'canvas/quality/fixtures')
const TMP = '/tmp/m8-test'

const cli = (args: string[], stdin?: string) =>
  Bun.spawnSync([process.execPath, MAIN, ...args], {
    cwd: ROOT,
    stdin: stdin === undefined ? undefined : Buffer.from(stdin),
    stdout: 'pipe',
    stderr: 'pipe',
    timeout: 60_000,
  })
const out = (r: { stdout: Uint8Array }) => r.stdout.toString()
const err = (r: { stderr: Uint8Array }) => r.stderr.toString()
const tmp = (name: string) => resolve(TMP, name)
const fixtures = (prefix: string) =>
  readdirSync(FIXTURES)
    .filter((f) => f.startsWith(prefix) && f.endsWith('.canvas'))
    .map((f) => resolve(FIXTURES, f))

beforeAll(() => {
  mkdirSync(TMP, { recursive: true })
})
afterAll(() => {
  rmSync(TMP, { recursive: true, force: true })
})

describe('check', () => {
  test('good fixtures pass with exit 0', () => {
    const good = fixtures('good-')
    expect(good.length).toBeGreaterThan(0)
    const r = cli(['check', ...good])
    expect(r.exitCode).toBe(0)
    expect(out(r)).toContain('PASS')
  })

  test('bad fixtures fail with exit 1 and name their defects', () => {
    const bad = fixtures('bad-')
    expect(bad.length).toBeGreaterThan(0)
    const r = cli(['check', ...bad])
    expect(r.exitCode).toBe(1)
    expect(out(r)).toContain('overlap:')
  })

  test('--min above 100 fails a good board', () => {
    expect(cli(['check', ...fixtures('good-'), '--min', '101']).exitCode).toBe(1)
  })

  test('--json prints parseable reports with pass flags', () => {
    const r = cli(['check', ...fixtures('good-').slice(0, 1), '--json'])
    expect(r.exitCode).toBe(0)
    const rows = JSON.parse(out(r))
    expect(rows[0].pass).toBe(true)
    expect(rows[0].report.score).toBe(100)
  })

  test('missing file exits 2 with a fix hint', () => {
    const r = cli(['check', tmp('nope.canvas')])
    expect(r.exitCode).toBe(2)
    expect(err(r)).toContain('does not exist')
  })
})

describe('render', () => {
  test('svg contains node text', () => {
    const file = tmp('g.svg')
    const r = cli(['render', resolve(FIXTURES, 'good-layered.canvas'), '-o', file])
    expect(r.exitCode).toBe(0)
    const svg = readFileSync(file, 'utf8')
    expect(svg.startsWith('<svg')).toBe(true)
    expect(svg).toContain('Ingest')
    expect(svg).toContain('Serve')
  })

  test('bad output extension exits 64', () => {
    expect(cli(['render', resolve(FIXTURES, 'good-layered.canvas'), '-o', tmp('g.txt')]).exitCode).toBe(64)
  })
})

describe('import', () => {
  test('a Mermaid file becomes a board that fromJSON accepts', () => {
    const mmd = tmp('flow.mmd')
    writeFileSync(mmd, 'flowchart LR\nA[Start] --> B[End]\n')
    const file = tmp('flow.canvas')
    const r = cli(['import', mmd, '-o', file])
    expect(r.exitCode).toBe(0)
    const board = fromJSON(readFileSync(file, 'utf8'))
    expect(board.doc.nodes.map((n) => (n.type === 'text' ? n.text : ''))).toEqual(expect.arrayContaining(['Start', 'End']))
    expect(board.doc.edges.length).toBe(1)
  })

  test('stdin works with "-"', () => {
    const file = tmp('stdin.canvas')
    const r = cli(['import', '-', '-o', file], 'flowchart LR\nX --> Y\n')
    expect(r.exitCode).toBe(0)
    expect(fromJSON(readFileSync(file, 'utf8')).doc.edges.length).toBe(1)
  })

  test('refuses to overwrite without --append; --append keeps existing nodes', () => {
    const file = tmp('append.canvas')
    expect(cli(['import', '-', '-o', file], 'flowchart LR\nP --> Q\n').exitCode).toBe(0)
    expect(cli(['import', '-', '-o', file], 'flowchart LR\nR --> S\n').exitCode).toBe(2)
    expect(cli(['import', '-', '-o', file, '--append'], 'flowchart LR\nR --> S\n').exitCode).toBe(0)
    const doc = fromJSON(readFileSync(file, 'utf8')).doc
    expect(doc.edges.length).toBe(2)
  })

  test('a bad diagram writes nothing and exits 2', () => {
    const file = tmp('bad.canvas')
    const r = cli(['import', '-', '-o', file], 'this is not mermaid ->->\n')
    expect(r.exitCode).toBe(2)
    expect(existsSync(file)).toBe(false)
  })
})

describe('layout', () => {
  test('without --write the file is unchanged; with --write it changes', () => {
    const src = tmp('lay-src.mmd')
    writeFileSync(src, 'flowchart LR\nA --> B\nB --> C\n')
    const file = tmp('lay.canvas')
    expect(cli(['import', src, '-o', file]).exitCode).toBe(0)
    // Move a node so the layout has something to change.
    const doc = JSON.parse(readFileSync(file, 'utf8'))
    doc.nodes[0].x += 500
    doc.nodes[0]['x-placed'] = true
    writeFileSync(file, JSON.stringify(doc, null, 2))
    const before = readFileSync(file, 'utf8')

    const dry = cli(['layout', file, '--all'])
    expect(dry.exitCode).toBe(0)
    expect(out(dry)).toContain('not saved')
    expect(readFileSync(file, 'utf8')).toBe(before)

    const wet = cli(['layout', file, '--all', '--write'])
    expect(wet.exitCode).toBe(0)
    expect(readFileSync(file, 'utf8')).not.toBe(before)
    expect(existsSync(`${file}.tmp-${process.pid}`)).toBe(false)
  })
})

describe('new', () => {
  test('creates an empty valid board', () => {
    const file = tmp('new/board.canvas')
    expect(cli(['new', file]).exitCode).toBe(0)
    const doc = fromJSON(readFileSync(file, 'utf8')).doc
    expect(doc.nodes).toEqual([])
    expect(doc.edges).toEqual([])
  })

  test('refuses to overwrite an existing file', () => {
    const file = tmp('keep.canvas')
    writeFileSync(file, '{"nodes":[{"id":"keep","type":"text","text":"Keep","x":0,"y":0,"width":10,"height":10}],"edges":[]}')
    const r = cli(['new', file])
    expect(r.exitCode).toBe(2)
    expect(err(r)).toContain('refusing to overwrite')
    expect(readFileSync(file, 'utf8')).toContain('Keep')
  })
})

describe('usage', () => {
  test('unknown command exits 64 and prints usage', () => {
    const r = cli(['frobnicate'])
    expect(r.exitCode).toBe(64)
    expect(err(r)).toContain('Usage:')
  })

  test('help, --help and no args exit 0', () => {
    expect(cli(['help']).exitCode).toBe(0)
    expect(cli(['--help']).exitCode).toBe(0)
    expect(out(cli([]))).toContain('Usage:')
  })
})
