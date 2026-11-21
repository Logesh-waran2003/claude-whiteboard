// Card shape: a title line, short body lines and an optional progress bar. One layout function,
// shared by sizing (layout engine), the renderer and the SVG export, so all three agree.
import { wrapLines } from './measure'
import { type Measure, TYPE } from './model'

export const CARD = {
  width: 240,
  padding: 14,
  titleSize: 16,
  bodySize: 13,
  gap: 4, // title -> body
  bar: 6, // progress bar height
  barGap: 12, // text -> bar
  stripe: 5, // colour stripe on the left
} as const

export type CardBox = {
  title: string[]
  body: string[]
  /** Top of each text block and of the bar, card-local px. */
  titleY: number
  bodyY: number
  barY: number
  height: number
}

/** Width that fits the longest line, from CARD.width up to TYPE.maxNodeWidth (then lines wrap). */
export function cardWidth(text: string, measure: Measure): number {
  const [head = '', ...rest] = text.split('\n')
  const longest = Math.max(measure(head, { fontSize: CARD.titleSize }).width, ...rest.map((l) => measure(l, { fontSize: CARD.bodySize }).width))
  return Math.ceil(Math.min(TYPE.maxNodeWidth, Math.max(CARD.width, longest + 2 * CARD.padding + CARD.stripe + 2)))
}

/** First line = title, other lines = body. `progress` adds the bar. */
export function cardBox(text: string, width: number, measure: Measure, progress?: number): CardBox {
  const P = CARD.padding
  const inner = Math.max(1, width - 2 * P - CARD.stripe)
  const [head = '', ...rest] = text.split('\n')
  const wrap = (s: string, fontSize: number) => wrapLines(s.split(/\s+/).filter(Boolean), inner, (t) => measure(t, { fontSize }).width)
  const title = wrap(head, CARD.titleSize)
  const body = rest.flatMap((l) => wrap(l, CARD.bodySize))
  const lh = (n: number, fs: number) => n * fs * TYPE.lineHeight
  const titleY = P
  const bodyY = titleY + lh(title.length, CARD.titleSize) + (body.length ? CARD.gap : 0)
  const textEnd = bodyY + lh(body.length, CARD.bodySize)
  const barY = textEnd + CARD.barGap
  const end = progress === undefined ? textEnd : barY + CARD.bar + CARD.bodySize * TYPE.lineHeight
  return { title, body, titleY, bodyY, barY, height: Math.ceil(Math.max(TYPE.minNode.height, end + P)) }
}
