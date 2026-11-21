import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { canvasMeasure } from '../canvas/core/measure'
import type { CanvasNode, GroupNode } from '../canvas/core/model'
import { scoreDetailed } from '../canvas/quality/score'
import { BoardView, type BoardViewHandle, FONT, type Mode } from '../canvas/render'
import { Chat, type Msg } from './Chat'
import { type DocMsg, RemoteBoard } from './remoteBoard'

const load = <T,>(k: string, d: T): T => JSON.parse(localStorage.getItem(k) ?? 'null') ?? d
const uid = () => crypto.randomUUID()
const measure = canvasMeasure(FONT)

type Viewport = { x: number; y: number; width: number; height: number }

/** Store an image on the server (next to the board file). Returns its path, e.g. "assets/ab12.png". */
async function uploadImage(file: File): Promise<string> {
  const res = await fetch('/assets', { method: 'POST', headers: { 'content-type': file.type }, body: file })
  const body = await res.json()
  if (!res.ok) throw new Error(body.error ?? `upload failed (${res.status})`)
  return body.file
}

export default function App() {
  const wsRef = useRef<WebSocket | null>(null)
  const viewRef = useRef<BoardViewHandle>(null)
  const viewportRef = useRef<Viewport | undefined>(undefined)
  const [board, setBoard] = useState<RemoteBoard | null>(null)
  const boardRef = useRef<RemoteBoard | null>(null)
  const [selected, setSelected] = useState<string[]>([])
  const [mode, setMode] = useState<Mode>(() => load('wb-mode', 'clean'))
  const [msgs, setMsgs] = useState<Msg[]>(() => load('wb-chat-v2', []))
  const [sessionId, setSessionId] = useState<string | undefined>(() => load('wb-session', undefined))
  const [busySince, setBusySince] = useState<number | null>(null)
  const [online, setOnline] = useState(false)

  useEffect(() => {
    localStorage.setItem('wb-chat-v2', JSON.stringify(msgs))
  }, [msgs])
  useEffect(() => {
    localStorage.setItem('wb-session', JSON.stringify(sessionId ?? null))
  }, [sessionId])
  useEffect(() => {
    localStorage.setItem('wb-mode', JSON.stringify(mode))
  }, [mode])

  // Change the last Claude reply in place.
  const patchLast = (fn: (m: Msg) => Msg) =>
    setMsgs((p) => {
      const i = p.findLastIndex((m) => m.role === 'claude')
      return i < 0 ? p : [...p.slice(0, i), fn(p[i]), ...p.slice(i + 1)]
    })

  useEffect(() => {
    let closed = false
    let retry: ReturnType<typeof setTimeout>
    const connect = () => {
      const ws = new WebSocket(`ws://${location.host}/ws`)
      wsRef.current = ws
      ws.onopen = () => setOnline(true)
      ws.onclose = () => {
        setOnline(false)
        if (!closed) retry = setTimeout(connect, 1000)
      }
      ws.onmessage = (ev) => {
        const m = JSON.parse(ev.data)
        if (m.type === 'doc') {
          if (boardRef.current) boardRef.current.receive(m as DocMsg)
          else {
            const b = new RemoteBoard(m as DocMsg, (msg) => wsRef.current?.send(JSON.stringify(msg)))
            boardRef.current = b
            setBoard(b)
            if (import.meta.env.DEV) Object.assign(window, { wb: { board: b, view: viewRef } }) // debug hook for local checks
          }
        } else if (m.type === 'focus') {
          viewRef.current?.zoomToFit(m.ids)
        } else if (m.type === 'shapes') {
          patchLast((r) => ({ ...r, shapeIds: [...new Set([...(r.shapeIds ?? []), ...m.ids])] }))
        } else if (m.type === 'delta') {
          patchLast((r) => ({ ...r, text: r.text + m.text }))
        } else if (m.type === 'turn') {
          patchLast((r) => (r.text && !r.text.endsWith('\n\n') ? { ...r, text: r.text + '\n\n' } : r))
        } else if (m.type === 'step') {
          patchLast((r) => ({ ...r, steps: [...(r.steps ?? []), { verb: m.verb, detail: m.detail, code: m.code }] }))
        } else if (m.type === 'done' || m.type === 'error') {
          if (m.sessionId) setSessionId(m.sessionId)
          setBusySince(null)
          patchLast((r) => ({
            ...r,
            text: r.text.trim(),
            pending: false,
            error: m.type === 'error' ? m.message : undefined,
            stopped: m.type === 'done' && !m.ok && !r.text.trim() ? true : r.stopped,
          }))
        }
      }
    }
    connect()
    return () => {
      closed = true
      clearTimeout(retry)
      wsRef.current?.close()
    }
  }, [])

  const send = (text: string, images: string[] = []) => {
    if ((!text.trim() && !images.length) || busySince || !online || !board) return false
    setMsgs((p) => [...p, { id: uid(), role: 'user', text, images }, { id: uid(), role: 'claude', text: '', steps: [], pending: true }])
    setBusySince(Date.now())
    const viewport = viewRef.current?.getViewport() ?? viewportRef.current
    wsRef.current!.send(JSON.stringify({ type: 'chat', text, sessionId, viewport, selected, images }))
    return true
  }

  const retry = (claudeId: string) => {
    const i = msgs.findIndex((m) => m.id === claudeId)
    const prompt = msgs[i - 1]
    if (prompt?.role !== 'user') return
    setMsgs((p) => p.slice(0, i - 1))
    // Wait for state to settle, then resend the same prompt.
    setTimeout(() => send(prompt.text, prompt.images))
  }

  const showOnBoard = (ids: string[]) => {
    if (!board) return
    const nodes = new Set(board.doc.nodes.map((n) => n.id))
    const edges = board.doc.edges.filter((e) => ids.includes(e.id))
    const live = ids.filter((id) => nodes.has(id) || edges.some((e) => e.id === id))
    if (!live.length) return
    viewRef.current?.select(live)
    // zoomToFit frames nodes only: frame each edge by its two ends.
    viewRef.current?.zoomToFit([...new Set([...live.filter((id) => nodes.has(id)), ...edges.flatMap((e) => [e.fromNode, e.toNode])])])
  }

  const onViewport = useMemo(() => (vp: Viewport) => (viewportRef.current = vp), [])

  return (
    <div className="app">
      <div className="canvas">
        {board ? (
          <>
            <BoardView board={board} measure={measure} mode={mode} onSelectionChange={setSelected} onViewportChange={onViewport} handleRef={viewRef} uploadImage={uploadImage} />
            <BoardBar board={board} mode={mode} setMode={setMode} />
            <BoardNav board={board} onGo={(id) => viewRef.current?.zoomToFit([id])} />
          </>
        ) : (
          <p className="board-wait">{online ? 'Loading the board…' : 'Start the server with bun run dev'}</p>
        )}
      </div>
      <Chat
        selected={selected.length}
        onClearSelection={() => viewRef.current?.select([])}
        onShow={showOnBoard}
        msgs={msgs}
        online={online}
        busySince={busySince}
        onSend={send}
        uploadImage={uploadImage}
        onStop={() => wsRef.current?.send(JSON.stringify({ type: 'stop' }))}
        onRetry={retry}
        onNewChat={() => {
          setMsgs([])
          setSessionId(undefined)
        }}
      />
    </div>
  )
}

/** Top-left bar: board file, live quality score, Clean/Sketch, Undo/Redo. */
function BoardBar({ board, mode, setMode }: { board: RemoteBoard; mode: Mode; setMode: (m: Mode) => void }) {
  const doc = useSyncExternalStore(
    (cb) => board.subscribe(cb),
    () => board.doc,
  )
  const report = useMemo(() => scoreDetailed(doc, measure), [doc])
  const tone = report.score >= 90 ? 'good' : report.score >= 70 ? 'fair' : 'poor'
  const issues = [
    report.overlaps.length && `${report.overlaps.length} overlap`,
    report.wraps.length && `${report.wraps.length} wrap`,
    report.edgeThroughNode.length && `${report.edgeThroughNode.length} through node`,
    report.outsideGroup.length && `${report.outsideGroup.length} outside group`,
    report.crossings && `${report.crossings} crossing`,
    report.edgeOverlap.length && `${report.edgeOverlap.length} edge overlap`,
    report.labelOnBorder.length && `${report.labelOnBorder.length} on border`,
    report.edgeOnBorder.length && `${report.edgeOnBorder.length} edge on border`,
  ].filter(Boolean)
  return (
    <div className="board-bar">
      <span className="chip" title="Board file (JSON Canvas)">
        {board.file}
      </span>
      <span className={`chip quality is-${tone}`} title={issues.length ? issues.join(' · ') : 'No layout problems'}>
        <span className="quality-dot" aria-hidden />
        Quality {Math.round(report.score)}
      </span>
      <div className="segmented" role="radiogroup" aria-label="Drawing style">
        {(['clean', 'sketch'] as const).map((m) => (
          <button key={m} role="radio" aria-checked={mode === m} onClick={() => setMode(m)}>
            {m === 'clean' ? 'Clean' : 'Sketch'}
          </button>
        ))}
      </div>
      <ThemeToggle />
      <DotsToggle />
      <div className="segmented">
        <button onClick={() => board.undo()} disabled={!board.canUndo()} title="Undo (Cmd+Z)">
          Undo
        </button>
        <button onClick={() => board.redo()} disabled={!board.canRedo()} title="Redo (Cmd+Shift+Z)">
          Redo
        </button>
      </div>
    </div>
  )
}

/** Left-edge nav: one line per diagram (top-level group). Hover shows its title and contents; click zooms to it. */
function BoardNav({ board, onGo }: { board: RemoteBoard; onGo: (id: string) => void }) {
  const doc = useSyncExternalStore(
    (cb) => board.subscribe(cb),
    () => board.doc,
  )
  const [active, setActive] = useState<string>()
  const sections = useMemo(() => {
    const text = (n: CanvasNode) => (n.type === 'text' ? n.text : n.type === 'group' ? (n.label ?? '') : n.type === 'file' ? n.file : n.url)
    return doc.nodes
      .filter((n): n is GroupNode => n.type === 'group' && !n['x-parent'])
      .sort((a, b) => a.y - b.y || a.x - b.x)
      .map((g) => {
        const kids = doc.nodes.filter((n) => n['x-parent'] === g.id).map(text).filter(Boolean)
        return { id: g.id, title: g.label || 'Untitled diagram', body: kids.join(' · ') }
      })
  }, [doc])
  if (!sections.length) return null
  return (
    <nav className="board-nav" aria-label="Jump to diagram">
      {sections.map((s) => (
        <button
          key={s.id}
          className={`nav-tick ${active === s.id ? 'is-active' : ''}`}
          aria-label={`Go to ${s.title}`}
          onClick={() => {
            setActive(s.id)
            onGo(s.id)
          }}
        >
          <span className="nav-card" aria-hidden>
            <strong>{s.title}</strong>
            {s.body && <span>{s.body}</span>}
          </span>
        </button>
      ))}
    </nav>
  )
}

/** Show or hide the dot grid. The choice is saved. */
function DotsToggle() {
  const [dots, setDots] = useState(() => localStorage.getItem('wb-dots') !== 'off')
  useEffect(() => {
    document.documentElement.dataset.dots = dots ? 'on' : 'off'
    localStorage.setItem('wb-dots', dots ? 'on' : 'off')
  }, [dots])
  return (
    <div className="segmented">
      <button onClick={() => setDots(!dots)} aria-pressed={dots} title={dots ? 'Hide the dot grid' : 'Show the dot grid'}>
        {dots ? 'Hide dots' : 'Show dots'}
      </button>
    </div>
  )
}

/** Light / dark switch. The choice is saved; index.html applies it before first paint. */
function ThemeToggle() {
  const [theme, setTheme] = useState(() => document.documentElement.dataset.theme ?? 'light')
  const next = theme === 'dark' ? 'light' : 'dark'
  return (
    <div className="segmented">
      <button
        onClick={() => {
          document.documentElement.dataset.theme = next
          localStorage.setItem('theme', next)
          setTheme(next)
        }}
        aria-label={`Switch to ${next} mode`}
        title={`Switch to ${next} mode`}
      >
        {theme === 'dark' ? 'Light mode' : 'Dark mode'}
      </button>
    </div>
  )
}
