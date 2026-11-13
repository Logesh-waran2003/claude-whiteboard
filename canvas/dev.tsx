// Dev page for the renderer: an agent-style seeded board (unplaced nodes -> layout -> invariants),
// or a generated grid with ?n=1000. Manual testing and screenshots only.
import { useEffect, useMemo, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { type Board, createBoard } from './core/board'
import { canvasMeasure } from './core/measure'
import type { CanvasDoc, CanvasEdge, CanvasNode, Op, QualityReport, ShapeKind } from './core/model'
import { enforceInvariants, layoutBoard } from './layout'
import { score } from './quality/score'
import { BoardView, type BoardViewHandle, FONT, type Mode } from './render'

const measure = canvasMeasure(FONT)

/** What an agent would send: nodes and groups without positions, labelled edges. */
const SEED: Op[] = [
  { op: 'set_layout', group: 'root', layout: 'dag-tb' },
  { op: 'add_node', ref: 'web', kind: 'group', text: 'Browser', layout: 'dag-lr', color: '5' },
  { op: 'add_node', ref: 'srv', kind: 'group', text: 'Local server', layout: 'dag-lr', color: '6' },
  { op: 'add_node', ref: 'ctx', kind: 'group', text: 'Context', layout: 'dag-lr' },
  { op: 'add_node', ref: 'editor', text: 'Editor UI', parent: 'web' },
  { op: 'add_node', ref: 'canvas', text: 'Canvas renderer', parent: 'web', color: '5' },
  { op: 'add_node', ref: 'chat', text: 'Chat panel', parent: 'web' },
  { op: 'add_node', ref: 'api', text: 'HTTP API', parent: 'srv' },
  { op: 'add_node', ref: 'store', text: 'Board store', parent: 'srv', color: '6' },
  { op: 'add_node', ref: 'runner', text: 'Agent runner', parent: 'srv', kind: 'diamond' },
  { op: 'add_node', ref: 'sdk', text: 'Claude Agent SDK', parent: 'ctx' },
  { op: 'add_node', ref: 'mcp', text: 'MCP tools', parent: 'ctx', kind: 'ellipse' },
  { op: 'add_node', ref: 'files', file: 'docs/README.md', parent: 'ctx' },
  { op: 'add_node', ref: 'note', kind: 'sticky', text: 'One undo stack for the user and every agent.' },
  { op: 'add_edge', from: 'editor', to: 'canvas', label: 'ops' },
  { op: 'add_edge', from: 'chat', to: 'api', label: 'prompt' },
  { op: 'add_edge', from: 'api', to: 'runner', label: 'start run' },
  { op: 'add_edge', from: 'runner', to: 'sdk', label: 'query' },
  { op: 'add_edge', from: 'sdk', to: 'mcp', label: 'tool call', route: 'elbow' },
  { op: 'add_edge', from: 'mcp', to: 'store', label: 'apply ops' },
  { op: 'add_edge', from: 'store', to: 'canvas', label: 'doc update', arrow: 'both' },
  { op: 'add_edge', from: 'sdk', to: 'files', label: 'reads' },
]

function seeded(): Board {
  const board = createBoard()
  const must = (r: ReturnType<Board['apply']>) => {
    if (!r.ok) throw new Error(JSON.stringify(r.error))
  }
  must(board.apply(SEED, { by: 'agent:demo' }))
  must(board.apply(layoutBoard(board.doc, measure), { by: 'layout' }))
  must(board.apply(enforceInvariants(board.doc, measure), { by: 'layout', mergeWithPrevious: true }))
  return board
}

function grid(n: number): CanvasDoc {
  const shapes: ShapeKind[] = ['rect', 'ellipse', 'diamond', 'sticky', 'rect']
  const cols = Math.ceil(Math.sqrt(n * 2))
  const nodes: CanvasNode[] = []
  const edges: CanvasEdge[] = []
  for (let i = 0; i < n; i++) {
    const shape = shapes[i % shapes.length]
    const color = i % 7 ? undefined : (`${(i % 6) + 1}` as '1')
    nodes.push({ id: `n${i}`, type: 'text', text: `Node ${i}`, x: (i % cols) * 260, y: Math.floor(i / cols) * 140, width: 160, height: shape === 'sticky' ? 80 : 64, 'x-shape': shape, color })
    if (i % cols && i % 2) edges.push({ id: `e${i}`, fromNode: `n${i - 1}`, toNode: `n${i}`, label: i % 4 === 1 ? 'next' : undefined })
  }
  return { nodes, edges }
}

const params = new URLSearchParams(location.search)
const n = Number(params.get('n'))
const board = n > 0 ? createBoard(grid(n)) : seeded()
Object.assign(window, { __board: board })

const chip: React.CSSProperties = { fontSize: 12, color: '#57606a', background: 'rgba(255,255,255,.92)', padding: '5px 9px', borderRadius: 8, boxShadow: '0 0 0 1px rgba(0,0,0,.06)' }

function Toggle({ mode, setMode }: { mode: Mode; setMode: (m: Mode) => void }) {
  return (
    <div role="radiogroup" aria-label="Drawing style" style={{ display: 'flex', padding: 3, gap: 2, borderRadius: 10, background: '#fff', boxShadow: '0 1px 2px rgba(0,0,0,.08), 0 0 0 1px rgba(0,0,0,.06)' }}>
      {(['clean', 'sketch'] as const).map((m) => (
        <button
          key={m}
          role="radio"
          aria-checked={mode === m}
          onClick={() => setMode(m)}
          style={{
            all: 'unset',
            cursor: 'pointer',
            padding: '6px 14px',
            borderRadius: 7,
            fontSize: 13,
            fontWeight: 500,
            color: mode === m ? '#fff' : '#57606a',
            background: mode === m ? '#1f2328' : 'transparent',
            transition: 'background .15s, color .15s',
          }}
        >
          {m === 'clean' ? 'Clean' : 'Sketch'}
        </button>
      ))}
    </div>
  )
}

/** Quality score of the live board (canvas/quality/score.ts), recomputed after every change. Skipped for big grids. */
function QualityBadge() {
  const [report, setReport] = useState<QualityReport | undefined>()
  useEffect(() => {
    if (n > 0) return
    const run = () => setReport(score(board.doc, measure))
    run()
    return board.subscribe(run)
  }, [])
  if (!report) return null
  const tone = report.score >= 90 ? '#1a7f37' : report.score >= 70 ? '#9a6700' : '#cf222e'
  const issues = [
    report.overlaps.length && `${report.overlaps.length} overlap`,
    report.wraps.length && `${report.wraps.length} wrap`,
    report.edgeThroughNode.length && `${report.edgeThroughNode.length} through node`,
    report.outsideGroup.length && `${report.outsideGroup.length} outside group`,
    report.crossings && `${report.crossings} crossing`,
  ].filter(Boolean)
  return (
    <span style={{ ...chip, display: 'inline-flex', alignItems: 'center', gap: 6 }} title="canvas/quality/score.ts">
      <span style={{ width: 8, height: 8, borderRadius: 4, background: tone }} />
      <b style={{ color: tone, fontWeight: 600 }}>Quality {report.score}</b>
      {issues.length ? <span>{issues.join(' · ')}</span> : <span>no issues</span>}
    </span>
  )
}

function App() {
  const [mode, setMode] = useState<Mode>(params.get('mode') === 'sketch' ? 'sketch' : 'clean')
  const [sel, setSel] = useState<string[]>([])
  const [zoom, setZoom] = useState(1)
  const view = useRef<BoardViewHandle>(null)
  Object.assign(window, { __view: view })
  const onViewport = useMemo(() => (vp: { zoom: number }) => setZoom(vp.zoom), [])
  return (
    <div style={{ position: 'relative', height: '100%' }}>
      <BoardView board={board} measure={measure} mode={mode} onSelectionChange={setSel} onViewportChange={onViewport} handleRef={view} />
      <div style={{ position: 'absolute', top: 12, left: 12, display: 'flex', alignItems: 'center', gap: 10 }}>
        <Toggle mode={mode} setMode={setMode} />
        <span style={chip}>
          {Math.round(zoom * 100)}% · {sel.length} selected
        </span>
        <QualityBadge />
      </div>
    </div>
  )
}

createRoot(document.getElementById('root')!).render(<App />)
