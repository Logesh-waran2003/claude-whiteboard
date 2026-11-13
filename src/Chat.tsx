import { useEffect, useRef, useState } from 'react'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

export type Step = { verb: string; detail?: string; code?: boolean }
export type Msg = {
  id: string
  role: 'user' | 'claude'
  text: string
  steps?: Step[]
  shapeIds?: string[]
  pending?: boolean
  error?: string
  stopped?: boolean
}

type Props = {
  /** Number of selected board items. */
  selected: number
  onClearSelection: () => void
  /** Select these ids on the board and zoom to them. */
  onShow: (ids: string[]) => void
  msgs: Msg[]
  online: boolean
  busySince: number | null
  onSend: (text: string) => boolean
  onStop: () => void
  onRetry: (claudeId: string) => void
  onNewChat: () => void
}

const STARTERS = [
  'Turn the selected notes into a flow chart',
  'Map the architecture of this repo',
  'Group these notes by theme and add an action for each group',
]

const MIN_W = 320
const MAX_W = 640

export function Chat({ selected, onClearSelection, onShow, msgs, online, busySince, onSend, onStop, onRetry, onNewChat }: Props) {
  const [input, setInput] = useState('')
  const [width, setWidth] = useState(() => Number(localStorage.getItem('wb-chat-w')) || 380)
  const [open, setOpen] = useState(() => localStorage.getItem('wb-chat-open') !== 'false')
  const listRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const busy = busySince !== null

  useEffect(() => {
    localStorage.setItem('wb-chat-w', String(width))
    localStorage.setItem('wb-chat-open', String(open))
  }, [width, open])

  // Keep the newest message in view while Claude streams.
  useEffect(() => {
    const el = listRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [msgs])

  // Grow the input with its content, up to 8 lines.
  useEffect(() => {
    const el = inputRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`
  }, [input])

  const submit = (text = input) => {
    if (onSend(text.trim())) setInput('')
  }

  const startResize = (e: React.PointerEvent) => {
    e.preventDefault()
    const startX = e.clientX
    const startW = width
    const move = (ev: PointerEvent) => setWidth(Math.max(MIN_W, Math.min(MAX_W, startW + startX - ev.clientX)))
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  if (!open) {
    return (
      <button className="chat-reopen" onClick={() => setOpen(true)} aria-label="Open Claude chat">
        Claude
      </button>
    )
  }

  return (
    <aside className="chat" style={{ width }} aria-label="Claude chat">
      <div className="chat-resize" onPointerDown={startResize} role="separator" aria-orientation="vertical" aria-label="Resize chat" />

      <header className="chat-head">
        <span className={`chat-presence ${online ? 'is-on' : ''}`} title={online ? 'Connected' : 'Server is not running'} />
        <h1>Claude</h1>
        <button className="ghost" onClick={onNewChat} disabled={busy || msgs.length === 0}>
          New chat
        </button>
        <button className="ghost icon" onClick={() => setOpen(false)} aria-label="Hide chat" title="Hide chat">
          <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden>
            <path d="M6 3l5 5-5 5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
      </header>

      <div className="chat-log" ref={listRef}>
        {msgs.length === 0 ? (
          <div className="chat-empty">
            <p>Ask Claude to draw, sort or connect things on the board. It can read your projects and notes to get the facts right.</p>
            <ul>
              {STARTERS.map((s) => (
                <li key={s}>
                  <button className="starter" onClick={() => submit(s)} disabled={!online}>
                    {s}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ) : (
          msgs.map((m) =>
            m.role === 'user' ? (
              <div key={m.id} className="note">
                {m.text}
              </div>
            ) : (
              <Reply key={m.id} m={m} busySince={busySince} onShow={onShow} onRetry={() => onRetry(m.id)} />
            ),
          )
        )}
      </div>

      <form
        className="composer"
        onSubmit={(e) => {
          e.preventDefault()
          submit()
        }}
      >
        {selected > 0 && (
          <div className="selection">
            <span>
              {selected} {selected === 1 ? 'item' : 'items'} selected. Claude will use {selected === 1 ? 'it' : 'them'}.
            </span>
            <button type="button" className="link" onClick={onClearSelection}>
              Clear
            </button>
          </div>
        )}
        <div className="composer-well">
          <textarea
            ref={inputRef}
            rows={1}
            value={input}
            placeholder={online ? 'Ask Claude to change the board' : 'Start the server with bun run dev'}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault()
                submit()
              }
              if (e.key === 'Escape' && busy) onStop()
            }}
          />
          {busy ? (
            <button type="button" className="primary stop" onClick={onStop} title="Stop (Esc)">
              Stop
            </button>
          ) : (
            <button type="submit" className="primary" disabled={!online || !input.trim()}>
              Send
            </button>
          )}
        </div>
        <p className="composer-hint">Enter to send. Shift+Enter for a new line.</p>
      </form>
    </aside>
  )
}

function Reply({ m, busySince, onShow, onRetry }: { m: Msg; busySince: number | null; onShow: (ids: string[]) => void; onRetry: () => void }) {
  const [copied, setCopied] = useState(false)
  const steps = m.steps ?? []
  const drew = m.shapeIds?.length ?? 0

  return (
    <article className="reply" aria-busy={m.pending}>
      {steps.length > 0 && (
        <ol className="trace">
          {steps.map((s, i) => (
            <li key={i} className={m.pending && i === steps.length - 1 ? 'is-live' : ''}>
              {s.verb}
              {s.detail && <> {s.code ? <code>{s.detail}</code> : <span className="trace-detail">{s.detail}</span>}</>}
            </li>
          ))}
        </ol>
      )}

      {m.pending && <Working since={busySince} quiet={steps.length > 0 || !!m.text} />}

      {m.text && (
        <div className="md">
          <Markdown remarkPlugins={[remarkGfm]}>{m.text}</Markdown>
        </div>
      )}

      {m.stopped && <p className="reply-note">Stopped.</p>}
      {m.error && (
        <div className="reply-error" role="alert">
          <p>Claude could not finish: {m.error}</p>
          <button className="link" onClick={onRetry}>
            Try again
          </button>
        </div>
      )}

      {!m.pending && (m.text || drew > 0) && (
        <div className="reply-actions">
          {drew > 0 && (
            <button className="link" onClick={() => onShow(m.shapeIds!)}>
              Show on board ({drew})
            </button>
          )}
          {m.text && (
            <button
              className="link quiet"
              onClick={() => {
                void navigator.clipboard.writeText(m.text)
                setCopied(true)
                setTimeout(() => setCopied(false), 1200)
              }}
            >
              {copied ? 'Copied' : 'Copy'}
            </button>
          )}
        </div>
      )}
    </article>
  )
}

function Working({ since, quiet }: { since: number | null; quiet: boolean }) {
  const [, tick] = useState(0)
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 1000)
    return () => clearInterval(t)
  }, [])
  const secs = since ? Math.floor((Date.now() - since) / 1000) : 0
  return (
    <p className="working" aria-live="polite">
      <span className="working-dot" aria-hidden />
      {quiet ? 'Working' : 'Thinking'} for {secs}s
    </p>
  )
}
