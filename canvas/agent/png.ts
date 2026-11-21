// SVG -> PNG with headless Google Chrome (no extra dependency). Used by the CLI `render` and the
// `snapshot` tool, so an agent can look at the board as a picture.
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const CHROME_MAC = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'

export function findChrome(): string | undefined {
  if (process.platform === 'darwin' && existsSync(CHROME_MAC)) return CHROME_MAC
  return Bun.which('google-chrome') ?? Bun.which('chromium') ?? undefined
}

/** PNG bytes of `svg` (needs width/height on the root). `maxSide` scales the picture down to fit. */
export async function svgToPng(svg: string, { maxSide = Infinity }: { maxSide?: number } = {}): Promise<Uint8Array> {
  const chrome = findChrome()
  if (!chrome) throw new Error('PNG needs Google Chrome; install it or use SVG')
  const size = svg.match(/<svg[^>]*\swidth="([\d.]+)" height="([\d.]+)"/)
  if (!size) throw new Error('could not read the SVG width and height')
  const k = Math.min(1, maxSide / Math.max(Number(size[1]), Number(size[2])))
  const [w, h] = [Math.ceil(Number(size[1]) * k), Math.ceil(Number(size[2]) * k)]
  const scaled = k < 1 ? svg.replace(/(<svg[^>]*\s)width="[\d.]+" height="[\d.]+"/, `$1width="${w}" height="${h}"`) : svg
  const dir = mkdtempSync(join(tmpdir(), 'cw-png-'))
  try {
    const svgPath = join(dir, 'board.svg')
    const out = join(dir, 'board.png')
    writeFileSync(svgPath, scaled)
    // A private profile keeps headless Chrome from handing off to a Chrome the user already has open.
    const p = Bun.spawn(
      [chrome, '--headless=new', `--user-data-dir=${join(dir, 'profile')}`, `--screenshot=${out}`, `--window-size=${w},${h}`, '--hide-scrollbars', `file://${svgPath}`],
      { stdout: 'ignore', stderr: 'pipe', timeout: 60_000 },
    )
    const code = await p.exited
    if (code !== 0 || !existsSync(out)) {
      const last = (await new Response(p.stderr).text()).trim().split('\n').pop() ?? ''
      throw new Error(`Chrome did not write a PNG (exit ${code}). ${last}`.trim())
    }
    return new Uint8Array(readFileSync(out))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}
