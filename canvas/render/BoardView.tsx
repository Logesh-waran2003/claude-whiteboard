// The board renderer: SVG, camera, selection, move, resize, create, connect, text editing and
// clipboard. It never mutates the doc; every user change is an op sent through board.apply, so user
// and agent share one undo stack.
import { type Ref, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { contains, nodeText, pointAt, sidePoint } from '../core/geometry'
import { type BoardApi, type CanvasDoc, type CanvasNode, type Measure, type Op, type Point, type Rect, type Side, TYPE } from '../core/model'
import { type Camera, type Size, type Viewport, panBy, fitCamera, lerpCamera, rectToScreen, toScreen, toWorld, viewportOf, wheelZoomFactor, zoomAt } from './camera'
import { EdgeView } from './EdgeView'
import { GROUP_LABEL_X, GROUP_LABEL_Y, type Mode, NodeView } from './NodeView'
import { type CreateKind, type Tool, connectOps, copyPayload, createOp, createRect, parsePayload, pasteOps, reparentOps } from './ops'
import {
  HANDLES,
  type Handle,
  type Scene,
  buildScene,
  cull,
  docBounds,
  groupAt,
  handlePoint,
  hitTest,
  marqueeSelect,
  movingSet,
  moveRoots,
  normRect,
  previewDoc,
  resizeRect,
} from './scene'
import { ACCENT, FONT, PAPER, groupFill } from './style'
import { type EditorBox, TextEditor } from './TextEditor'
import { TOOL_KEYS, Toolbar } from './Toolbar'

export type BoardViewHandle = {
  zoomToFit(ids?: string[]): void
  select(ids: string[]): void
  getViewport(): Viewport
}

export type BoardViewProps = {
  board: BoardApi
  measure: Measure
  mode?: Mode
  actor?: string
  onSelectionChange?: (ids: string[]) => void
  onViewportChange?: (vp: Viewport) => void
  handleRef?: Ref<BoardViewHandle>
}

type Preview = { moved: Set<string>; dx: number; dy: number; resized?: { id: string; rect: Rect } }
type Gesture =
  | { kind: 'pan'; last: Point }
  | { kind: 'press'; start: Point; id: string; shift: boolean; wasSelected: boolean }
  | { kind: 'move'; start: Point; roots: string[]; moved: Set<string>; dx: number; dy: number }
  | { kind: 'resize'; start: Point; id: string; handle: Handle; rect: Rect; out: Rect }
  | { kind: 'marquee'; start: Point; base: string[] }
  | { kind: 'create'; start: Point; shape: CreateKind; dragged: boolean }
  | { kind: 'connect'; start: Point; from: string; side?: Side }
/** What the text editor is open on. `isNew`: the node was just created, so the edit merges into that undo step. */
type Editing = { kind: 'node' | 'label' | 'edge'; id: string; isNew?: boolean }
type Connecting = { from: Point; to: Point; target?: string }

const DRAG_THRESHOLD = 3 // screen px
const HANDLE = 8 // screen px
const SIDE_HANDLE_GAP = 14 // screen px between a node side and its connect handle
const GRID = 24 // world px
const PASTE_OFFSET = 24 // world px
const SIDES: Side[] = ['top', 'right', 'bottom', 'left']
const OUT: Record<Side, Point> = { top: { x: 0, y: -1 }, right: { x: 1, y: 0 }, bottom: { x: 0, y: 1 }, left: { x: -1, y: 0 } }
const CURSOR: Record<Handle, string> = { nw: 'nwse-resize', se: 'nwse-resize', ne: 'nesw-resize', sw: 'nesw-resize', n: 'ns-resize', s: 'ns-resize', e: 'ew-resize', w: 'ew-resize' }

const isMod = (e: { metaKey: boolean; ctrlKey: boolean }) => e.metaKey || e.ctrlKey
const reducedMotion = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches
const sameIds = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x === b[i])

/** Connect handle centres (screen px), just outside each side midpoint. */
const sideHandles = (r: Rect) => SIDES.map((side) => ({ side, p: { x: sidePoint(r, side).x + OUT[side].x * SIDE_HANDLE_GAP, y: sidePoint(r, side).y + OUT[side].y * SIDE_HANDLE_GAP } }))

export function BoardView({ board, measure, mode = 'clean', actor = 'user', onSelectionChange, onViewportChange, handleRef }: BoardViewProps) {
  const doc = useSyncExternalStore(
    useCallback((cb: () => void) => board.subscribe(() => cb()), [board]),
    () => board.doc,
  )
  const svgRef = useRef<SVGSVGElement>(null)
  const [size, setSize] = useState<Size>({ width: 0, height: 0 })
  const [cam, setCamState] = useState<Camera>({ x: 0, y: 0, zoom: 1 })
  const [selection, setSelectionState] = useState<string[]>([])
  const [preview, setPreview] = useState<Preview | undefined>()
  const [marquee, setMarquee] = useState<Rect | undefined>()
  const [tool, setToolState] = useState<Tool>('select')
  const [hover, setHover] = useState<string | undefined>()
  const [editing, setEditing] = useState<Editing | undefined>()
  const [connecting, setConnecting] = useState<Connecting | undefined>()
  const [creating, setCreating] = useState<Rect | undefined>()
  const [dropGroup, setDropGroup] = useState<string | undefined>()

  // refs mirror state for event handlers (no stale closures, no re-binding listeners)
  const camRef = useRef(cam)
  const selRef = useRef(selection)
  const sizeRef = useRef(size)
  const toolRef = useRef(tool)
  const hoverRef = useRef(hover)
  const gesture = useRef<Gesture | undefined>(undefined)
  const space = useRef(false)
  const anim = useRef(0)
  const clip = useRef<{ text: string; count: number } | undefined>(undefined)
  const pendingPaste = useRef(0)
  sizeRef.current = size
  hoverRef.current = hover

  const setCam = useCallback((c: Camera) => {
    camRef.current = c
    setCamState(c)
  }, [])
  const setSelection = useCallback((ids: string[]) => {
    if (sameIds(ids, selRef.current)) return
    selRef.current = ids
    setSelectionState(ids)
  }, [])
  const setTool = useCallback((t: Tool) => {
    toolRef.current = t
    setToolState(t)
  }, [])

  // ---------------------------------------------------------------- scene (doc + live preview)
  const shown: CanvasDoc = useMemo(
    () => (preview ? previewDoc(doc, preview.moved, preview.dx, preview.dy, preview.resized) : doc),
    [doc, preview],
  )
  const prevScene = useRef<Scene | undefined>(undefined)
  const scene = useMemo(() => (prevScene.current = buildScene(shown, prevScene.current)), [shown])
  const sceneRef = useRef(scene)
  sceneRef.current = scene

  const exists = (id: string) => sceneRef.current.byId.has(id) || sceneRef.current.doc.edges.some((e) => e.id === id)

  // drop selected / hovered / edited ids that no longer exist (undo, agent removal)
  useEffect(() => {
    setSelection(selRef.current.filter(exists))
    if (hoverRef.current && !exists(hoverRef.current)) setHover(undefined)
    setEditing((ed) => (ed && !exists(ed.id) ? undefined : ed))
  }, [doc]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => onSelectionChange?.(selection), [selection, onSelectionChange])
  useEffect(() => {
    if (size.width) onViewportChange?.(viewportOf(cam, size))
  }, [cam, size, onViewportChange])

  // ---------------------------------------------------------------- camera
  const animateTo = useCallback(
    (target: Camera) => {
      cancelAnimationFrame(anim.current)
      if (reducedMotion()) return setCam(target)
      const from = camRef.current
      const t0 = performance.now()
      const step = (now: number) => {
        const t = Math.min(1, (now - t0) / 200)
        setCam(lerpCamera(from, target, 1 - (1 - t) ** 3))
        if (t < 1) anim.current = requestAnimationFrame(step)
      }
      anim.current = requestAnimationFrame(step)
    },
    [setCam],
  )

  const zoomToFit = useCallback(
    (ids?: string[], animate = true) => {
      const b = docBounds(board.doc, ids?.length ? ids : undefined)
      if (!b || !sizeRef.current.width) return
      const target = fitCamera(b, sizeRef.current)
      if (animate) animateTo(target)
      else setCam(target)
    },
    [board, animateTo, setCam],
  )

  useImperativeHandle(handleRef, () => ({
    zoomToFit: (ids) => zoomToFit(ids),
    select: (ids) => setSelection(ids.filter(exists)),
    getViewport: () => viewportOf(camRef.current, sizeRef.current),
  }))

  // size + first fit
  const fitted = useRef(false)
  useEffect(() => {
    const el = svgRef.current!
    const ro = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect
      sizeRef.current = { width, height }
      setSize({ width, height })
      if (!fitted.current && width) {
        fitted.current = true
        zoomToFit(undefined, false)
      }
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [zoomToFit])

  // wheel: pan, or zoom at cursor with pinch / ctrl / cmd. Native listener: React's is passive.
  useEffect(() => {
    const el = svgRef.current!
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      cancelAnimationFrame(anim.current)
      const r = el.getBoundingClientRect()
      const c = camRef.current
      if (e.ctrlKey || e.metaKey) {
        setCam(zoomAt(c, { x: e.clientX - r.left, y: e.clientY - r.top }, c.zoom * wheelZoomFactor(e.deltaY, e.deltaMode)))
      } else {
        const k = e.deltaMode === 1 ? 16 : 1
        setCam(panBy(c, e.deltaX * k, e.deltaY * k))
      }
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [setCam])

  useEffect(() => () => cancelAnimationFrame(anim.current), [])

  // ---------------------------------------------------------------- ops
  const apply = useCallback((ops: Op[], merge = false) => board.apply(ops, { by: actor, mergeWithPrevious: merge }), [board, actor])

  const nodeSelection = () => selRef.current.filter((id) => sceneRef.current.byId.has(id))

  const nudge = (dx: number, dy: number) => {
    const roots = moveRoots(sceneRef.current.byId, nodeSelection())
    if (roots.length) apply([{ op: 'move', ids: roots, dx, dy }])
  }

  const focusBoard = () => svgRef.current?.focus({ preventScroll: true })

  /** Open the editor on a node (text or group label) or an edge label, if that item has editable text. */
  const startEditing = (id: string, isNew = false) => {
    const d = board.doc // not the scene: a node created in this event is not rendered yet
    const n = d.nodes.find((x) => x.id === id)
    if (n?.type === 'group') setEditing({ kind: 'label', id, isNew })
    else if (n?.type === 'text') setEditing({ kind: 'node', id, isNew })
    else if (!n && d.edges.some((e) => e.id === id)) setEditing({ kind: 'edge', id, isNew })
  }

  const finishEditing = (ed: Editing, text: string | undefined) => {
    setEditing(undefined)
    focusBoard()
    const d = board.doc
    if (ed.kind === 'edge') {
      const e = d.edges.find((x) => x.id === ed.id)
      if (e && text !== undefined && text !== (e.label ?? '')) apply([{ op: 'update_edge', id: ed.id, label: text }], ed.isNew)
      return
    }
    const n = d.nodes.find((x) => x.id === ed.id)
    if (!n) return
    const old = n.type === 'group' ? (n.label ?? '') : nodeText(n)
    const final = text ?? old
    // a new free-text node left empty would be invisible: drop it with its create step
    if (ed.isNew && n.type === 'text' && n['x-shape'] === 'text' && !final.trim()) {
      apply([{ op: 'remove', ids: [n.id] }], true)
      return
    }
    if (text !== undefined && text !== old) apply([{ op: 'update', id: ed.id, text }], ed.isNew)
  }

  // ---------------------------------------------------------------- clipboard
  const doCopy = (): string | undefined => {
    const payload = copyPayload(board.doc, selRef.current)
    if (!payload.nodes.length) return undefined
    const text = JSON.stringify(payload, null, 2)
    clip.current = { text, count: 0 }
    return text
  }

  const doPaste = (text?: string) => {
    let c = clip.current
    const external = text !== undefined && text !== c?.text ? parsePayload(text) : undefined
    if (external) c = clip.current = { text: text!, count: 0 }
    if (!c) return
    const payload = parsePayload(c.text)
    if (!payload) return
    c.count++
    const { ops, refs } = pasteOps(payload, board.doc, PASTE_OFFSET * c.count)
    const res = apply(ops)
    if (res.ok) setSelection(refs.map((r) => res.ids[r]).filter(Boolean))
  }

  const duplicate = () => {
    const payload = copyPayload(board.doc, selRef.current)
    if (!payload.nodes.length) return
    const { ops, refs } = pasteOps(payload, board.doc, PASTE_OFFSET)
    const res = apply(ops)
    if (res.ok) setSelection(refs.map((r) => res.ids[r]).filter(Boolean))
  }

  // System clipboard via copy/paste events (no permission prompt). The keydown handler writes the
  // in-memory clipboard first; if no paste event follows (no system clipboard access), it pastes from memory.
  useEffect(() => {
    const onCopy = (e: ClipboardEvent) => {
      if (document.activeElement !== svgRef.current) return
      const text = doCopy()
      if (text && e.clipboardData) {
        e.clipboardData.setData('text/plain', text)
        e.preventDefault()
      }
    }
    const onPaste = (e: ClipboardEvent) => {
      if (document.activeElement !== svgRef.current) return
      clearTimeout(pendingPaste.current)
      pendingPaste.current = 0
      e.preventDefault()
      doPaste(e.clipboardData?.getData('text/plain'))
    }
    document.addEventListener('copy', onCopy)
    document.addEventListener('paste', onPaste)
    return () => {
      document.removeEventListener('copy', onCopy)
      document.removeEventListener('paste', onPaste)
    }
  })

  // ---------------------------------------------------------------- pointer
  const local = (e: { clientX: number; clientY: number }): Point => {
    const r = svgRef.current!.getBoundingClientRect()
    return { x: e.clientX - r.left, y: e.clientY - r.top }
  }

  /** Resize handle under a screen point, when exactly one node is selected. */
  const handleAt = (p: Point): { id: string; handle: Handle } | undefined => {
    const ids = selRef.current
    const node = ids.length === 1 ? sceneRef.current.byId.get(ids[0]) : undefined
    if (!node) return undefined
    const sr = rectToScreen(camRef.current, node)
    const h = HANDLES.find((h) => {
      const q = handlePoint(sr, h)
      return Math.abs(q.x - p.x) <= HANDLE / 2 + 2 && Math.abs(q.y - p.y) <= HANDLE / 2 + 2
    })
    return h && { id: node.id, handle: h }
  }

  /** Connect handle of the hovered node under a screen point. */
  const sideHandleAt = (p: Point): Side | undefined => {
    const n = hoverRef.current ? sceneRef.current.byId.get(hoverRef.current) : undefined
    if (!n) return undefined
    return sideHandles(rectToScreen(camRef.current, n)).find((h) => Math.hypot(h.p.x - p.x, h.p.y - p.y) <= 8)?.side
  }

  /** Topmost non-group node under a screen point (connect source / target, hover). */
  const nodeAt = (p: Point, except?: string): CanvasNode | undefined => {
    const w = toWorld(camRef.current, p)
    const nodes = sceneRef.current.doc.nodes
    for (let i = nodes.length - 1; i >= 0; i--) {
      const n = nodes[i]
      if (n.type !== 'group' && n.id !== except && w.x >= n.x && w.x <= n.x + n.width && w.y >= n.y && w.y <= n.y + n.height) return n
    }
    return undefined
  }

  const onPointerDown = (e: React.PointerEvent<SVGSVGElement>) => {
    const el = svgRef.current!
    el.focus({ preventScroll: true })
    const p = local(e)
    if (e.button === 1 || (e.button === 0 && space.current)) {
      e.preventDefault()
      gesture.current = { kind: 'pan', last: p }
      el.setPointerCapture(e.pointerId)
      el.style.cursor = 'grabbing'
      return
    }
    if (e.button !== 0) return
    cancelAnimationFrame(anim.current)
    el.setPointerCapture(e.pointerId)
    const t = toolRef.current
    if (t !== 'select' && t !== 'connector') {
      gesture.current = { kind: 'create', start: p, shape: t, dragged: false }
      return
    }
    const side = sideHandleAt(p)
    if (side) {
      gesture.current = { kind: 'connect', start: p, from: hoverRef.current!, side }
      return
    }
    const h = handleAt(p)
    if (h) {
      const n = sceneRef.current.byId.get(h.id)!
      const rect = { x: n.x, y: n.y, width: n.width, height: n.height }
      gesture.current = { kind: 'resize', start: p, id: h.id, handle: h.handle, rect, out: rect }
      return
    }
    if (t === 'connector') {
      const n = nodeAt(p)
      if (n) gesture.current = { kind: 'connect', start: p, from: n.id }
      return
    }
    const c = camRef.current
    const hit = hitTest(sceneRef.current, toWorld(c, p), 5 / c.zoom)
    if (hit) {
      const sel = selRef.current
      const wasSelected = sel.includes(hit)
      if (e.shiftKey) setSelection(wasSelected ? sel.filter((id) => id !== hit) : [...sel, hit])
      else if (!wasSelected) setSelection([hit])
      gesture.current = { kind: 'press', start: p, id: hit, shift: e.shiftKey, wasSelected }
    } else {
      const base = e.shiftKey ? selRef.current : []
      if (!e.shiftKey) setSelection([])
      gesture.current = { kind: 'marquee', start: p, base }
    }
  }

  const updateHover = (p: Point) => {
    const t = toolRef.current
    if (t !== 'select' && t !== 'connector') return setHover(undefined)
    const cur = hoverRef.current ? sceneRef.current.byId.get(hoverRef.current) : undefined
    const n = nodeAt(p)
    if (n) return n.id !== hoverRef.current && setHover(n.id)
    // keep the current hover while the pointer travels out to its connect handles
    if (cur) {
      const r = rectToScreen(camRef.current, cur)
      const m = SIDE_HANDLE_GAP + 10
      if (p.x >= r.x - m && p.x <= r.x + r.width + m && p.y >= r.y - m && p.y <= r.y + r.height + m) return
    }
    if (hoverRef.current) setHover(undefined)
  }

  const onPointerMove = (e: React.PointerEvent<SVGSVGElement>) => {
    const g = gesture.current
    const p = local(e)
    const c = camRef.current
    const el = svgRef.current!
    if (!g) {
      updateHover(p)
      const h = handleAt(p)
      const t = toolRef.current
      el.style.cursor = space.current ? 'grab' : h ? CURSOR[h.handle] : sideHandleAt(p) || t !== 'select' ? 'crosshair' : ''
      return
    }
    if (g.kind === 'pan') {
      setCam(panBy(c, g.last.x - p.x, g.last.y - p.y))
      g.last = p
      return
    }
    const far = Math.hypot(p.x - g.start.x, p.y - g.start.y) >= DRAG_THRESHOLD
    const dx = (p.x - g.start.x) / c.zoom
    const dy = (p.y - g.start.y) / c.zoom
    if (g.kind === 'press') {
      if (!far) return
      if (g.shift && g.wasSelected) return // shift-click that deselected: no drag
      const roots = moveRoots(sceneRef.current.byId, nodeSelection())
      if (!roots.length) return
      setHover(undefined)
      gesture.current = { kind: 'move', start: g.start, roots, moved: movingSet(board.doc, roots), dx: 0, dy: 0 }
      return onPointerMove(e)
    }
    if (g.kind === 'move') {
      g.dx = Math.round(dx)
      g.dy = Math.round(dy)
      setPreview({ moved: g.moved, dx: g.dx, dy: g.dy })
      // highlight the group the first dragged node would land in
      const first = board.doc.nodes.find((n) => n.id === g.roots[0])
      const target = first && groupAt(board.doc, { x: first.x + first.width / 2 + g.dx, y: first.y + first.height / 2 + g.dy }, g.moved)?.id
      setDropGroup(target !== first?.['x-parent'] ? target : undefined)
    } else if (g.kind === 'resize') {
      g.out = resizeRect(g.rect, g.handle, dx, dy, e.shiftKey)
      setPreview({ moved: new Set(), dx: 0, dy: 0, resized: { id: g.id, rect: g.out } })
    } else if (g.kind === 'marquee') {
      const r = normRect(toWorld(c, g.start), toWorld(c, p))
      setMarquee(r)
      const inside = marqueeSelect(board.doc, r)
      setSelection([...g.base, ...inside.filter((id) => !g.base.includes(id))])
    } else if (g.kind === 'create') {
      g.dragged ||= far
      if (g.dragged) setCreating(createRect(g.shape, toWorld(c, g.start), toWorld(c, p)))
    } else if (g.kind === 'connect') {
      const from = sceneRef.current.byId.get(g.from)!
      const target = nodeAt(p, g.from)
      setConnecting({ from: g.side ? sidePoint(from, g.side) : { x: from.x + from.width / 2, y: from.y + from.height / 2 }, to: toWorld(c, p), target: target?.id })
    }
  }

  const endGesture = (e: React.PointerEvent<SVGSVGElement>, commit: boolean) => {
    const g = gesture.current
    gesture.current = undefined
    const el = svgRef.current!
    if (el.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId)
    setPreview(undefined)
    setMarquee(undefined)
    setCreating(undefined)
    setConnecting(undefined)
    setDropGroup(undefined)
    if (!g) return
    if (g.kind === 'pan') el.style.cursor = space.current ? 'grab' : ''
    if (!commit) return
    const p = local(e)
    const c = camRef.current
    if (g.kind === 'move' && (g.dx || g.dy)) {
      apply([{ op: 'move', ids: g.roots, dx: g.dx, dy: g.dy }, ...reparentOps(board.doc, g.roots, g.dx, g.dy)])
    } else if (g.kind === 'resize') {
      const { x, y, width, height } = g.out
      const r = g.rect
      if (x !== r.x || y !== r.y || width !== r.width || height !== r.height) apply([{ op: 'update', id: g.id, x, y, width, height }])
    } else if (g.kind === 'press' && !g.shift && g.wasSelected && selRef.current.length > 1) setSelection([g.id])
    else if (g.kind === 'create') {
      const rect = createRect(g.shape, toWorld(c, g.start), g.dragged ? toWorld(c, p) : undefined)
      const res = apply([createOp(board.doc, g.shape, rect)])
      setTool('select')
      if (res.ok) {
        setSelection([res.ids.new])
        startEditing(res.ids.new, true)
      }
    } else if (g.kind === 'connect') {
      if (Math.hypot(p.x - g.start.x, p.y - g.start.y) < DRAG_THRESHOLD) return
      const from = board.doc.nodes.find((n) => n.id === g.from)
      if (!from) return
      const target = nodeAt(p, g.from)
      const { ops, newNode } = connectOps(board.doc, from, g.side, target, toWorld(c, p))
      const res = apply(ops)
      if (!res.ok) return
      if (newNode) {
        setSelection([res.ids[newNode]])
        startEditing(res.ids[newNode], true)
      } else setSelection([res.ids.edge])
    }
  }

  const onDoubleClick = (e: React.MouseEvent<SVGSVGElement>) => {
    if (toolRef.current !== 'select') return
    const c = camRef.current
    const w = toWorld(c, local(e))
    const hit = hitTest(sceneRef.current, w, 5 / c.zoom)
    if (!hit) return
    const n = sceneRef.current.byId.get(hit)
    // a group edits on its label band only; its body is just background
    if (n?.type === 'group' && w.y - n.y > TYPE.groupLabelHeight + 8) return
    setSelection([hit])
    startEditing(hit)
  }

  // ---------------------------------------------------------------- keyboard (only while the board has focus)
  const onKeyDown = (e: React.KeyboardEvent<SVGSVGElement>) => {
    const k = e.key
    const lower = k.toLowerCase()
    if (k === ' ') {
      e.preventDefault()
      if (!space.current && !gesture.current) svgRef.current!.style.cursor = 'grab'
      space.current = true
      return
    }
    let handled = true
    if (k === 'Escape') {
      if (gesture.current) {
        gesture.current = undefined
        setPreview(undefined)
        setMarquee(undefined)
        setCreating(undefined)
        setConnecting(undefined)
        setDropGroup(undefined)
      } else if (toolRef.current !== 'select') setTool('select')
      else setSelection([])
    } else if (isMod(e) && lower === 'a') setSelection(board.doc.nodes.map((n) => n.id))
    else if (isMod(e) && lower === 'z') e.shiftKey ? board.redo() : board.undo()
    else if (isMod(e) && lower === 'y') board.redo()
    else if (isMod(e) && lower === 'd') duplicate()
    else if (isMod(e) && lower === 'c') {
      doCopy()
      handled = false // let the browser fire the copy event for the system clipboard
    } else if (isMod(e) && lower === 'v') {
      clearTimeout(pendingPaste.current)
      pendingPaste.current = window.setTimeout(() => {
        pendingPaste.current = 0
        doPaste()
      }, 60)
      handled = false
    } else if (k === 'Enter' && selRef.current.length === 1) startEditing(selRef.current[0])
    else if ((k === 'Delete' || k === 'Backspace') && selRef.current.length) {
      apply([{ op: 'remove', ids: selRef.current }])
      setSelection([])
    } else if (e.shiftKey && e.code === 'Digit1') zoomToFit()
    else if (e.shiftKey && e.code === 'Digit0') {
      const s = sizeRef.current
      animateTo(zoomAt(camRef.current, { x: s.width / 2, y: s.height / 2 }, 1))
    } else if (k.startsWith('Arrow') && !isMod(e)) {
      const step = e.shiftKey ? 10 : 1
      nudge(k === 'ArrowLeft' ? -step : k === 'ArrowRight' ? step : 0, k === 'ArrowUp' ? -step : k === 'ArrowDown' ? step : 0)
    } else if (!isMod(e) && !e.altKey && !e.shiftKey && TOOL_KEYS[lower]) setTool(TOOL_KEYS[lower])
    else handled = false
    if (handled) e.preventDefault()
  }

  const onKeyUp = (e: React.KeyboardEvent<SVGSVGElement>) => {
    if (e.key === ' ') {
      space.current = false
      if (gesture.current?.kind !== 'pan') svgRef.current!.style.cursor = ''
    }
  }

  // ---------------------------------------------------------------- render
  // Cull against a padded rect that only changes when the view leaves it, so most pan frames reuse
  // the same element tree and only the world transform changes.
  const view = viewportOf(cam, size)
  const cullRect = useRef<{ scene: Scene; zoom: number; rect: Rect } | undefined>(undefined)
  const cr = cullRect.current
  if (!cr || cr.scene !== scene || cr.zoom !== cam.zoom || !contains(cr.rect, view)) {
    const padX = view.width / 2
    const padY = view.height / 2
    cullRect.current = { scene, zoom: cam.zoom, rect: { x: view.x - padX, y: view.y - padY, width: view.width + padX * 2, height: view.height + padY * 2 } }
  }
  const area = cullRect.current!
  const editId = editing?.id
  const world = useMemo(() => {
    const visible = cull(scene, area.rect, 0)
    return (
      <>
        {visible.nodes.filter((n) => n.type === 'group').map((n) => (
          <NodeView key={n.id} node={n} measure={measure} mode={mode} editing={n.id === editId} />
        ))}
        {visible.edges.map((e) => (
          <EdgeView key={e.edge.id} edge={e.edge} path={e.path} measure={measure} mode={mode} labelGroup={e.labelGroup} editing={e.edge.id === editId} />
        ))}
        {visible.nodes.filter((n) => n.type !== 'group').map((n) => (
          <NodeView key={n.id} node={n} measure={measure} mode={mode} editing={n.id === editId} />
        ))}
      </>
    )
  }, [area, scene, measure, mode, editId])

  let gap = GRID * cam.zoom
  while (gap < 12) gap *= 4
  const ox = (((-cam.x * cam.zoom) % gap) + gap) % gap
  const oy = (((-cam.y * cam.zoom) % gap) + gap) % gap

  const selNodes = selection.map((id) => scene.byId.get(id)).filter((n) => n !== undefined)
  const selEdges = scene.edges.filter((e) => selection.includes(e.edge.id))
  const single = selection.length === 1 && selNodes.length === 1 && !editing ? rectToScreen(cam, selNodes[0]) : undefined
  const hovered = hover && !editing && !gesture.current && !preview ? scene.byId.get(hover) : undefined
  const drop = dropGroup ? scene.byId.get(dropGroup) : undefined
  const target = connecting?.target ? scene.byId.get(connecting.target) : undefined

  return (
    <div style={{ position: 'relative', width: '100%', height: '100%', overflow: 'hidden' }}>
      <style>{`.wb-board{outline:none}.wb-board:focus-visible{outline:2px solid ${ACCENT};outline-offset:-2px}.wb-board *{pointer-events:none}
.wb-tool[aria-pressed=false]:hover{background:#eef0f2 !important;color:#1f2328 !important}.wb-tool:focus-visible{box-shadow:0 0 0 2px ${ACCENT}}`}</style>
      <svg
        ref={svgRef}
        className="wb-board"
        role="application"
        aria-label={`Whiteboard. ${doc.nodes.length} shapes, ${selection.length} selected. Arrow keys move, Enter edits, Delete removes, Shift+1 fits.`}
        tabIndex={0}
        width="100%"
        height="100%"
        style={{ display: 'block', background: PAPER, fontFamily: FONT, touchAction: 'none', userSelect: 'none' }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={(e) => endGesture(e, true)}
        onPointerCancel={(e) => endGesture(e, false)}
        onPointerLeave={() => !gesture.current && setHover(undefined)}
        onDoubleClick={onDoubleClick}
        onKeyDown={onKeyDown}
        onKeyUp={onKeyUp}
        onBlur={() => (space.current = false)}
      >
        <defs>
          <pattern id="wb-dots" patternUnits="userSpaceOnUse" width={gap} height={gap} x={ox} y={oy}>
            <circle cx={1} cy={1} r={1} fill="#c9ced6" />
          </pattern>
        </defs>
        <rect width="100%" height="100%" fill="url(#wb-dots)" />
        <g transform={`scale(${cam.zoom}) translate(${-cam.x} ${-cam.y})`}>{world}</g>
        {/* overlay in screen space: 1px lines and 8px handles at every zoom */}
        <g fill="none" stroke={ACCENT} strokeWidth={1}>
          {drop && <ScreenRect box={rectToScreen(cam, drop)} strokeWidth={2} strokeDasharray="6 4" rx={12} />}
          {selEdges.map((e) => (
            <polyline key={e.edge.id} points={e.path.map((q) => toScreen(cam, q)).map((q) => `${q.x},${q.y}`).join(' ')} strokeWidth={3} strokeOpacity={0.35} />
          ))}
          {selNodes.map((n) => (
            <ScreenRect key={n.id} box={rectToScreen(cam, n)} />
          ))}
          {single &&
            HANDLES.map((h) => {
              const q = handlePoint(single, h)
              return <rect key={h} x={Math.round(q.x - HANDLE / 2) + 0.5} y={Math.round(q.y - HANDLE / 2) + 0.5} width={HANDLE} height={HANDLE} rx={1.5} fill="#fff" />
            })}
          {hovered &&
            sideHandles(rectToScreen(cam, hovered)).map(({ side, p }) => <circle key={side} cx={p.x} cy={p.y} r={5} fill="#fff" strokeWidth={1.5} />)}
          {marquee && <ScreenRect box={rectToScreen(cam, marquee)} fill="rgba(47,111,235,0.08)" />}
          {creating && <ScreenRect box={rectToScreen(cam, creating)} strokeDasharray="5 4" fill="rgba(47,111,235,0.05)" />}
          {connecting && (
            <>
              {target && <ScreenRect box={rectToScreen(cam, target)} strokeWidth={2} />}
              <line x1={toScreen(cam, connecting.from).x} y1={toScreen(cam, connecting.from).y} x2={toScreen(cam, connecting.to).x} y2={toScreen(cam, connecting.to).y} strokeWidth={1.5} strokeDasharray="6 4" />
              <circle cx={toScreen(cam, connecting.to).x} cy={toScreen(cam, connecting.to).y} r={4} fill={ACCENT} />
            </>
          )}
        </g>
      </svg>
      {editing && <Editor key={editing.id} editing={editing} scene={scene} cam={cam} measure={measure} onDone={(t) => finishEditing(editing, t)} />}
      <Toolbar
        tool={tool}
        onPick={(t) => {
          setTool(t)
          focusBoard()
        }}
      />
    </div>
  )
}

const ScreenRect = ({ box: r, ...rest }: { box: Rect } & React.SVGProps<SVGRectElement>) => (
  <rect x={r.x - 0.5} y={r.y - 0.5} width={r.width + 1} height={r.height + 1} {...rest} />
)

/** Places the text editor over the node text, group label or edge label it replaces. */
function Editor({ editing, scene, cam, measure, onDone }: { editing: Editing; scene: Scene; cam: Camera; measure: Measure; onDone: (t: string | undefined) => void }) {
  const zoom = cam.zoom
  if (editing.kind === 'edge') {
    const g = scene.edges.find((e) => e.edge.id === editing.id)
    if (!g) return null
    const c = toScreen(cam, pointAt(g.path, 0.5))
    const width = Math.max(140, measure(g.edge.label ?? '', { fontSize: TYPE.labelFontSize }).width + 24)
    const box: EditorBox = {
      left: c.x - (width * zoom) / 2,
      centreY: c.y,
      width,
      fontSize: TYPE.labelFontSize,
      zoom,
      align: 'center',
      background: g.labelGroup ? groupFill(g.labelGroup) : PAPER,
    }
    return <TextEditor initial={g.edge.label ?? ''} box={box} label="Edit edge label" onDone={onDone} />
  }
  const n = scene.byId.get(editing.id)
  if (!n) return null
  const r = rectToScreen(cam, n)
  if (editing.kind === 'label' && n.type === 'group') {
    const box: EditorBox = {
      left: r.x + GROUP_LABEL_X * zoom,
      centreY: r.y + GROUP_LABEL_Y * zoom,
      width: Math.max(160, n.width - 2 * GROUP_LABEL_X),
      fontSize: TYPE.groupLabelFontSize,
      zoom,
      weight: 600,
      align: 'left',
    }
    return <TextEditor initial={n.label ?? ''} box={box} label="Edit group label" onDone={onDone} />
  }
  const box: EditorBox = {
    left: r.x + TYPE.nodePadding * zoom,
    centreY: r.y + r.height / 2,
    width: n.width - TYPE.nodePadding * 2,
    fontSize: TYPE.nodeFontSize,
    zoom,
    align: 'center',
  }
  return <TextEditor initial={nodeText(n)} box={box} label="Edit text" onDone={onDone} />
}
