import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { createReceiptPdf } from './receipt-pdf-fixture.mjs'
import { loadImage, createCanvas } from '@napi-rs/canvas'
import { build } from 'esbuild'

await mkdir('tmp', { recursive: true })
await build({
  stdin: { contents: "export * from './src/main/agent/document-images'; export * from './src/main/agent/product-region';", resolveDir: process.cwd(), loader: 'ts' },
  outfile: 'tmp/document-images.test.runtime.mjs',
  bundle: true,
  platform: 'node',
  format: 'esm',
  packages: 'external'
})
const { prepareDocument, createLocalDocumentPreview, cropPageHeader, cropPageDetailRegions, findProductTableBounds, createProductRecoveryImages } = await import('../tmp/document-images.test.runtime.mjs')
// Geometry tests must run without a private receipt file.
const receiptPath = 'tmp/document-images-synthetic.png'
const fixtureCanvas = createCanvas(800, 300)
const fixtureContext = fixtureCanvas.getContext('2d')
fixtureContext.fillStyle = 'white'
fixtureContext.fillRect(0, 0, 800, 300)
fixtureContext.fillStyle = 'red'
fixtureContext.fillRect(0, 0, 300, 300)
fixtureContext.fillStyle = 'blue'
fixtureContext.fillRect(500, 0, 300, 300)
await writeFile(receiptPath, fixtureCanvas.toBuffer('image/png'))
const source = await loadImage(await readFile(receiptPath))

test('product region finds skewed grid on a dark background, preserving first/last cells and multiline rows', async () => {
  const canvas = createCanvas(1000, 500)
  const ctx = canvas.getContext('2d')
  ctx.fillStyle = '#403020'; ctx.fillRect(0, 0, 1000, 500)
  ctx.fillStyle = '#ddd'; ctx.fillRect(80, 20, 850, 450)
  ctx.strokeStyle = '#111'; ctx.lineWidth = 1
  ctx.beginPath()
  for (let x = 120; x <= 840; x += 60) { ctx.moveTo(x, 150); ctx.lineTo(x + 5, 245) }
  for (const y of [150, 180, 245]) { ctx.moveTo(120, y); ctx.lineTo(845, y) }
  ctx.stroke()
  const bounds = findProductTableBounds(ctx.getImageData(0, 0, 1000, 500).data, 1000, 500)
  assert.ok(bounds)
  assert.ok(bounds.x < 120 && bounds.x + bounds.width > 845)
  assert.ok(bounds.y < 150 && bounds.y + bounds.height > 245)
  assert.ok(bounds.height < 130 && bounds.width > 720)
  const result = await createProductRecoveryImages({ data: canvas.toBuffer('image/png').toString('base64'), width: 1000, height: 500, mimeType: 'image/png' })
  assert.equal(result.locatedTable, true)
  assert.equal(result.images.length, 2)
  assert.ok(result.images.every(image => image.width > bounds.width && image.height >= bounds.height * 2 - 1 && image.mimeType === 'image/png'))
})

test('a barcode alone is not a product table', () => {
  const canvas = createCanvas(1000, 500), ctx = canvas.getContext('2d')
  ctx.fillStyle = 'white'; ctx.fillRect(0, 0, 1000, 500)
  ctx.fillStyle = 'black'
  for (let x = 100; x < 280; x += 6) ctx.fillRect(x, 30, 2, 60)
  assert.equal(findProductTableBounds(ctx.getImageData(0, 0, 1000, 500).data, 1000, 500), null)
})

test('when no table can be located, recovery retains both edges in enlarged overlapping views', async () => {
  const result = await createProductRecoveryImages({ data: fixtureCanvas.toBuffer('image/png').toString('base64'), width: 800, height: 300, mimeType: 'image/png' })
  assert.equal(result.locatedTable, false)
  for (const [index, region] of result.images.entries()) {
    assert.equal(region.width, 960); assert.equal(region.height, 600)
    const canvas = createCanvas(region.width, region.height), ctx = canvas.getContext('2d')
    ctx.drawImage(await loadImage(Buffer.from(region.data, 'base64')), 0, 0)
    assert.deepEqual([...ctx.getImageData(index ? region.width - 10 : 10, 10, 1, 1).data], index ? [0, 0, 255, 255] : [255, 0, 0, 255])
  }
})

test('lossless purchase rendering and detail views preserve both sides, overlap and the full page height', async () => {
  const document = await prepareDocument(receiptPath, 100 * 1024 * 1024, 50)
  try {
    const page = await document.renderPage(1, { imageScale: 3, imageFormat: 'png' })
    assert.equal(page.mimeType, 'image/png')
    assert.equal(page.width, 2400)
    const regions = await cropPageDetailRegions(page)
    assert.equal(regions.length, 2)
    for (const [i, region] of regions.entries()) {
      assert.equal(region.mimeType, 'image/png')
      assert.equal(region.height, page.height)
      assert.ok(region.width > page.width / 2 && region.width < page.width)
      const decoded = await loadImage(Buffer.from(region.data, 'base64'))
      const canvas = createCanvas(decoded.width, decoded.height)
      const context = canvas.getContext('2d')
      context.drawImage(decoded, 0, 0)
      const pixel = [...context.getImageData(i === 0 ? 10 : decoded.width - 10, 10, 1, 1).data]
      assert.deepEqual(pixel, i === 0 ? [255, 0, 0, 255] : [0, 0, 255, 255])
    }
    assert.deepEqual(await cropPageDetailRegions({ ...page, width: 300, height: 800 }), [])
  } finally { await document.dispose() }
})

test('receipt OCR can upscale small print without changing the default image size', async () => {
  const document = await prepareDocument(receiptPath, 100 * 1024 * 1024, 50)
  try {
    const original = await document.renderPage(1)
    const enlarged = await document.renderPage(1, { imageScale: 2 })
    assert.equal(original.width, source.width)
    assert.equal(original.height, source.height)
    assert.equal(enlarged.width, source.width * 2)
    assert.equal(enlarged.height, source.height * 2)
    const decoded = await loadImage(Buffer.from(enlarged.data, 'base64'))
    assert.equal(decoded.width, enlarged.width)
    assert.equal(decoded.height, enlarged.height)
  } finally {
    await document.dispose()
  }
})

test('lossless rendering retains source size metadata for small-print recovery on PNG and JPEG inputs', async () => {
  const jpegPath = 'tmp/document-images-synthetic.jpg'
  await writeFile(jpegPath, await fixtureCanvas.encode('jpeg', 95))
  for (const file of [receiptPath, jpegPath]) {
    const document = await prepareDocument(file, 100 * 1024 * 1024, 50)
    try {
      const page = await document.renderPage(1, { imageScale: 3, imageFormat: 'png' })
      assert.equal(page.mimeType, 'image/png')
      assert.equal(page.sourceWidth, 800)
      const decoded = await loadImage(Buffer.from(page.data, 'base64'))
      assert.equal(decoded.width, page.width)
      assert.equal(decoded.height, page.height)
    } finally { await document.dispose() }
  }
})

test('upscaled receipt images still obey the OCR dimension limit', async () => {
  const document = await prepareDocument(receiptPath, 100 * 1024 * 1024, 50)
  try {
    const enlarged = await document.renderPage(1, { imageScale: 4 })
    assert.equal(Math.max(enlarged.width, enlarged.height), 2600)
    assert.ok(Math.abs(enlarged.height - enlarged.width * source.height / source.width) <= 1)
  } finally {
    await document.dispose()
  }
})

test('the receipt selection preview stays a local 720 pixel thumbnail', async () => {
  const preview = await createLocalDocumentPreview(receiptPath, 100 * 1024 * 1024, 50)
  assert.equal(preview.pageCount, 1)
  const image = await loadImage(preview.pages[0].thumbnailDataUrl)
  assert.equal(Math.max(image.width, image.height), 720)
})

test('header recovery crops only the selected page and preserves its width', async () => {
  const document = await prepareDocument(receiptPath, 100 * 1024 * 1024, 50)
  try {
    const page = await document.renderPage(1, { imageScale: 2 })
    const header = await cropPageHeader(page)
    const decoded = await loadImage(Buffer.from(header.data, 'base64'))
    assert.equal(decoded.width, page.width)
    assert.equal(decoded.height, Math.ceil(page.height / 4))
  } finally {
    await document.dispose()
  }
})

test('a three-page PDF made from the receipt supports per-page rendering and header recovery', async () => {
  const pdfPath = 'tmp/document-images-three-pages.pdf'
  await writeFile(pdfPath, await createReceiptPdf(receiptPath))
  const document = await prepareDocument(pdfPath, 100 * 1024 * 1024, 50)
  try {
    assert.equal(document.pageCount, 3)
    for (const pageNumber of [1, 3]) {
      const page = await document.renderPage(pageNumber, { imageScale: 2 })
      // PDF.js already renders at 2x. The raster-image option must not double it again.
      assert.equal(page.width, source.width * 2)
      assert.equal(page.height, source.height * 2)
      const header = await cropPageHeader(page)
      assert.equal(header.width, page.width)
    }
    await assert.rejects(document.renderPage(4), /超出范围/)
  } finally {
    await document.dispose()
  }
  const preview = await createLocalDocumentPreview(pdfPath, 100 * 1024 * 1024, 50)
  assert.deepEqual(preview.pages.map((page) => page.pageNumber), [1, 2, 3])
})
