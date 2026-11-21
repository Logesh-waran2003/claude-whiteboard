import { cardBox, cardWidth } from '../core/card'
import { nodeText } from '../core/geometry'
import { type CanvasNode, type Measure, TYPE } from '../core/model'

const P = TYPE.nodePadding
// Diamonds and ellipses lose their corners, so the same text needs a bigger shape.
const ROUND = 1.4

const text0 = (n: CanvasNode) => nodeText(n)

/** Size of a non-group node from its text. */
export function sizeFor(n: CanvasNode, measure: Measure): { width: number; height: number } {
  const text = nodeText(n)
  const shape = n.type === 'group' ? 'rect' : n['x-shape']
  const fontSize = TYPE.nodeFontSize
  if (shape === 'card') {
    const width = cardWidth(text0(n), measure)
    return { width, height: cardBox(text0(n), width, measure, n['x-progress']).height }
  }
  if (shape === 'sticky') {
    const t = measure(text, { fontSize, maxWidth: TYPE.sticky.width - 2 * P })
    return { width: TYPE.sticky.width, height: Math.max(TYPE.sticky.height, t.height + 2 * P) }
  }
  const one = measure(text, { fontSize })
  let width = one.width + 2 * P
  let textH = one.height
  if (width > TYPE.maxNodeWidth) {
    width = TYPE.maxNodeWidth
    textH = measure(text, { fontSize, maxWidth: TYPE.maxNodeWidth - 2 * P }).height
  }
  width = Math.max(TYPE.minNode.width, width)
  let height = Math.max(TYPE.minNode.height, textH + 2 * P)
  if (shape === 'diamond' || shape === 'ellipse') {
    width = Math.ceil(width * ROUND)
    height = Math.ceil(height * ROUND)
  }
  return { width: Math.ceil(width), height: Math.ceil(height) }
}

/** Minimum group width so its label fits on one line. */
export function groupLabelWidth(label: string | undefined, measure: Measure): number {
  if (!label) return 0
  return measure(label, { fontSize: TYPE.groupLabelFontSize }).width + 2 * P
}
