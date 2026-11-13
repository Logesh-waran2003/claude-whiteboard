// M6. CLI: bun canvas/quality/run.ts [files...] [--strict]
// Prints one row per canvas file. With --strict, exits 1 if any scored file is below 100.
import { readdirSync } from 'node:fs'
import { basename } from 'node:path'
import type { CanvasDoc } from '../core/model'
import { approxMeasure } from '../core/measure'
import { scoreDetailed } from './score'

const FIXTURES = `${import.meta.dir}/fixtures`
const args = process.argv.slice(2)
const strict = args.includes('--strict')
const given = args.filter((a) => a !== '--strict')
const files = given.length ? given : readdirSync(FIXTURES).filter((f) => f.endsWith('.canvas')).sort().map((f) => `${FIXTURES}/${f}`)

const rows = await Promise.all(
  files.map(async (file) => {
    const doc = (await Bun.file(file).json()) as CanvasDoc
    return { name: basename(file, '.canvas'), report: scoreDetailed(doc, approxMeasure) }
  }),
)

const cols = ['name', 'score', 'overlaps', 'wraps', 'through', 'outside', 'crossings', 'edgeOvlp', 'lblBorder', 'edgeBorder', 'stubs']
const table = rows.map((r) => [r.name, r.report.score, r.report.overlaps.length, r.report.wraps.length, r.report.edgeThroughNode.length, r.report.outsideGroup.length, r.report.crossings, r.report.edgeOverlap.length, r.report.labelOnBorder.length, r.report.edgeOnBorder.length, r.report.stubs.length])
const widths = cols.map((c, i) => Math.max(c.length, ...table.map((row) => String(row[i]).length)))
const line = (cells: (string | number)[]) => cells.map((c, i) => String(c).padEnd(widths[i])).join('  ')
console.log(line(cols))
for (const row of table) console.log(line(row))

// Name the defects of every file that has any.
for (const r of rows) {
  const { overlaps, wraps, edgeThroughNode, outsideGroup, crossings, edgeOverlap, labelOnBorder, edgeOnBorder, stubs } = r.report
  const parts = [
    ...overlaps.map(([a, b]) => `overlap ${a} x ${b}`),
    ...wraps.map((id) => `wrap ${id}`),
    ...edgeThroughNode.map(([e, n]) => `through ${e} -> ${n}`),
    ...outsideGroup.map((id) => `outside ${id}`),
    ...(crossings ? [`crossings ${crossings}`] : []),
    ...edgeOverlap.map(([a, b]) => `edge overlap ${a} x ${b}`),
    ...labelOnBorder.map((id) => `crosses group border ${id}`),
    ...edgeOnBorder.map((id) => `runs along group border ${id}`),
    ...stubs.map((id) => `stub ${id}`),
  ]
  if (parts.length) console.log(`\n${r.name}: ${parts.join('; ')}`)
}

if (strict && rows.some((r) => r.report.score < 100)) process.exit(1)
