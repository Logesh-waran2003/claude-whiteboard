// Pure camera math. screen = (world - cam) * zoom.
import type { Point, Rect } from '../core/model'

export type Camera = { x: number; y: number; zoom: number }
export type Size = { width: number; height: number }
export type Viewport = Rect & { zoom: number }

export const MIN_ZOOM = 0.1
export const MAX_ZOOM = 4

export const clampZoom = (z: number) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z))

export const toWorld = (cam: Camera, p: Point): Point => ({ x: cam.x + p.x / cam.zoom, y: cam.y + p.y / cam.zoom })
export const toScreen = (cam: Camera, p: Point): Point => ({ x: (p.x - cam.x) * cam.zoom, y: (p.y - cam.y) * cam.zoom })
export const rectToScreen = (cam: Camera, r: Rect): Rect => ({ ...toScreen(cam, r), width: r.width * cam.zoom, height: r.height * cam.zoom })

/** The world rect the screen shows. */
export const viewportOf = (cam: Camera, size: Size): Viewport => ({
  x: cam.x,
  y: cam.y,
  width: size.width / cam.zoom,
  height: size.height / cam.zoom,
  zoom: cam.zoom,
})

/** Pan by a screen-space delta (wheel / drag). */
export const panBy = (cam: Camera, dxScreen: number, dyScreen: number): Camera => ({
  ...cam,
  x: cam.x + dxScreen / cam.zoom,
  y: cam.y + dyScreen / cam.zoom,
})

/** Zoom to `zoom` keeping the world point under screen point `at` fixed. */
export function zoomAt(cam: Camera, at: Point, zoom: number): Camera {
  const z = clampZoom(zoom)
  const w = toWorld(cam, at)
  return { x: w.x - at.x / z, y: w.y - at.y / z, zoom: z }
}

/** Camera that fits `bounds` into `size` with screen padding; never zooms past 1 for small content. */
export function fitCamera(bounds: Rect, size: Size, padding = 48, maxZoom = 1): Camera {
  const w = Math.max(1, size.width - padding * 2)
  const h = Math.max(1, size.height - padding * 2)
  const zoom = clampZoom(Math.min(maxZoom, w / Math.max(1, bounds.width), h / Math.max(1, bounds.height)))
  return {
    x: bounds.x + bounds.width / 2 - size.width / 2 / zoom,
    y: bounds.y + bounds.height / 2 - size.height / 2 / zoom,
    zoom,
  }
}

export const lerpCamera = (a: Camera, b: Camera, t: number): Camera => ({
  x: a.x + (b.x - a.x) * t,
  y: a.y + (b.y - a.y) * t,
  zoom: a.zoom + (b.zoom - a.zoom) * t,
})

/** Wheel event -> zoom factor. Pinch (ctrlKey) sends small deltas; mouse wheels send ~100 per notch. */
export function wheelZoomFactor(deltaY: number, deltaMode: number): number {
  const d = deltaMode === 1 ? deltaY * 16 : deltaY
  return Math.exp(-Math.max(-60, Math.min(60, d)) * 0.01)
}
