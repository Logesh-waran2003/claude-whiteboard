// In-place text editor: a textarea laid over the SVG text it replaces. It is laid out at world size
// (same font, size and wrap width as the measure) and scaled by the camera zoom, so the browser wraps
// exactly like the SVG at every zoom. Enter commits, Shift+Enter adds a line, Esc cancels, blur commits.
import { useLayoutEffect, useRef, useState } from 'react'
import { TYPE } from '../core/model'
import { ACCENT, FONT, INK } from './style'

export type EditorBox = {
  /** Screen px of the box's left edge and vertical centre, relative to the board. */
  left: number
  centreY: number
  /** World px. */
  width: number
  fontSize: number
  zoom: number
  align: 'center' | 'left'
  weight?: number
  background?: string
}

export function TextEditor({ initial, box, label, onDone }: { initial: string; box: EditorBox; label: string; onDone: (text: string | undefined) => void }) {
  const [value, setValue] = useState(initial)
  const [height, setHeight] = useState(box.fontSize * TYPE.lineHeight)
  const ref = useRef<HTMLTextAreaElement>(null)
  const done = useRef(false)
  const finish = (text: string | undefined) => {
    if (done.current) return
    done.current = true
    onDone(text)
  }

  useLayoutEffect(() => {
    const el = ref.current!
    el.focus({ preventScroll: true })
    el.select()
  }, [])
  // grow with the content: measure at height 0, then take the scroll height (world px, before scale)
  useLayoutEffect(() => {
    const el = ref.current!
    el.style.height = '0px'
    setHeight(el.scrollHeight)
    el.style.height = ''
  }, [value, box.width])

  return (
    <textarea
      ref={ref}
      aria-label={label}
      value={value}
      spellCheck={false}
      onChange={(e) => setValue(e.target.value)}
      onBlur={() => finish(value)}
      onPointerDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation()
        if (e.key === 'Escape') {
          e.preventDefault()
          finish(undefined)
        } else if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
          e.preventDefault()
          finish(value)
        }
      }}
      style={{
        position: 'absolute',
        left: box.left,
        top: box.centreY - (height * box.zoom) / 2,
        width: box.width,
        height,
        transform: `scale(${box.zoom})`,
        transformOrigin: '0 0',
        boxSizing: 'content-box',
        margin: 0,
        padding: 0,
        border: 0,
        outline: 'none',
        borderRadius: 3,
        boxShadow: `0 0 0 ${2 / box.zoom}px ${ACCENT}66`,
        background: box.background ?? 'transparent',
        color: INK,
        font: `${box.weight ?? 400} ${box.fontSize}px/${TYPE.lineHeight} ${FONT}`,
        textAlign: box.align,
        resize: 'none',
        overflow: 'hidden',
        whiteSpace: 'pre-wrap',
        overflowWrap: 'normal',
        wordBreak: 'normal',
        caretColor: ACCENT,
      }}
    />
  )
}
