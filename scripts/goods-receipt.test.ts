import assert from 'node:assert/strict'
import test from 'node:test'
import vm from 'node:vm'
import receiptFixture from '../test-data/goods-receipt.ckfh26070523.json'
import { normalizeAutofillResult } from '../src/main/erp-autofill-result'
import type { GoodsReceiptExtraction, GoodsReceiptItem } from '../src/shared/business'
import {
  normalizeGoodsReceiptSubmission,
  mergeGoodsReceiptExtractions,
  needsGoodsReceiptHeaderOcr,
  type GoodsReceiptSubmission
} from '../src/main/businesses/goods-receipt-tool'
import {
  buildExtractedAutofillScript,
  buildFixtureAutofillScript
} from '../src/main/erp-autofill'

class FakeInput {
  value = ''
  disabled = false
  readOnly = false
  dispatchEvent(): void {}
}

class FakeSelect extends FakeInput {}
class FakeTextArea extends FakeInput {}
class FakeEvent {}

class FakeCell {
  value = ''

  setValue(value: string): void {
    this.value = value
  }

  getValue(): string {
    return this.value
  }
}

const detailFieldNames = [
  'SPMC', 'SPBH', 'GG', 'SCCS', 'DW', 'DJ', 'DDSL', 'DHSL', 'SHSL', 'JSSL',
  'SPPH', 'SCRQ', 'YXQZ', 'SPM', 'JX', 'BZ'
]

function createRow(initial: Record<string, string> = {}) {
  const cells = Object.fromEntries(
    detailFieldNames.map((field) => [field, new FakeCell()])
  ) as Record<string, FakeCell>
  for (const [field, value] of Object.entries(initial)) cells[field].value = value
  return { cells: () => cells }
}

function createFixtureContext() {
  const rows = [createRow()]
  const elements = new Map<string, FakeInput>([
    ['DWMC', new FakeInput()],
    ['DWBH', new FakeInput()],
    ['QYRQ', new FakeInput()],
    ['CYDW', new FakeInput()],
    ['CYFS', new FakeInput()],
    ['SHDJBZ', new FakeTextArea()]
  ])
  const pageWindow = {
    setTimeout,
    gridEditBody: { getRows: () => rows },
    gridhandler: () => rows.push(createRow())
  }
  return {
    rows,
    elements,
    context: {
      window: pageWindow,
      document: { getElementById: (id: string) => elements.get(id) ?? null },
      HTMLInputElement: FakeInput,
      HTMLSelectElement: FakeSelect,
      HTMLTextAreaElement: FakeTextArea,
      Event: FakeEvent,
      KeyboardEvent: FakeEvent,
      setTimeout
    }
  }
}

function goodsReceiptExtraction(
  items: GoodsReceiptItem[],
  supplierName = '吉林省润强药业有限公司'
): GoodsReceiptExtraction {
  return {
    documentType: 'goods-receipt',
    header: {
      supplierName,
      departureDate: '2026-07-21',
      carrierName: null,
      transportMethod: null,
      receiptDateTime: null,
      surfaceTemperature: null,
      transportProcessTemperatureStatus: null,
      transportVehicle: null,
      departurePlace: null,
      departureDateTime: null,
      receiptDateTimeDetail: null,
      actualTransportHours: null,
      receiptRemark: '随货同行单号：CKFH26070523',
      goodsAccountConsistency: null,
      deliveryNoteCompliance: null,
      enclosedVehicle: null,
      logisticsVoucherCompliance: null,
      transportTimeLimitStatus: null
    },
    items,
    fieldEvidence: {},
    recognizedFieldCount: 0,
    missingRecommendedFields: [],
    reviewRequired: [],
    readyForAutofill: true
  }
}

function receiptItem(overrides: Partial<GoodsReceiptItem> = {}): GoodsReceiptItem {
  return {
    productName: '安神补心丸',
    specification: '2g/15丸:200丸/瓶*1瓶/盒*20盒',
    manufacturer: '通药制药集团股份有限公司',
    marketingAuthorizationHolder: '通药制药集团股份有限公司',
    unit: '盒',
    packageQuantity: 200,
    arrivalQuantity: 2000,
    receiptQuantity: 2000,
    unitPrice: 7.31,
    amount: 14620,
    batchNumber: '260401',
    productionDate: '2026-04-11',
    expiryDate: '2029-03-31',
    approvalNumber: '国药准字Z22023350',
    dosageForm: '丸剂（水浓缩丸）',
    pieceRatio: 10,
    remark: null,
    sourcePages: [1],
    ...overrides
  }
}

test('recognized data uses the same blank-grid insertion path as the working fixture', async () => {
  const fixturePage = createFixtureContext()
  const recognizedPage = createFixtureContext()
  const extraction = goodsReceiptExtraction(receiptFixture.erpPayload.items.map(item => ({ ...item, sourcePages: [1] })))
  const fixtureResult = await vm.runInNewContext(buildFixtureAutofillScript('goods-receipt'), fixturePage.context)
  const recognizedResult = await vm.runInNewContext(buildExtractedAutofillScript(extraction), recognizedPage.context)
  assert.equal(fixtureResult.filledDetailRows, 7)
  assert.equal(recognizedResult.filledDetailRows, 7)
  assert.deepEqual(recognizedPage.rows.map(row => Object.fromEntries(Object.entries(row.cells()).map(([key, cell]) => [key, cell.value]))),
    fixturePage.rows.map(row => Object.fromEntries(Object.entries(row.cells()).map(([key, cell]) => [key, cell.value]))))
})

test('OCR fills all recognized product columns even when ERP references have no candidates', async () => {
  const page = createFixtureContext()
  const noReference = () => { throw new Error('无可用参照内容') }
  Object.assign(page.context.window, { doDjHeadCz: noReference, doHeadCz: noReference, onGridDblClick: noReference })
  const result = await vm.runInNewContext(buildExtractedAutofillScript(goodsReceiptExtraction([receiptItem({ receiptQuantity: null })])), page.context)
  assert.equal(result.filledDetailRows, 1)
  const cells = page.rows[0].cells()
  assert.equal(cells.SPMC.value, '安神补心丸')
  assert.equal(cells.GG.value, receiptItem().specification)
  assert.equal(cells.SCCS.value, receiptItem().manufacturer)
  assert.equal(cells.DJ.value, '7.31')
  assert.equal(cells.DHSL.value, '2000')
  assert.equal(cells.SPPH.value, '260401')
  assert.equal(cells.SCRQ.value, '2026-04-11')
  assert.equal(cells.YXQZ.value, '2029-03-31')
  assert.equal(cells.SHSL.value, '')
  assert.equal(cells.JSSL.value, '')
  assert.equal(cells.DDSL.value, '') // Packaging is not the ERP order quantity.
  assert.equal(cells.SPBH.value, '')
  assert.equal(page.elements.get('DWBH')!.value, '')
})

test('a retry preserves every printed line without duplicating or collapsing same-product rows', async () => {
  const page = createFixtureContext()
  const extraction = goodsReceiptExtraction(receiptFixture.erpPayload.items.map(item => ({ ...item, receiptQuantity: null, sourcePages: [1] })))
  const script = buildExtractedAutofillScript(extraction)
  await vm.runInNewContext(script, page.context)
  const result = await vm.runInNewContext(script, page.context)
  assert.equal(result.filledDetailRows, 7)
  assert.equal(page.rows.length, 7)
  assert.deepEqual(page.rows.map(row => row.cells().DHSL.value), ['2000', '220', '3200', '180', '8400', '1440', '2000'])
})

test('row allocation survives ERP replacing its grid controller and row objects', async () => {
  const page = createFixtureContext()
  const controller = () => ({ getRows: () => page.rows })
  page.context.window.gridhandler = () => {
    const rebound = page.rows.map(row => createRow(Object.fromEntries(Object.entries(row.cells()).map(([key, cell]) => [key, cell.value]))))
    page.rows.splice(0, page.rows.length, ...rebound, createRow())
    page.context.window.gridEditBody = controller()
    return page.rows.length
  }
  const extraction = goodsReceiptExtraction(receiptFixture.erpPayload.items.map(item => ({ ...item, receiptQuantity: null, sourcePages: [1] })))
  const result = await vm.runInNewContext(buildExtractedAutofillScript(extraction), page.context)
  assert.equal(result.filledDetailRows, 7)
  assert.deepEqual(page.rows.map(row => row.cells().DHSL.value), ['2000', '220', '3200', '180', '8400', '1440', '2000'])
})

test('OCR creates a new row without overwriting an unrelated existing product', async () => {
  const page = createFixtureContext()
  page.rows[0] = createRow({ SPMC: '其他商品', GG: '原规格', DHSL: '10' })
  const result = await vm.runInNewContext(buildExtractedAutofillScript(goodsReceiptExtraction([receiptItem()])), page.context)
  assert.equal(result.filledDetailRows, 1)
  assert.equal(page.rows.length, 2)
  assert.equal(page.rows[0].cells().SPMC.value, '其他商品')
  assert.equal(page.rows[0].cells().DHSL.value, '10')
  assert.equal(page.rows[1].cells().SPMC.value, '安神补心丸')
})

test('existing ERP IDs and order prices are preserved and another supplier is not overwritten', async () => {
  const page = createFixtureContext()
  page.elements.get('DWMC')!.value = receiptItem().manufacturer!
  page.elements.get('DWBH')!.value = 'EXISTING-SUPPLIER'
  const script = buildExtractedAutofillScript(goodsReceiptExtraction([receiptItem()]))
  let result = await vm.runInNewContext(script, page.context)
  assert.equal(result.filledDetailRows, 0)
  assert.equal(page.elements.get('DWBH')!.value, 'EXISTING-SUPPLIER')
  page.elements.get('DWMC')!.value = '吉林省润强药业有限公司'
  page.rows[0] = createRow({ SPMC: '安神补心丸', SPBH: 'EXISTING-PRODUCT', DJ: '99', DDSL: '10000' })
  result = await vm.runInNewContext(script, page.context)
  assert.equal(result.filledDetailRows, 1)
  assert.equal(page.rows[0].cells().SPBH.value, 'EXISTING-PRODUCT')
  assert.equal(page.rows[0].cells().DJ.value, '99')
  assert.equal(page.rows[0].cells().DDSL.value, '10000')
})

test('rejected cell writes produce an incomplete result instead of false success', async () => {
  const page = createFixtureContext()
  page.rows[0].cells().DHSL.setValue = () => {}
  const result = await vm.runInNewContext(buildExtractedAutofillScript(goodsReceiptExtraction([receiptItem()])), page.context)
  assert.equal(result.filledDetailRows, 0)
  assert.ok(result.skippedFields.some((field: string) => field.includes('DHSL')))
  assert.equal(normalizeAutofillResult(result, 1).status, 'partial')
})

test('failure to add rows does not reuse an already assigned row for another item', async () => {
  const page = createFixtureContext()
  page.context.window.gridhandler = () => { throw new Error('ERP add rejected') }
  const result = await vm.runInNewContext(buildExtractedAutofillScript(goodsReceiptExtraction([receiptItem(), receiptItem({ productName: '第二个商品' })])), page.context)
  assert.equal(result.filledDetailRows, 1)
  assert.equal(page.rows.length, 1)
  assert.equal(page.rows[0].cells().SPMC.value, '安神补心丸')
  assert.ok(result.skippedFields.some((field: string) => field.includes('第二个商品')))
})

test('multi-page PDF data uses the same insertion path and retains fourteen separate lines', async () => {
  const page = createFixtureContext()
  const items = [1, 3].flatMap(source => receiptFixture.erpPayload.items.map(item => ({ ...item, receiptQuantity: null, sourcePages: [source] })))
  const result = await vm.runInNewContext(buildExtractedAutofillScript(goodsReceiptExtraction(items)), page.context)
  assert.equal(result.filledDetailRows, 14)
  assert.equal(page.rows.length, 14)
})

test('header-only, partial, empty and malformed ERP results cannot be reported as fully filled', () => {
  assert.equal(normalizeAutofillResult({ filledHeaderFields: 2, filledDetailRows: 0, skippedFields: [] }, 7).status, 'partial')
  assert.equal(normalizeAutofillResult({ filledHeaderFields: 2, filledDetailRows: 6, skippedFields: [] }, 7).status, 'partial')
  assert.equal(normalizeAutofillResult({ filledHeaderFields: 0, filledDetailRows: 0, skippedFields: [] }).status, 'failed')
  assert.equal(normalizeAutofillResult({ filledHeaderFields: NaN, filledDetailRows: 7, skippedFields: [] }, 7).status, 'failed')
})

test('goods receipt fixture reproduces CKFH26070523 with seven rows and the printed total', async () => {
  const { rows, elements, context } = createFixtureContext()

  const result = await vm.runInNewContext(
    buildFixtureAutofillScript('goods-receipt'),
    context
  ) as { filledHeaderFields: number; filledDetailRows: number; skippedFields: string[] }

  assert.equal(result.filledHeaderFields, 3)
  assert.equal(result.filledDetailRows, 7)
  assert.equal(result.skippedFields.length, 0)
  assert.equal(elements.get('DWMC')?.value, '吉林省润强药业有限公司')
  assert.equal(elements.get('QYRQ')?.value, '2026-07-21')
  assert.equal(elements.get('CYDW')?.value, '')
  assert.equal(elements.get('CYFS')?.value, '')
  assert.match(elements.get('SHDJBZ')?.value ?? '', /CKFH26070523/)
  assert.equal(rows.length, 7)
  assert.deepEqual(rows.map((row) => row.cells().DHSL.value), [
    '2000', '220', '3200', '180', '8400', '1440', '2000'
  ])
  assert.deepEqual(rows.slice(1, 5).map((row) => row.cells().SPPH.value), [
    '251103', '251103', '251102', '251102'
  ])
  const printedTotal = rows.reduce(
    (sum, row) => sum + Number(row.cells().DHSL.value) * Number(row.cells().DJ.value),
    0
  )
  assert.equal(printedTotal, 104454.4)
})

test('production autofill selects the uniquely matching specification instead of the first same-name row', async () => {
  const wrongRow = createRow({
    SPMC: '硫酸庆大霉素碳酸铋胶囊',
    SPBH: 'SP002',
    GG: '错误规格',
    SCCS: '修正药业集团长春高新制药有限公司',
    SPPH: '251103'
  })
  const matchingRow = createRow({
    SPMC: '硫酸庆大霉素碳酸铋胶囊',
    SPBH: 'SP002',
    GG: '(40:600)mg*10粒/板*1板/盒*400盒',
    SCCS: '修正药业集团长春高新制药有限公司',
    SPPH: '251103'
  })
  const supplier = new FakeInput()
  supplier.value = '吉林省润强药业有限公司'
  const supplierCode = new FakeInput()
  supplierCode.value = 'SUP-001'
  const elements = new Map<string, FakeInput>([
    ['DWMC', supplier],
    ['DWBH', supplierCode],
    ['QYRQ', new FakeInput()],
    ['SHDJBZ', new FakeTextArea()]
  ])
  const context = {
    window: {
      setTimeout,
      gridEditBody: { getRows: () => [wrongRow, matchingRow] }
    },
    document: { getElementById: (id: string) => elements.get(id) ?? null },
    HTMLInputElement: FakeInput,
    HTMLSelectElement: FakeSelect,
    HTMLTextAreaElement: FakeTextArea,
    Event: FakeEvent,
    KeyboardEvent: FakeEvent,
    setTimeout
  }
  const item = receiptItem({
    productName: '硫酸庆大霉素碳酸铋胶囊',
    specification: '(40:600)mg*10粒/板*1板/盒*400盒',
    manufacturer: '修正药业集团长春高新制药有限公司',
    batchNumber: '251103',
    arrivalQuantity: 220,
    receiptQuantity: 220
  })

  await vm.runInNewContext(
    buildExtractedAutofillScript(goodsReceiptExtraction([item])),
    context
  )

  assert.equal(wrongRow.cells().DHSL.value, '')
  assert.equal(matchingRow.cells().DHSL.value, '220')
  assert.equal(matchingRow.cells().SHSL.value, '220')
})

test('normalization flags missing carrier fields for manual completion', () => {
  const extraction = goodsReceiptExtraction([receiptItem()])
  const submission: GoodsReceiptSubmission = {
    header: extraction.header,
    items: extraction.items,
    evidence: [],
    reviewRequired: []
  }

  const normalized = normalizeGoodsReceiptSubmission(submission, 1)

  assert.ok(normalized.reviewRequired.some((message) => message.includes('承运单位')))
  assert.ok(normalized.reviewRequired.some((message) => message.includes('承运方式')))
  assert.equal(normalized.header.carrierName, null)
  assert.equal(normalized.header.transportMethod, null)
})

test('CKFH26070523 can be reviewed for autofill with a supplier and seven rows despite absent transport fields', () => {
  const submission: GoodsReceiptSubmission = {
    header: receiptFixture.erpPayload.header,
    items: receiptFixture.erpPayload.items.map((item) => ({ ...item, sourcePages: [1] })),
    evidence: [{
      fieldPath: 'header.supplierName', sourcePages: [1], confidence: 0.99, reviewRequired: false
    }],
    reviewRequired: []
  }

  const extraction = normalizeGoodsReceiptSubmission(submission, 1)

  assert.equal(extraction.header.supplierName, '吉林省润强药业有限公司')
  assert.equal(extraction.readyForAutofill, true)
  assert.equal(extraction.items.length, 7)
  assert.deepEqual(extraction.items.map((item) => item.arrivalQuantity), [2000, 220, 3200, 180, 8400, 1440, 2000])
  assert.equal(extraction.header.carrierName, null)
  assert.equal(extraction.header.transportMethod, null)
  assert.equal(extraction.header.surfaceTemperature, null)
  assert.equal(extraction.header.departurePlace, null)
  assert.deepEqual(extraction.fieldEvidence['header.supplierName'].sourcePages, [1])
})

test('OCR missing the receipt letterhead must not bypass supplier validation using product manufacturers', () => {
  const submission: GoodsReceiptSubmission = {
    header: { ...receiptFixture.erpPayload.header, supplierName: null, receiptRemark: null },
    items: receiptFixture.erpPayload.items.map((item) => ({ ...item, sourcePages: [1] })),
    evidence: [],
    reviewRequired: []
  }

  const extraction = normalizeGoodsReceiptSubmission(submission, 1)

  assert.equal(extraction.header.supplierName, null)
  assert.equal(extraction.readyForAutofill, false)
  assert.ok(extraction.missingRecommendedFields.includes('供应商名称'))
})

test('incomplete but nonempty receipt OCR requests a bounded header recovery', () => {
  const completeHeader = '吉林省润强药业有限公司\n随货同行(票)单\n单据编号：CKFH26070523\n购货单位\n吉林柏锦医药有限公司\n发货日期\n2026年7月21日'
  const table = '\n货位\n生产厂商\n通药制药集团股份有限公司\n安神补心丸'
  assert.equal(needsGoodsReceiptHeaderOcr(completeHeader + table), false)
  assert.equal(needsGoodsReceiptHeaderOcr('收货地址\n发货日期\n2026年7月21日' + table), true)
  assert.equal(needsGoodsReceiptHeaderOcr(completeHeader.replace('单据编号：CKFH26070523', '') + table), true)
  assert.equal(needsGoodsReceiptHeaderOcr(completeHeader.replace('发货日期\n2026年7月21日', '') + table), true)
})

test('PDF receipt pages retain all printed rows and original page order when OCR finishes out of order', () => {
  const pageExtraction = (page: number) => normalizeGoodsReceiptSubmission({
    header: receiptFixture.erpPayload.header,
    items: receiptFixture.erpPayload.items.map((item) => ({ ...item, sourcePages: [page] })),
    evidence: [{ fieldPath: 'items[0].arrivalQuantity', sourcePages: [page], confidence: 0.99, reviewRequired: false }],
    reviewRequired: []
  }, 3)
  // Page 2 is excluded. Pages 3 and 1 contain repeated products and batch numbers.
  const merged = mergeGoodsReceiptExtractions(pageExtraction(3), pageExtraction(1), 3)
  assert.equal(merged.items.length, 14)
  assert.deepEqual(merged.items.map((item) => item.sourcePages[0]), [
    1, 1, 1, 1, 1, 1, 1, 3, 3, 3, 3, 3, 3, 3
  ])
  assert.deepEqual(merged.items.slice(0, 7).map((item) => item.arrivalQuantity), [2000, 220, 3200, 180, 8400, 1440, 2000])
  assert.deepEqual(merged.fieldEvidence['items[0].arrivalQuantity'].sourcePages, [1])
  assert.deepEqual(merged.fieldEvidence['items[7].arrivalQuantity'].sourcePages, [3])
})
