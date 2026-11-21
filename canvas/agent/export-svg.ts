// M5. Static SVG export of a board (or part of it). Pure. Used by the `snapshot` tool; start of M8 export.
import { CARD, cardBox } from '../core/card'
import { boundsOf, edgeLabelBox, edgePath, isImageNode, nodeById, nodeText } from '../core/geometry'
import { wrapLines } from '../core/measure'
import { type CanvasDoc, type CanvasNode, type Color, type Measure, type Rect, TYPE } from '../core/model'

const PRESET: Record<string, string> = { '1': '#e03131', '2': '#f08c00', '3': '#f2c94c', '4': '#2f9e44', '5': '#1098ad', '6': '#7048e8' }
const INK = '#1f2328'
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
const hex = (c: Color | undefined) => (c ? (PRESET[c] ?? c) : undefined)
const n0 = (v: number) => Math.round(v * 10) / 10

/** Wrapped, centred text lines inside `box`. */
function textBlock(text: string, box: Rect, fontSize: number, maxWidth: number, measure: Measure, anchor: 'middle' | 'start' = 'middle'): string {
  const widthOf = (s: string) => measure(s, { fontSize }).width
  const lines = text.split('\n').flatMap((p) => wrapLines(p.split(/\s+/).filter(Boolean), Math.max(1, maxWidth), widthOf))
  const lh = fontSize * TYPE.lineHeight
  const top = box.y + box.height / 2 - (lines.length * lh) / 2 + lh / 2
  const x = anchor === 'middle' ? box.x + box.width / 2 : box.x
  return lines
    .map((l, i) => `<text x="${n0(x)}" y="${n0(top + i * lh)}" font-size="${fontSize}" text-anchor="${anchor}" dominant-baseline="central">${esc(l)}</text>`)
    .join('')
}

function shape(n: CanvasNode, measure: Measure): string {
  const stroke = hex(n.color) ?? INK
  const { x, y, width: w, height: h } = n
  if (n.type === 'group') {
    const label = n.label ? textBlock(n.label, { x: x + 12, y: y + 4, width: w, height: TYPE.groupLabelHeight }, TYPE.groupLabelFontSize, Infinity, measure, 'start') : ''
    return `<g class="group"><rect x="${n0(x)}" y="${n0(y)}" width="${n0(w)}" height="${n0(h)}" rx="10" fill="${hex(n.color) ? stroke + '14' : '#f6f7f9'}" stroke="${hex(n.color) ?? '#c9ced6'}" stroke-dasharray="6 4"/>${label}</g>`
  }
  if (n.type === 'file' && isImageNode(n)) {
    // The picture itself is not embedded (paths are relative to the board); show a labelled frame.
    return `<g class="node" data-id="${esc(n.id)}"><rect x="${n0(x)}" y="${n0(y)}" width="${n0(w)}" height="${n0(h)}" rx="4" fill="#f6f8fa" stroke="#d0d7de" stroke-dasharray="4 3"/>${textBlock('image: ' + nodeText(n), n, TYPE.labelFontSize, w - 16, measure)}</g>`
  }
  const kind = n.type === 'text' ? (n['x-shape'] ?? 'rect') : 'rect'
  if (kind === 'card') return card(n, measure)
  const fill = kind === 'sticky' ? '#fff3a8' : '#ffffff'
  let body: string
  let inner = w - 2 * TYPE.nodePadding
  if (kind === 'ellipse') {
    body = `<ellipse cx="${n0(x + w / 2)}" cy="${n0(y + h / 2)}" rx="${n0(w / 2)}" ry="${n0(h / 2)}" fill="${fill}" stroke="${stroke}" stroke-width="1.5"/>`
    inner = w / 1.4 - 2 * TYPE.nodePadding
  } else if (kind === 'diamond') {
    const pts = [[x + w / 2, y], [x + w, y + h / 2], [x + w / 2, y + h], [x, y + h / 2]].map((p) => p.map(n0).join(',')).join(' ')
    body = `<polygon points="${pts}" fill="${fill}" stroke="${stroke}" stroke-width="1.5"/>`
    inner = w / 1.4 - 2 * TYPE.nodePadding
  } else if (kind === 'text') body = ''
  else body = `<rect x="${n0(x)}" y="${n0(y)}" width="${n0(w)}" height="${n0(h)}" rx="${kind === 'sticky' ? 2 : 8}" fill="${fill}" stroke="${kind === 'sticky' ? '#e0c84a' : stroke}" stroke-width="1.5"/>`
  return `<g class="node" data-id="${esc(n.id)}">${body}${textBlock(nodeText(n), n, TYPE.nodeFontSize, inner, measure)}</g>`
}

function card(n: CanvasNode, measure: Measure): string {
  const { x, y, width: w, height: h } = n
  const p = typeof n['x-progress'] === 'number' ? n['x-progress'] : undefined
  const b = cardBox(nodeText(n), w, measure, p)
  const accent = hex(n.color) ?? '#8c959f'
  const tx = x + CARD.padding + CARD.stripe
  const lh = (fs: number) => fs * TYPE.lineHeight
  const lines = (ls: string[], top: number, fs: number, extra: string) =>
    ls.map((l, i) => `<text x="${n0(tx)}" y="${n0(y + top + (i + 0.5) * lh(fs))}" font-size="${fs}" dominant-baseline="central"${extra}>${esc(l)}</text>`).join('')
  const barW = w - (tx - x) - CARD.padding
  const bar =
    p === undefined
      ? ''
      : `<rect x="${n0(tx)}" y="${n0(y + b.barY)}" width="${n0(barW)}" height="${CARD.bar}" rx="3" fill="#eaeef2"/>` +
        `<rect x="${n0(tx)}" y="${n0(y + b.barY)}" width="${n0((barW * p) / 100)}" height="${CARD.bar}" rx="3" fill="${accent}"/>` +
        `<text x="${n0(tx)}" y="${n0(y + b.barY + CARD.bar + lh(CARD.bodySize) / 2 + 2)}" font-size="12" fill="#57606a" dominant-baseline="central">${Math.round(p)}%</text>`
  return (
    `<g class="node card" data-id="${esc(n.id)}"><rect x="${n0(x)}" y="${n0(y)}" width="${n0(w)}" height="${n0(h)}" rx="10" fill="#ffffff" stroke="#d0d7de"/>` +
    `<rect x="${n0(x)}" y="${n0(y + 6)}" width="${CARD.stripe}" height="${n0(h - 12)}" fill="${accent}"/>` +
    lines(b.title, b.titleY, CARD.titleSize, ' font-weight="600"') +
    lines(b.body, b.bodyY, CARD.bodySize, ' fill="#57606a"') +
    bar +
    '</g>'
  )
}

/** Clean static SVG of the board. `ids` limits it to those nodes (groups bring their descendants) and edges among them. */
export function toSVG(doc: CanvasDoc, measure: Measure, opts: { ids?: string[]; padding?: number } = {}): string {
  const pad = opts.padding ?? 24
  let nodes = doc.nodes
  if (opts.ids?.length) {
    const keep = new Set(opts.ids)
    for (let grew = true; grew; ) {
      grew = false
      for (const n of doc.nodes) if (n['x-parent'] && keep.has(n['x-parent']) && !keep.has(n.id)) (keep.add(n.id), (grew = true))
    }
    nodes = doc.nodes.filter((n) => keep.has(n.id))
  }
  const shown = new Set(nodes.map((n) => n.id))
  const byId = nodeById(doc)
  const edges = doc.edges.filter((e) => shown.has(e.fromNode) && shown.has(e.toNode) || opts.ids?.includes(e.id))
  const paths = edges.map((e) => ({ e, path: edgePath(doc, e, byId) })).filter((p) => p.path)
  const labels = paths.filter((p) => p.e.label).map((p) => ({ e: p.e, ...edgeLabelBox(p.path!, p.e.label!, measure) }))
  const b = boundsOf([...nodes, ...labels.map((l) => l.box), ...paths.flatMap((p) => p.path!.map((q) => ({ ...q, width: 0, height: 0 })))]) ?? { x: 0, y: 0, width: 0, height: 0 }
  const vb = [b.x - pad, b.y - pad, b.width + 2 * pad, b.height + 2 * pad].map(n0)

  const out: string[] = [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${vb.join(' ')}" width="${vb[2]}" height="${vb[3]}" font-family="Inter, system-ui, sans-serif" fill="${INK}">`,
    `<defs><marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="${INK}"/></marker></defs>`,
    `<rect x="${vb[0]}" y="${vb[1]}" width="${vb[2]}" height="${vb[3]}" fill="#ffffff"/>`,
  ]
  for (const n of nodes) if (n.type === 'group') out.push(shape(n, measure))
  for (const { e, path } of paths) {
    const d = path!.map((p, i) => `${i ? 'L' : 'M'}${n0(p.x)},${n0(p.y)}`).join(' ')
    const end = e.toEnd !== 'none' ? ' marker-end="url(#arrow)"' : ''
    const start = e.fromEnd === 'arrow' ? ' marker-start="url(#arrow)"' : ''
    out.push(`<path data-id="${esc(e.id)}" d="${d}" fill="none" stroke="${hex(e.color) ?? INK}" stroke-width="1.5"${end}${start}/>`)
  }
  for (const n of nodes) if (n.type !== 'group') out.push(shape(n, measure))
  for (const { e, box } of labels) {
    out.push(
      `<g class="label"><rect x="${n0(box.x)}" y="${n0(box.y)}" width="${n0(box.width)}" height="${n0(box.height)}" rx="4" fill="#ffffff"/>` +
        textBlock(e.label!, box, TYPE.labelFontSize, box.width - 2 * TYPE.labelPadding, measure) +
        '</g>',
    )
  }
  out.push('</svg>')
  return out.join('\n')
}
