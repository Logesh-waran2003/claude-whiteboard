// CONTRACT (M0). Text measurement. Layout and quality take a Measure, so they run in the browser
// (exact) and in bun/CI (approximate) with the same code.
import { type Measure, TYPE } from './model'

// ponytail: 0.56em per character approximates a sans font; good enough for CI scoring.
// The browser uses canvasMeasure for exact numbers.
const AVG_CHAR = 0.56

/** The one wrap rule: layout, renderer and quality must all use it. */
export function wrapLines(words: string[], maxWidth: number, widthOf: (s: string) => number): string[] {
  const lines: string[] = []
  let line = ''
  for (const w of words) {
    const next = line ? `${line} ${w}` : w
    if (widthOf(next) <= maxWidth || !line) line = next
    else {
      lines.push(line)
      line = w
    }
  }
  if (line) lines.push(line)
  return lines
}

function measureWith(widthOf: (s: string, fontSize: number) => number): Measure {
  return (text, { fontSize, maxWidth }) => {
    const paragraphs = text.split('\n')
    const lines = paragraphs.flatMap((p) => (maxWidth ? wrapLines(p.split(/\s+/), maxWidth, (s) => widthOf(s, fontSize)) : [p]))
    const width = Math.max(0, ...lines.map((l) => widthOf(l, fontSize)))
    return { width: Math.ceil(width), height: Math.ceil(lines.length * fontSize * TYPE.lineHeight) }
  }
}

/** Deterministic approximate measure for bun, tests and CI. */
export const approxMeasure: Measure = measureWith((s, fontSize) => s.length * fontSize * AVG_CHAR)

/** Exact measure in the browser, using the renderer's font. */
export function canvasMeasure(fontFamily: string): Measure {
  const ctx = document.createElement('canvas').getContext('2d')!
  return measureWith((s, fontSize) => {
    ctx.font = `${fontSize}px ${fontFamily}`
    return ctx.measureText(s).width
  })
}
