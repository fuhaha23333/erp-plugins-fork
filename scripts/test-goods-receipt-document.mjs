import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { resolve } from 'node:path'
import { build } from 'esbuild'
import { createReceiptPdf } from './receipt-pdf-fixture.mjs'

// Opt-in integration test: sends only the named receipt to the configured models.
const root = fileURLToPath(new URL('../', import.meta.url))
try {
  process.loadEnvFile(resolve(root, '.env'))
} catch (error) {
  if (error?.code !== 'ENOENT') throw error
}
const fixture = JSON.parse(await readFile(
  resolve(root, 'test-data/goods-receipt.ckfh26070523.json'), 'utf8'
))
const artifactDirectory = resolve(root, 'tmp/goods-receipt-document')
await mkdir(artifactDirectory, { recursive: true })
const pdfMode = process.argv.includes('--pdf')
let documentPath = resolve(root, fixture.sourceImage)
if (pdfMode) {
  const pdf = await createReceiptPdf(documentPath)
  documentPath = resolve(artifactDirectory, 'receipt-three-pages.pdf')
  await writeFile(documentPath, pdf)
}
const selectedPages = pdfMode ? [1, 3] : [1]
const runtimePath = resolve(artifactDirectory, 'runtime.mjs')
await build({
  stdin: {
    contents: `
      export { PiDocumentClient } from './src/main/agent/pi-document-client'
      export { loadPiAgentConfig } from './src/main/agent/config'
    `,
    resolveDir: root,
    loader: 'ts'
  },
  outfile: runtimePath,
  bundle: true,
  platform: 'node',
  format: 'esm',
  packages: 'external',
  define: { 'import.meta.env': '{}' }
})
const { PiDocumentClient, loadPiAgentConfig } = await import(pathToFileURL(runtimePath).href)
const client = new PiDocumentClient(loadPiAgentConfig())
const result = await client.extractDocument(
  documentPath,
  (progress) => console.log(progress.message),
  { businessId: 'goods-receipt', excludedPages: pdfMode ? [2] : [] }
)
const resultPath = resolve(artifactDirectory, pdfMode ? 'result-pdf.json' : 'result.json')
await writeFile(resultPath, JSON.stringify(result, null, 2))
assert.equal(result.status, 'completed', result.message)
const extraction = result.result?.extractedData
assert.equal(extraction?.documentType, 'goods-receipt')
assert.equal(extraction.header.supplierName, fixture.erpPayload.header.supplierName)
assert.equal(extraction.header.departureDate, fixture.erpPayload.header.departureDate)
assert.match(extraction.header.receiptRemark ?? '', /CKFH26070523/)
assert.equal(extraction.header.carrierName, null, '票面未提供承运单位')
assert.equal(extraction.header.transportMethod, null, '票面未提供承运方式')
assert.equal(extraction.header.surfaceTemperature, null, '票面未提供外表温度')
assert.equal(result.result.pageCount, pdfMode ? 3 : 1)
assert.equal(result.result.ocrPages, selectedPages.length)
assert.deepEqual(result.result.pages.map((page) => page.source), pdfMode ? ['pi-ocr', 'skipped-user', 'pi-ocr'] : ['pi-ocr'])
assert.equal(extraction.items.length, 7 * selectedPages.length, '必须保留每页的七个票据原始行')
assert.deepEqual(
  extraction.items.map((item) => item.arrivalQuantity),
  selectedPages.flatMap(() => fixture.erpPayload.items.map((item) => item.arrivalQuantity))
)
assert.deepEqual(
  extraction.items.map((item) => item.sourcePages),
  selectedPages.flatMap((page) => fixture.erpPayload.items.map(() => [page]))
)
assert.ok(extraction.items.every((item) => item.receiptQuantity === null), '实际收货数量须由收货人员核验')
assert.ok(extraction.fieldEvidence['header.supplierName']?.sourcePages.every((page) => selectedPages.includes(page)))
assert.equal(
  Math.round(extraction.items.reduce((total, item) => total + (item.amount ?? 0), 0) * 100),
  10445440 * selectedPages.length
)
assert.equal(extraction.readyForAutofill, true)
assert.equal(result.result.coveragePercent, 100)
console.log(`通过：${selectedPages.length} 页供应商、日期、单号、${extraction.items.length} 行数量及合计金额正确，可进入确认代填。结果：${resultPath}`)
