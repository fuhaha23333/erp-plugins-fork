import { createCanvas, loadImage } from '@napi-rs/canvas'
import type { PreparedPageImage } from './document-images'

interface Bounds { x: number; y: number; width: number; height: number }

/** Locate the dense set of vertical cell rules, excluding outer page borders and barcodes.
 * Analyze a bounded thumbnail; coordinates always map back to the selected page image.
 */
export function findProductTableBounds(pixels: Uint8ClampedArray, width: number, height: number): Bounds | null {
  const minRun = Math.max(24, Math.round(height * 0.04))
  const bucketWidth = Math.max(4, Math.round(width * 0.008))
  // Narrow, contrasting rules only: dark desks/page shadows are not table borders.
  // A small horizontal tolerance accommodates photographed/skewed cell rules.
  const brightness = (x: number, y: number): number => {
    const offset = (y * width + x) * 4
    return pixels[offset + 3] > 128 ? Math.max(pixels[offset], pixels[offset + 1], pixels[offset + 2]) : 255
  }
  const isRule = (x: number, y: number): boolean => {
    if (y >= height) return false
    for (let dx = -2; dx <= 2; dx++) {
      const sampleX = x + dx
      if (sampleX < 4 || sampleX >= width - 4) continue
      const value = brightness(sampleX, y)
      if (value < 150 && brightness(sampleX - 4, y) > value + 35 && brightness(sampleX + 4, y) > value + 35) return true
    }
    return false
  }
  const buckets = new Map<number, Array<[number, number]>>()
  for (let x = 0; x < width; x += 2) {
    let start = -1, gap = 0
    for (let y = 0; y <= height; y++) {
      const dark = isRule(x, y)
      if (dark) { if (start < 0) start = y; gap = 0 }
      else if (start >= 0 && (++gap > 2 || y === height)) {
        const end = y - gap + 1
        if (end - start >= minRun) {
          const key = Math.floor(x / bucketWidth)
          const runs = buckets.get(key) ?? []
          runs.push([start, end]); buckets.set(key, runs)
        }
        start = -1; gap = 0
      }
    }
  }
  const columns = [...buckets].map(([bucket, runs]) => {
    const merged: Array<[number, number]> = []
    for (const run of runs.sort((a, b) => a[0] - b[0])) {
      const previous = merged.at(-1)
      if (previous && run[0] <= previous[1] + 2) previous[1] = Math.max(previous[1], run[1])
      else merged.push([...run])
    }
    return { x: bucket * bucketWidth, runs: merged }
  })
  const bands: Array<[number, number]> = []
  let start = -1
  for (let y = 0; y <= height; y++) {
    const count = columns.filter(column => column.runs.some(([top, bottom]) => y >= top && y < bottom)).length
    if (count >= 5) { if (start < 0) start = y }
    else if (start >= 0) { if (y - start >= minRun) bands.push([start, y]); start = -1 }
  }
  const candidates = bands.flatMap(([top, bottom]): Bounds[] => {
    const xs = columns.filter(column => column.runs.some(([a, b]) =>
      Math.min(b, bottom) - Math.max(a, top) >= (bottom - top) * 0.5)).map(column => column.x).sort((a, b) => a - b)
    if (xs.length < 5 || xs[Math.floor(xs.length * 0.75)] - xs[Math.floor(xs.length * 0.25)] < width * 0.2) return []
    const padding = Math.max(6, Math.ceil(height * 0.015))
    const x = Math.max(0, xs[0] - padding), y = Math.max(0, top - padding)
    return [{ x, y, width: Math.min(width, xs.at(-1)! + bucketWidth + padding) - x,
      height: Math.min(height, bottom + padding) - y }]
  })
  return candidates.sort((a, b) => b.width * b.height - a.width * a.height)[0] ?? null
}

export async function createProductRecoveryImages(image: PreparedPageImage) {
  const source = await loadImage(Buffer.from(image.data, 'base64'))
  const scale = Math.min(1, 1000 / Math.max(source.width, source.height))
  const analysis = createCanvas(Math.max(1, Math.round(source.width * scale)), Math.max(1, Math.round(source.height * scale)))
  const context = analysis.getContext('2d')
  context.fillStyle = 'white'; context.fillRect(0, 0, analysis.width, analysis.height)
  context.drawImage(source, 0, 0, analysis.width, analysis.height)
  const bounds = findProductTableBounds(context.getImageData(0, 0, analysis.width, analysis.height).data, analysis.width, analysis.height)
  const scaleX = source.width / analysis.width, scaleY = source.height / analysis.height
  const area = bounds ? { x: bounds.x * scaleX, y: bounds.y * scaleY, width: bounds.width * scaleX, height: bounds.height * scaleY }
    : { x: 0, y: 0, width: source.width, height: source.height }
  const horizontal = area.width >= area.height
  const regions = [0, 0.4].map(offset => horizontal
    ? { x: area.x + area.width * offset, y: area.y, width: area.width * 0.6, height: area.height }
    : { x: area.x, y: area.y + area.height * offset, width: area.width, height: area.height * 0.6 })
  const images: PreparedPageImage[] = []
  for (const region of regions) {
    const enlarge = Math.min(2, 2600 / Math.max(region.width, region.height))
    const canvas = createCanvas(Math.max(1, Math.round(region.width * enlarge)), Math.max(1, Math.round(region.height * enlarge)))
    canvas.getContext('2d').drawImage(source, region.x, region.y, region.width, region.height, 0, 0, canvas.width, canvas.height)
    images.push({ data: (await canvas.encode('png')).toString('base64'), mimeType: 'image/png', width: canvas.width, height: canvas.height })
  }
  return { images, locatedTable: Boolean(bounds) }
}
