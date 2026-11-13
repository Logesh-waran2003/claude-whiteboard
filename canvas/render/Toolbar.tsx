// Compact tool picker, bottom centre. Keyboard: V R O D S T G C while the board has focus.
import type { Tool } from './ops'
import { INK, MUTED } from './style'

export const TOOL_KEYS: Record<string, Tool> = { v: 'select', r: 'rect', o: 'ellipse', d: 'diamond', s: 'sticky', t: 'text', g: 'group', c: 'connector' }

const TOOLS: { tool: Tool; name: string; key: string; icon: React.ReactNode }[] = [
  { tool: 'select', name: 'Select', key: 'V', icon: <path d="M5 3l11 6.5-5 1.2 3 5.3-2 1.1-3-5.3L5 15z" fill="currentColor" stroke="none" /> },
  { tool: 'rect', name: 'Rectangle', key: 'R', icon: <rect x="3.5" y="5" width="13" height="10" rx="2" /> },
  { tool: 'ellipse', name: 'Ellipse', key: 'O', icon: <ellipse cx="10" cy="10" rx="7" ry="5.5" /> },
  { tool: 'diamond', name: 'Diamond', key: 'D', icon: <path d="M10 3l7 7-7 7-7-7z" /> },
  { tool: 'sticky', name: 'Sticky note', key: 'S', icon: <path d="M4 4h12v8l-4 4H4z M12 16v-4h4" /> },
  { tool: 'text', name: 'Text', key: 'T', icon: <path d="M5 5h10 M10 5v11 M7.5 16h5" /> },
  { tool: 'group', name: 'Group', key: 'G', icon: <rect x="3" y="4" width="14" height="12" rx="2.5" strokeDasharray="3 2" /> },
  { tool: 'connector', name: 'Connector', key: 'C', icon: <path d="M4 15L15 5 M10 5h5v5" /> },
]

export function Toolbar({ tool, onPick }: { tool: Tool; onPick: (t: Tool) => void }) {
  return (
    <div
      role="toolbar"
      aria-label="Tools"
      style={{
        position: 'absolute',
        left: '50%',
        bottom: 16,
        transform: 'translateX(-50%)',
        display: 'flex',
        gap: 2,
        padding: 4,
        borderRadius: 12,
        background: '#fff',
        boxShadow: '0 1px 2px rgba(0,0,0,.06), 0 4px 16px rgba(0,0,0,.08), 0 0 0 1px rgba(0,0,0,.06)',
      }}
    >
      {TOOLS.map((t) => {
        const on = t.tool === tool
        return (
          <button
            key={t.tool}
            type="button"
            aria-label={`${t.name} (${t.key})`}
            aria-pressed={on}
            title={`${t.name} — ${t.key}`}
            className="wb-tool"
            onClick={() => onPick(t.tool)}
            style={{
              all: 'unset',
              boxSizing: 'border-box',
              width: 36,
              height: 36,
              display: 'grid',
              placeItems: 'center',
              borderRadius: 8,
              cursor: 'pointer',
              color: on ? '#fff' : MUTED,
              background: on ? INK : 'transparent',
              transition: 'background .12s, color .12s',
            }}
          >
            <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              {t.icon}
            </svg>
          </button>
        )
      })}
    </div>
  )
}
