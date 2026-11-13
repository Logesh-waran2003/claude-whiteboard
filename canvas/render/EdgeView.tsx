// One edge: polyline from geometry.edgePath, arrowheads per fromEnd/toEnd, label box from
// geometry.edgeLabelBox with a paper background so the line never runs through the text.
import { memo, useMemo } from 'react'
import { edgeLabelBox, pathLength } from '../core/geometry'
import { type CanvasEdge, type CanvasNode, type Measure, type Point, TYPE } from '../core/model'
import type { Mode } from './NodeView'
import { TextLines } from './NodeView'
import { INK, PAPER, groupFill, seedOf, sketchLine, sketchPolygon, strokeOf, wrapText } from './style'

const ARROW = 11
const ARROW_HALF = 5

/** Arrowhead triangle at `tip`, pointing away from `from`. */
function arrowHead(from: Point, tip: Point): Point[] {
  const len = Math.hypot(tip.x - from.x, tip.y - from.y) || 1
  const ux = (tip.x - from.x) / len
  const uy = (tip.y - from.y) / len
  const bx = tip.x - ux * ARROW
  const by = tip.y - uy * ARROW
  return [tip, { x: bx - uy * ARROW_HALF, y: by + ux * ARROW_HALF }, { x: bx + uy * ARROW_HALF, y: by - ux * ARROW_HALF }]
}

/** Pull an end point back so the stroke stops under the arrowhead instead of poking through its tip. */
function pullBack(from: Point, tip: Point, by: number): Point {
  const len = Math.hypot(tip.x - from.x, tip.y - from.y)
  if (len <= by) return tip
  return { x: tip.x - ((tip.x - from.x) / len) * by, y: tip.y - ((tip.y - from.y) / len) * by }
}

const toD = (pts: Point[]) => pts.map((p, i) => `${i ? 'L' : 'M'}${p.x} ${p.y}`).join('')

type EdgeProps = { edge: CanvasEdge; path: Point[]; measure: Measure; mode: Mode; labelGroup?: CanvasNode; editing?: boolean }

export const EdgeView = memo(function EdgeView({ edge, path, measure, mode, labelGroup, editing }: EdgeProps) {
  const color = strokeOf(edge.color)
  const toArrow = (edge.toEnd ?? 'arrow') === 'arrow'
  const fromArrow = edge.fromEnd === 'arrow'
  const n = path.length

  const geo = useMemo(() => {
    const line = [...path]
    const heads: Point[][] = []
    if (toArrow && n >= 2) {
      heads.push(arrowHead(path[n - 2], path[n - 1]))
      line[n - 1] = pullBack(path[n - 2], path[n - 1], ARROW * 0.8)
    }
    if (fromArrow && n >= 2) {
      heads.push(arrowHead(path[1], path[0]))
      line[0] = pullBack(path[1], path[0], ARROW * 0.8)
    }
    let label: { x: number; y: number; width: number; height: number; lines: string[] } | undefined
    if (edge.label) {
      const { box, wrapped } = edgeLabelBox(path, edge.label, measure)
      const pad = TYPE.labelPadding
      const room = Math.max(24, pathLength(path) - 48) // same rule as geometry.edgeLabelBox
      label = { ...box, lines: wrapText(edge.label, measure, TYPE.labelFontSize, wrapped ? room - pad * 2 : undefined) }
    }
    return { line, heads, label }
  }, [path, n, toArrow, fromArrow, edge.label, measure])

  const sketch = useMemo(() => {
    if (mode !== 'sketch') return undefined
    const seed = seedOf(edge.id)
    return [
      ...sketchLine(geo.line, { seed, stroke: color, roughness: 0.9 }),
      ...geo.heads.flatMap((h, i) => sketchPolygon(h, { seed: seed + i + 1, stroke: color, fill: color, roughness: 0.5, strokeWidth: 1 })),
    ]
  }, [mode, edge.id, geo, color])

  return (
    <g data-id={edge.id}>
      {sketch ? (
        sketch.map((p, i) => <path key={i} d={p.d} stroke={p.stroke} strokeWidth={p.strokeWidth} fill={p.fill ?? 'none'} strokeLinecap="round" />)
      ) : (
        <>
          <path d={toD(geo.line)} fill="none" stroke={color} strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round" />
          {geo.heads.map((h, i) => (
            <polygon key={i} points={h.map((p) => `${p.x},${p.y}`).join(' ')} fill={color} stroke={color} strokeWidth={1} strokeLinejoin="round" />
          ))}
        </>
      )}
      {geo.label && (
        <g transform={`translate(${geo.label.x} ${geo.label.y})`}>
          <rect width={geo.label.width} height={geo.label.height} rx={4} fill={labelGroup ? groupFill(labelGroup) : PAPER} />
          {!editing && <TextLines lines={geo.label.lines} w={geo.label.width} h={geo.label.height} fontSize={TYPE.labelFontSize} color={edge.color ? color : INK} />}
        </g>
      )}
    </g>
  )
})
