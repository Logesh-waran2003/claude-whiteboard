import { useEffect, useRef, useState } from 'react'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

export type Step = { verb: string; detail?: string; code?: boolean }
export type Msg = {
  id: string
  role: 'user' | 'claude'
  text: string
  /** Attached image paths ("assets/<name>"), user messages only. */
  images?: string[]
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
  onSend: (text: string, images?: string[]) => boolean
  uploadImage: (file: File) => Promise<string>
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

export function Chat({ selected, onClearSelection, onShow, msgs, online, busySince, onSend, uploadImage, onStop, onRetry, onNewChat }: Props) {
  const [input, setInput] = useState('')
  const [images, setImages] = useState<string[]>([])
  const [uploading, setUploading] = useState(0)
  const [attachError, setAttachError] = useState<string>()
  const fileRef = useRef<HTMLInputElement>(null)
  const [width, setWidth] = useState(() => Number(localStorage.getItem('wb-chat-w')) || 380)
  const [open, setOpen] = useState(() => localStorage.getItem('wb-chat-open') !== 'false')
  const listRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const busy = busySince !== null

  useEffect(() => {
    localStorage.setItem('wb-chat-w', String(width))
    localStorage.setItem('wb-chat-open', String(open))
  }, [width, open])

  // Cmd+\ (Ctrl+\) minimises or opens the chat from anywhere.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === '\\' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault()
        setOpen((o) => !o)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

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
    if (uploading) return
    if (onSend(text.trim(), images)) {
      setInput('')
      setImages([])
    }
  }

  const attach = async (files: File[]) => {
    const imgs = files.filter((f) => f.type.startsWith('image/'))
    if (!imgs.length) return
    setAttachError(undefined)
    setUploading((n) => n + imgs.length)
    for (const f of imgs) {
      try {
        const path = await uploadImage(f)
        setImages((p) => (p.includes(path) ? p : [...p, path]))
      } catch (e) {
        setAttachError((e as Error).message)
      } finally {
        setUploading((n) => n - 1)
      }
    }
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
      <button className="chat-reopen" onClick={() => setOpen(true)} aria-label="Open Claude chat" title="Open chat (⌘\)">
        <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round">
          <path d="M2.5 3.5h11v7h-6l-3 2.5v-2.5h-2z" />
        </svg>
        Claude
        {busy && <span className="working-dot" aria-label="Claude is working" />}
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
        <button className="ghost icon" onClick={() => setOpen(false)} aria-label="Minimise chat" title="Minimise chat (⌘\)">
          <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <rect x="2" y="2.5" width="12" height="11" rx="2" />
            <path d="M10 2.5v11M5.5 6.5L7.5 8l-2 1.5" />
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
                {!!m.images?.length && (
                  <div className="note-images">
                    {m.images.map((p) => (
                      <img key={p} src={`/${p}`} alt="Attached image" />
                    ))}
                  </div>
                )}
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
        onDragOver={(e) => e.dataTransfer.types.includes('Files') && e.preventDefault()}
        onDrop={(e) => {
          if (!e.dataTransfer.files.length) return
          e.preventDefault()
          void attach([...e.dataTransfer.files])
        }}
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
        {(images.length > 0 || uploading > 0 || attachError) && (
          <div className="attachments">
            {images.map((p) => (
              <span key={p} className="attachment">
                <img src={`/${p}`} alt="Attached image" />
                <button type="button" aria-label="Remove image" title="Remove" onClick={() => setImages((l) => l.filter((x) => x !== p))}>
                  ×
                </button>
              </span>
            ))}
            {uploading > 0 && <span className="attachment is-loading" aria-label="Uploading image" />}
            {attachError && <span className="attach-error" role="alert">{attachError}</span>}
          </div>
        )}
        <div className="composer-well">
          <button type="button" className="ghost icon attach" onClick={() => fileRef.current?.click()} disabled={!online} aria-label="Attach image" title="Attach image (or paste / drop)">
            <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden>
              <rect x="2" y="3" width="12" height="10" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.4" />
              <circle cx="6" cy="6.5" r="1.2" fill="currentColor" />
              <path d="M3 12l3.5-3.5 2.5 2.5 2-2 2.5 2.5" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
            </svg>
          </button>
          <input
            ref={fileRef}
            type="file"
            accept="image/png,image/jpeg,image/gif,image/webp"
            multiple
            hidden
            onChange={(e) => {
              void attach([...(e.target.files ?? [])])
              e.target.value = ''
            }}
          />
          <textarea
            ref={inputRef}
            rows={1}
            value={input}
            placeholder={online ? 'Ask Claude to change the board' : 'Start the server with bun run dev'}
            onChange={(e) => setInput(e.target.value)}
            onPaste={(e) => {
              const files = [...e.clipboardData.files]
              if (!files.some((f) => f.type.startsWith('image/'))) return
              e.preventDefault()
              void attach(files)
            }}
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
            <button type="submit" className="primary" disabled={!online || uploading > 0 || (!input.trim() && !images.length)}>
              Send
            </button>
          )}
        </div>
        <p className="composer-hint">Enter to send. Shift+Enter for a new line. Paste or drop images.</p>
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
        // Folded by default: one line (the live step while working, the step count when done).
        <details className="trace-box">
          <summary>
            {m.pending ? <StepText s={steps.at(-1)!} /> : `${steps.length} ${steps.length === 1 ? 'step' : 'steps'}`}
          </summary>
          <ol className="trace">
            {steps.map((s, i) => (
              <li key={i} className={m.pending && i === steps.length - 1 ? 'is-live' : ''}>
                <StepText s={s} />
              </li>
            ))}
          </ol>
        </details>
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

function StepText({ s }: { s: Step }) {
  return (
    <>
      {s.verb}
      {s.detail && <> {s.code ? <code>{s.detail}</code> : <span className="trace-detail">{s.detail}</span>}</>}
    </>
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
