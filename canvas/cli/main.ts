// M8. Command-line tool for boards (JSON Canvas files).
// Usage: bun canvas/cli/main.ts <command> [args]   (run `help` for the list)
// Exit codes: 0 ok, 1 quality below --min (check), 2 error, 64 usage.
import { existsSync, readFileSync, renameSync, writeFileSync, mkdirSync } from 'node:fs'
import { basename, dirname, extname, resolve } from 'node:path'
import { createBoard, fromJSON } from '../core/board'
import { approxMeasure } from '../core/measure'
import type { CanvasDoc } from '../core/model'
import { AgentSession } from '../agent/session'
import { toSVG } from '../agent/export-svg'
import { svgToPng } from '../agent/png'
import { type DetailedReport, scoreDetailed } from '../quality/score'

const MCP_SERVER = resolve(import.meta.dir, '../agent/mcp-stdio.ts')

const USAGE = `Usage: bun canvas/cli/main.ts <command> [args]

  check <file.canvas...> [--min 100] [--json]   score boards; exit 1 if any score is below --min
  render <file.canvas> [-o out.svg|out.png] [--padding 24]
                                                write an SVG, or a PNG (needs Google Chrome)
  import <diagram.mmd|-> -o <file.canvas> [--append]
                                                Mermaid flowchart to a board; "-" reads stdin
  layout <file.canvas> [--all] [--write]        re-layout; prints the score change; saves only with --write
  new <file.canvas>                             create an empty board (never overwrites)
  mcp <file.canvas> [--agent name]              start the MCP stdio server for coding agents
  help                                          show this text

Exit codes: 0 ok, 1 quality below --min, 2 error, 64 usage.`

class Fail extends Error {
  constructor(
    message: string,
    readonly code = 2,
  ) {
    super(message)
  }
}
const usage = (message: string) => new Fail(message, 64)

// ---------------------------------------------------------------- args

const VALUED = new Set(['min', 'padding', 'agent', 'o'])
const BOOLEAN = new Set(['json', 'all', 'write', 'append'])
type Parsed = { pos: string[]; flags: Map<string, string | true> }

function parseArgs(argv: string[]): Parsed {
  const pos: string[] = []
  const flags = new Map<string, string | true>()
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!
    const name = a === '-o' ? 'o' : a.startsWith('--') ? a.slice(2) : undefined
    if (name === undefined) {
      pos.push(a) // includes "-" (stdin)
    } else if (VALUED.has(name)) {
      const v = argv[++i]
      if (v === undefined || v.startsWith('--')) throw usage(`${a} needs a value`)
      flags.set(name, v)
    } else if (BOOLEAN.has(name)) {
      flags.set(name, true)
    } else {
      throw usage(`unknown option ${a}; run "help" to see the options`)
    }
  }
  return { pos, flags }
}

function numFlag(p: Parsed, name: string, dflt: number): number {
  const v = p.flags.get(name)
  if (v === undefined) return dflt
  const n = Number(v)
  if (v === true || v === '' || !Number.isFinite(n)) throw usage(`--${name} ${v === true ? '' : v} is not a number`)
  return n
}

function strFlag(p: Parsed, name: string): string | undefined {
  const v = p.flags.get(name)
  return typeof v === 'string' ? v : undefined
}

// ---------------------------------------------------------------- files

function loadDoc(file: string): CanvasDoc {
  if (!existsSync(file)) throw new Fail(`${file} does not exist. Check the path, or create it with: new ${file}`)
  try {
    return fromJSON(readFileSync(file, 'utf8')).doc
  } catch (e) {
    throw new Fail(`${file} is not a valid canvas: ${(e as Error).message}`)
  }
}

/** Write to a temp file, then rename, so a crash never leaves a half-written board. */
function writeAtomic(file: string, text: string) {
  const tmp = `${file}.tmp-${process.pid}`
  writeFileSync(tmp, text)
  renameSync(tmp, file)
}

const toJSONText = (doc: CanvasDoc) => JSON.stringify(doc, null, 2) + '\n'

// ---------------------------------------------------------------- check

const COLS: [string, (r: DetailedReport) => number][] = [
  ['overlaps', (r) => r.overlaps.length],
  ['wraps', (r) => r.wraps.length],
  ['through', (r) => r.edgeThroughNode.length],
  ['outside', (r) => r.outsideGroup.length],
  ['crossings', (r) => r.crossings],
  ['edgeOvlp', (r) => r.edgeOverlap.length],
  ['lblBorder', (r) => r.labelOnBorder.length],
  ['edgeBorder', (r) => r.edgeOnBorder.length],
  ['stubs', (r) => r.stubs.length],
]

function defectLines(r: DetailedReport): string[] {
  return [
    ...r.overlaps.map(([a, b]) => `overlap: ${a} and ${b}`),
    ...r.wraps.map((id) => `wrap: label of edge ${id} wraps; shorten it`),
    ...r.edgeThroughNode.map(([e, n]) => `through: edge ${e} runs through node ${n}`),
    ...r.outsideGroup.map((id) => `outside: ${id} sticks out of its group`),
    ...(r.crossings ? [`crossings: ${r.crossings} edge crossing(s)`] : []),
    ...r.edgeOverlap.map(([a, b]) => `edgeOverlap: edges ${a} and ${b} run together`),
    ...r.labelOnBorder.map((id) => `labelOnBorder: ${id} crosses a group border`),
    ...r.edgeOnBorder.map((id) => `edgeOnBorder: edge ${id} runs along a group border`),
  ]
}

function cmdCheck(p: Parsed): number {
  if (!p.pos.length) throw usage('check needs at least one .canvas file. Example: check board.canvas')
  const min = numFlag(p, 'min', 100)
  const rows = p.pos.map((file) => {
    const report = scoreDetailed(loadDoc(file), approxMeasure)
    return { file, name: basename(file, '.canvas'), report, pass: report.score >= min }
  })

  if (p.flags.has('json')) {
    console.log(JSON.stringify(rows.map(({ file, name, pass, report }) => ({ file, name, min, pass, report })), null, 2))
  } else {
    const header = ['name', 'score', 'status', ...COLS.map(([h]) => h)]
    const body = rows.map((r) => [r.name, String(r.report.score), r.pass ? 'PASS' : 'FAIL', ...COLS.map(([, f]) => String(f(r.report)))])
    const widths = header.map((h, i) => Math.max(h.length, ...body.map((b) => b[i]!.length)))
    const line = (cells: string[]) => cells.map((c, i) => c.padEnd(widths[i]!)).join('  ').trimEnd()
    console.log(line(header))
    for (const b of body) console.log(line(b))
    for (const r of rows) {
      const lines = defectLines(r.report)
      if (!lines.length) continue
      console.log(`\n${r.name}:`)
      for (const l of lines) console.log(`  ${l}`)
    }
    const failed = rows.filter((r) => !r.pass).length
    if (failed) console.log(`\n${failed} file(s) below --min ${min}`)
  }
  return rows.every((r) => r.pass) ? 0 : 1
}

// ---------------------------------------------------------------- render

async function cmdRender(p: Parsed): Promise<number> {
  const [file] = p.pos
  if (!file) throw usage('render needs a .canvas file. Example: render board.canvas -o board.png')
  const out = resolve(strFlag(p, 'o') ?? file.replace(/\.canvas$/, '') + '.svg')
  const ext = extname(out).toLowerCase()
  if (ext !== '.svg' && ext !== '.png') throw usage(`render output must end in .svg or .png, got ${out}`)
  const svg = toSVG(loadDoc(file), approxMeasure, { padding: numFlag(p, 'padding', 24) })
  if (ext === '.svg') writeFileSync(out, svg)
  else {
    const png = await svgToPng(svg).catch((e: Error) => {
      throw new Fail(`render: ${e.message}`)
    })
    writeFileSync(out, png)
  }
  console.log(`wrote ${out}`)
  return 0
}

// ---------------------------------------------------------------- import

function cmdImport(p: Parsed): number {
  const [src] = p.pos
  const o = strFlag(p, 'o')
  if (!src || !o) throw usage('import needs a diagram and -o. Example: import flow.mmd -o flow.canvas')
  const file = resolve(o)
  const exists = existsSync(file)
  if (exists && !p.flags.has('append')) throw new Fail(`${o} already exists. Add --append to add the diagram to it, or pick another -o name.`)
  const source = src === '-' ? readFileSync(0, 'utf8') : readFileSync(resolve(src), 'utf8')

  const session = new AgentSession(createBoard(exists ? loadDoc(file) : undefined), approxMeasure)
  const r = session.fromMermaid({ agent: 'cli', source })
  if (!r.ok) {
    const e = r.error
    throw new Fail(`import failed, nothing written: ${'line' in e ? `line ${e.line}: ` : ''}${e.message}`)
  }
  for (const w of r.warnings ?? []) console.error(`warning: ${w}`)
  writeAtomic(file, toJSONText(session.doc))
  const score = scoreDetailed(session.doc, approxMeasure).score
  console.log(`wrote ${o}: ${session.doc.nodes.length} nodes, ${session.doc.edges.length} edges, score ${score}`)
  return 0
}

// ---------------------------------------------------------------- layout

function cmdLayout(p: Parsed): number {
  const [file] = p.pos
  if (!file) throw usage('layout needs a .canvas file. Example: layout board.canvas --write')
  const doc = loadDoc(file)
  const before = scoreDetailed(doc, approxMeasure).score
  const session = new AgentSession(createBoard(doc), approxMeasure)
  const r = session.layout({ agent: 'cli', all: p.flags.has('all') })
  const after = scoreDetailed(session.doc, approxMeasure).score
  console.log(`${file}: score ${before} -> ${after}, ${r.tidied.length} item(s) changed`)
  if (p.flags.has('write')) {
    writeAtomic(resolve(file), toJSONText(session.doc))
    console.log(`saved ${file}`)
  } else {
    console.log('not saved; run again with --write to save')
  }
  return 0
}

// ---------------------------------------------------------------- new

function cmdNew(p: Parsed): number {
  const [file] = p.pos
  if (!file) throw usage('new needs a file name. Example: new board.canvas')
  const path = resolve(file)
  if (existsSync(path)) throw new Fail(`${file} already exists; refusing to overwrite it. Pick another name, or delete the file first.`)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, toJSONText({ nodes: [], edges: [] }), { flag: 'wx' })
  console.log(`created ${file}`)
  return 0
}

// ---------------------------------------------------------------- mcp

/** The MCP server owns stdout (the protocol), so the child inherits all three streams untouched. */
async function cmdMcp(p: Parsed): Promise<number> {
  const [file] = p.pos
  if (!file) throw usage('mcp needs a .canvas file. Example: mcp board.canvas --agent claude')
  const child = Bun.spawn([process.execPath, MCP_SERVER, '--file', file, '--agent', strFlag(p, 'agent') ?? 'mcp'], {
    stdio: ['inherit', 'inherit', 'inherit'],
  })
  const stop = () => child.kill()
  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)
  return (await child.exited) ?? 0
}

// ---------------------------------------------------------------- main

const COMMANDS: Record<string, (p: Parsed) => number | Promise<number>> = {
  check: cmdCheck,
  render: cmdRender,
  import: cmdImport,
  layout: cmdLayout,
  new: cmdNew,
  mcp: cmdMcp,
}

async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv
  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') {
    console.log(USAGE)
    return 0
  }
  if (!Object.hasOwn(COMMANDS, cmd)) throw usage(`unknown command "${cmd}"\n\n${USAGE}`)
  return COMMANDS[cmd]!(parseArgs(rest))
}

try {
  process.exitCode = await main(process.argv.slice(2))
} catch (e) {
  console.error(`error: ${(e as Error).message}`)
  process.exitCode = e instanceof Fail ? e.code : 2
}
