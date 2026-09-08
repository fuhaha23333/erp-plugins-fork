import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile, writeFile } from 'node:fs/promises'
import { createReceiptPdf } from './receipt-pdf-fixture.mjs'
import { loadImage } from '@napi-rs/canvas'
import { build } from 'esbuild'

await build({
  entryPoints: ['src/main/agent/document-images.ts'],
  outfile: 'tmp/document-images.test.runtime.mjs',
  bundle: true,
  platform: 'node',
  format: 'esm',
  packages: 'external'
})
const { prepareDocument, createLocalDocumentPreview, cropPageHeader } = await import('../tmp/document-images.test.runtime.mjs')
const receiptPath = 'f1be425b3289565524cce105c39875d5.png'
const source = await loadImage(await readFile(receiptPath))

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
