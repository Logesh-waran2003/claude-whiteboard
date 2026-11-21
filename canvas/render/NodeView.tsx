// One node, drawn in local coordinates and placed with translate(x, y), so a move only changes
// the transform and the (possibly rough) shape is reused. Memoised by node identity.
import { memo, useMemo } from 'react'
import { CARD, cardBox } from '../core/card'
import { isImageNode, nodeText } from '../core/geometry'
import { type CanvasNode, type Measure, type ShapeKind, TYPE } from '../core/model'
import {
  ACCENT,
  INK,
  MUTED,
  STICKY_FILL,
  type SketchPath,
  fillOf,
  groupFill,
  groupStrokeOf,
  seedOf,
  sketchEllipse,
  sketchPolygon,
  sketchRect,
  strokeOf,
  wrapText,
} from './style'

export type Mode = 'clean' | 'sketch'

/**
 * Group label anchor (left, vertical centre) in group-local px; the label editor uses the same.
 * Inside the label strip the layout reserves (TYPE.groupLabelHeight), padded off the border like export-svg.
 */
export const GROUP_LABEL_X = 12
export const GROUP_LABEL_Y = 6 + TYPE.groupLabelHeight / 2

type ShapeProps = { id: string; kind: ShapeKind | 'group'; w: number; h: number; stroke: string; fill: string; mode: Mode }

const Paths = ({ paths }: { paths: SketchPath[] }) => (
  <>
    {paths.map((p, i) => (
      <path key={i} d={p.d} stroke={p.stroke} strokeWidth={p.strokeWidth} fill={p.fill ?? 'none'} strokeLinecap="round" />
    ))}
  </>
)

const diamond = (w: number, h: number) => [
  { x: w / 2, y: 0 },
  { x: w, y: h / 2 },
  { x: w / 2, y: h },
  { x: 0, y: h / 2 },
]

/** The outline + fill. Re-built only when size, look or mode changes. */
const Shape = memo(function Shape({ id, kind, w, h, stroke, fill, mode }: ShapeProps) {
  const sketch = useMemo(() => {
    if (mode !== 'sketch' || kind === 'text') return undefined
    const o = { seed: seedOf(id), stroke, fill, strokeWidth: kind === 'group' ? 1.25 : 1.5, roughness: kind === 'group' ? 0.8 : 1.1 }
    if (kind === 'ellipse') return sketchEllipse(w, h, o)
    if (kind === 'diamond') return sketchPolygon(diamond(w, h), o)
    return sketchRect(w, h, o)
  }, [id, kind, w, h, stroke, fill, mode])
  if (kind === 'text') return null
  if (sketch) return <Paths paths={sketch} />
  if (kind === 'ellipse') return <ellipse cx={w / 2} cy={h / 2} rx={w / 2} ry={h / 2} fill={fill} stroke={stroke} strokeWidth={1.5} />
  if (kind === 'diamond')
    return <polygon points={diamond(w, h).map((p) => `${p.x},${p.y}`).join(' ')} fill={fill} stroke={stroke} strokeWidth={1.5} strokeLinejoin="round" />
  if (kind === 'sticky')
    return (
      <>
        <rect x={2} y={3} width={w} height={h} rx={3} fill="rgba(0,0,0,0.06)" />
        <rect width={w} height={h} rx={3} fill={fill} stroke={stroke} strokeWidth={1} />
      </>
    )
  const group = kind === 'group'
  return <rect width={w} height={h} rx={group ? 12 : 8} fill={fill} stroke={stroke} strokeWidth={group ? 1.25 : 1.5} />
})

/** Lines centred in a w x h box, one <tspan> per line. */
export function TextLines({ lines, w, h, fontSize, color, weight }: { lines: string[]; w: number; h: number; fontSize: number; color: string; weight?: number }) {
  const lh = fontSize * TYPE.lineHeight
  const top = h / 2 - (lines.length * lh) / 2 + lh / 2
  return (
    <text x={w / 2} y={top} fontSize={fontSize} fill={color} fontWeight={weight} textAnchor="middle" dominantBaseline="central">
      {lines.map((l, i) => (
        <tspan key={i} x={w / 2} dy={i ? lh : 0}>
          {l}
        </tspan>
      ))}
    </text>
  )
}

const FileIcon = () => (
  <g transform="translate(10 10)" fill="none" stroke={MUTED} strokeWidth={1.25} strokeLinejoin="round" aria-hidden>
    <path d="M1 0.5h7l4 4v11H1z" />
    <path d="M8 0.5v4h4" />
  </g>
)

/** `editing`: the text editor overlay is open on this node, so its own text is hidden. */
export const NodeView = memo(function NodeView({ node, measure, mode, editing }: { node: CanvasNode; measure: Measure; mode: Mode; editing?: boolean }) {
  const { id, width: w, height: h } = node
  if (node.type === 'group') {
    const stroke = groupStrokeOf(node.color)
    return (
      <g transform={`translate(${node.x} ${node.y})`} data-id={id}>
        <Shape id={id} kind="group" w={w} h={h} stroke={stroke} fill={groupFill(node)} mode={mode} />
        {node.label && !editing && (
          <text x={GROUP_LABEL_X} y={GROUP_LABEL_Y} fontSize={TYPE.groupLabelFontSize} fontWeight={600} fill={node.color ? stroke : MUTED} dominantBaseline="central">
            {node.label}
          </text>
        )}
      </g>
    )
  }
  if (node.type === 'file' && isImageNode(node)) {
    // The path is relative to the board file; the app serves the board folder's assets at /assets.
    return (
      <g transform={`translate(${node.x} ${node.y})`} data-id={id}>
        <rect width={w} height={h} rx={4} fill="#fff" stroke="#d0d7de" strokeWidth={1} />
        <image href={`/${node.file.replace(/^\/+/, '')}`} width={w} height={h} preserveAspectRatio="xMidYMid meet" />
      </g>
    )
  }
  const kind = node['x-shape'] ?? 'rect'
  if (kind === 'card') return <CardView node={node} measure={measure} editing={editing} />
  const stroke = strokeOf(node.color)
  const fill = kind === 'sticky' ? (node.color ? fillOf(node.color, 0.3) : STICKY_FILL) : fillOf(node.color)
  return (
    <g transform={`translate(${node.x} ${node.y})`} data-id={id}>
      <Shape id={id} kind={kind} w={w} h={h} stroke={kind === 'sticky' && !node.color ? '#e6d77a' : stroke} fill={fill} mode={mode} />
      {node.type === 'file' && <FileIcon />}
      {!editing && <NodeText text={nodeText(node)} w={w} h={h} measure={measure} color={node.type === 'link' ? ACCENT : INK} />}
    </g>
  )
})

const NodeText = memo(function NodeText({ text, w, h, measure, color }: { text: string; w: number; h: number; measure: Measure; color: string }) {
  const lines = useMemo(() => wrapText(text, measure, TYPE.nodeFontSize, Math.max(1, w - TYPE.nodePadding * 2)), [text, w, measure])
  return <TextLines lines={lines} w={w} h={h} fontSize={TYPE.nodeFontSize} color={color} />
})

/** Card: colour stripe, bold title, muted body lines, optional progress bar with its percent. */
const CardView = memo(function CardView({ node, measure, editing }: { node: CanvasNode; measure: Measure; editing?: boolean }) {
  const { id, width: w, height: h } = node
  const progress = typeof node['x-progress'] === 'number' ? node['x-progress'] : undefined
  const box = useMemo(() => cardBox(nodeText(node), w, measure, progress), [node, w, measure, progress])
  const accent = node.color ? strokeOf(node.color) : '#8c959f'
  const x = CARD.padding + CARD.stripe
  const line = (fs: number) => fs * TYPE.lineHeight
  const clip = `card-${id}`
  return (
    <g transform={`translate(${node.x} ${node.y})`} data-id={id}>
      <clipPath id={clip}>
        <rect width={w} height={h} rx={10} />
      </clipPath>
      <rect x={1} y={2} width={w} height={h} rx={10} fill="rgba(0,0,0,0.05)" />
      <rect width={w} height={h} rx={10} fill="#fff" stroke="#d0d7de" strokeWidth={1} />
      <rect width={CARD.stripe} height={h} fill={accent} clipPath={`url(#${clip})`} />
      {!editing && (
        <>
          <text x={x} fontSize={CARD.titleSize} fontWeight={600} fill={INK} dominantBaseline="central">
            {box.title.map((l, i) => (
              <tspan key={i} x={x} y={box.titleY + (i + 0.5) * line(CARD.titleSize)}>
                {l}
              </tspan>
            ))}
          </text>
          <text x={x} fontSize={CARD.bodySize} fill={MUTED} dominantBaseline="central">
            {box.body.map((l, i) => (
              <tspan key={i} x={x} y={box.bodyY + (i + 0.5) * line(CARD.bodySize)}>
                {l}
              </tspan>
            ))}
          </text>
        </>
      )}
      {progress !== undefined && (
        <>
          <rect x={x} y={box.barY} width={w - x - CARD.padding} height={CARD.bar} rx={CARD.bar / 2} fill="#eaeef2" />
          <rect x={x} y={box.barY} width={((w - x - CARD.padding) * progress) / 100} height={CARD.bar} rx={CARD.bar / 2} fill={accent} />
          <text x={x} y={box.barY + CARD.bar + line(CARD.bodySize) / 2 + 2} fontSize={12} fill={MUTED} dominantBaseline="central">
            {Math.round(progress)}%
          </text>
        </>
      )}
    </g>
  )
})
