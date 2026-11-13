// Colors, text wrapping and rough.js helpers shared by the node and edge views.
import rough from 'roughjs'
import { wrapLines } from '../core/measure'
import type { CanvasNode, Color, Measure, Point } from '../core/model'

// JSON Canvas presets (Obsidian values): 1 red 2 orange 3 yellow 4 green 5 cyan 6 purple.
const PRESET: Record<string, string> = { '1': '#e5484d', '2': '#e8871e', '3': '#d4b106', '4': '#30a46c', '5': '#12a5b8', '6': '#8e4ec6' }

export const INK = '#1f2328'
export const MUTED = '#57606a'
export const PAPER = '#fbfbfa'
export const STICKY_FILL = '#fff4b0'
export const ACCENT = '#2f6feb'
export const FONT = 'Inter, ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif'

export const strokeOf = (c?: Color) => (c ? (PRESET[c] ?? c) : INK)
export const groupStrokeOf = (c?: Color) => (c ? (PRESET[c] ?? c) : '#8c959f')

/** Light fill derived from a color: the color mixed into white. */
export function fillOf(c?: Color, amount = 0.12): string {
  if (!c) return '#ffffff'
  const hex = PRESET[c] ?? c
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex)
  if (!m) return '#ffffff'
  const h = m[1].length === 3 ? [...m[1]].map((ch) => ch + ch).join('') : m[1]
  const mix = (i: number) => Math.round(255 + (parseInt(h.slice(i, i + 2), 16) - 255) * amount)
  return `rgb(${mix(0)}, ${mix(2)}, ${mix(4)})`
}

/** Wrapped lines with the one shared wrap rule (core/measure.ts wrapLines), so lines match layout sizes. */
export function wrapText(text: string, measure: Measure, fontSize: number, maxWidth?: number): string[] {
  const widthOf = (s: string) => measure(s, { fontSize }).width
  return text.split('\n').flatMap((p) => (maxWidth ? wrapLines(p.split(/\s+/), maxWidth, widthOf) : [p]))
}

/** Opaque fill of a group (also used behind edge labels that sit inside the group). */
export const groupFill = (g: CanvasNode) => (g.color ? fillOf(g.color, 0.06) : '#f3f5f6')

// ---------------------------------------------------------------- sketch (rough.js)

const gen = rough.generator()

/** Stable 31-bit seed from an id, so the wobble never changes between renders. */
export function seedOf(id: string): number {
  let h = 2166136261
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 16777619)
  return (h >>> 1) % 2147483646 || 1
}

export type SketchPath = { d: string; stroke: string; strokeWidth: number; fill?: string }
type Opts = { seed: number; stroke: string; fill?: string; strokeWidth?: number; roughness?: number }

const base = (o: Opts) => ({
  seed: o.seed,
  stroke: o.stroke,
  strokeWidth: o.strokeWidth ?? 1.5,
  roughness: o.roughness ?? 1.1,
  bowing: 1,
  fill: o.fill,
  fillStyle: 'solid',
})

export const sketchRect = (w: number, h: number, o: Opts): SketchPath[] => gen.toPaths(gen.rectangle(0, 0, w, h, base(o)))
export const sketchEllipse = (w: number, h: number, o: Opts): SketchPath[] => gen.toPaths(gen.ellipse(w / 2, h / 2, w, h, base(o)))
export const sketchPolygon = (pts: Point[], o: Opts): SketchPath[] => gen.toPaths(gen.polygon(pts.map((p) => [p.x, p.y]), base(o)))
export const sketchLine = (pts: Point[], o: Opts): SketchPath[] => gen.toPaths(gen.linearPath(pts.map((p) => [p.x, p.y]), base(o)))
export const sketchPath = (d: string, o: Opts): SketchPath[] => gen.toPaths(gen.path(d, base(o)))
