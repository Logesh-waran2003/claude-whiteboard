// M5 end-to-end: spawn the MCP stdio server, drive it with the MCP SDK client, check the file on disk.
// Run: bun canvas/agent/e2e.ts
import { readFileSync, rmSync } from 'node:fs'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { fromJSON } from '../core/board'

const dir = '/tmp/m5-e2e'
const file = `${dir}/board.canvas`
rmSync(dir, { recursive: true, force: true })

const transport = new StdioClientTransport({
  command: 'bun',
  args: [new URL('./mcp-stdio.ts', import.meta.url).pathname, '--file', file, '--agent', 'e2e'],
  stderr: 'ignore',
})
const client = new Client({ name: 'm5-e2e', version: '0.0.0' })

const text = (r: any): string => r.content?.[0]?.text ?? ''
const call = async (name: string, args: Record<string, unknown> = {}) => {
  const r = await client.callTool({ name, arguments: args })
  if (r.isError) throw new Error(`${name} failed: ${text(r)}`)
  return text(r)
}

try {
  await client.connect(transport)
  console.log('instructions:', client.getInstructions())
  const { tools } = await client.listTools()
  console.log('tools:', tools.map((t) => t.name).join(', '))

  const skill = await call('get_skill')
  console.log('get_skill:', skill.split('\n').length, 'lines, starts', JSON.stringify(skill.split('\n')[1]))

  const drawn = JSON.parse(
    await call('draw_mermaid', {
      source: `flowchart TB
  subgraph web [Web]
    direction LR
    ui[Editor UI] -->|ops| view[Canvas view]
  end
  subgraph srv [Server]
    direction LR
    api[HTTP API] -->|writes| store[Board store]
  end
  subgraph data [Data]
    direction LR
    file((Board file))
    notes((Notes))
  end
  ui -->|save| api
  store -->|persist| file
  api -->|reads| notes`,
    }),
  )
  console.log('draw_mermaid quality:', JSON.stringify(drawn.quality), 'version', drawn.version)
  console.log('draw_mermaid ids:', JSON.stringify(drawn.ids), 'edges:', JSON.stringify(drawn.edges))

  const outline = await call('read_board')
  console.log('read_board:\n' + outline.split('\n').map((l) => '  | ' + l).join('\n'))

  const renamed = JSON.parse(await call('apply', { ops: [{ op: 'update', id: 'api', text: 'REST API' }], baseVersion: drawn.version }))
  console.log('apply rename: ok', renamed.ok, 'version', renamed.version, 'score', renamed.quality.score)

  const check = JSON.parse(await call('check'))
  console.log('check: score', check.score, 'overlaps', check.overlaps.length, 'wraps', check.wraps.length, 'crossings', check.crossings)

  const svg = await call('snapshot')
  console.log('snapshot:', svg.length, 'chars, <svg', svg.startsWith('<svg'), ', has "REST API"', svg.includes('REST API'))

  const disk = readFileSync(file, 'utf8')
  const board = fromJSON(disk)
  const roundTrip = board.toJSON() === JSON.stringify(JSON.parse(disk), null, 2)
  const api = board.doc.nodes.find((n) => n.id === 'api')
  console.log(
    'file on disk: valid JSON Canvas, nodes', board.doc.nodes.length, 'edges', board.doc.edges.length,
    '| round-trips', roundTrip, '| api text', JSON.stringify(api && 'text' in api ? api.text : undefined),
  )
} finally {
  await client.close()
  rmSync(dir, { recursive: true, force: true })
}
