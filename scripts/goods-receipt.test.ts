import assert from 'node:assert/strict'
import test from 'node:test'
import vm from 'node:vm'
import type { GoodsReceiptExtraction, GoodsReceiptItem } from '../src/shared/business'
import {
  normalizeGoodsReceiptSubmission,
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

class InteractiveCell extends FakeCell {
  getElement(): object {
    return {}
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

test('production autofill does not write quantities before the supplier reference is resolved', async () => {
  const row = createRow({
    SPMC: '安神补心丸',
    SPBH: 'SP001',
    GG: '2g/15丸:200丸/瓶*1瓶/盒*20盒',
    SCCS: '通药制药集团股份有限公司'
  })
  const elements = new Map<string, FakeInput>([
    ['DWMC', new FakeInput()],
    ['DWBH', new FakeInput()],
    ['QYRQ', new FakeInput()],
    ['SHDJBZ', new FakeTextArea()]
  ])
  const context = {
    window: {
      setTimeout,
      gridEditBody: { getRows: () => [row] }
    },
    document: { getElementById: (id: string) => elements.get(id) ?? null },
    HTMLInputElement: FakeInput,
    HTMLSelectElement: FakeSelect,
    HTMLTextAreaElement: FakeTextArea,
    Event: FakeEvent,
    KeyboardEvent: FakeEvent,
    setTimeout
  }

  const result = await vm.runInNewContext(
    buildExtractedAutofillScript(goodsReceiptExtraction([receiptItem()])),
    context
  ) as { skippedFields: string[] }

  assert.equal(row.cells().DHSL.value, '')
  assert.equal(row.cells().SHSL.value, '')
  assert.ok(result.skippedFields.some((field) => field.includes('供应商尚未通过 ERP 参照匹配')))
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

test('production autofill triggers ERP grid formulas after each quantity edit', async () => {
  const cells = Object.fromEntries(
    detailFieldNames.map((field) => [field, new InteractiveCell()])
  ) as Record<string, InteractiveCell>
  cells.SPMC.value = '安神补心丸'
  cells.SPBH.value = 'SP001'
  cells.GG.value = '2g/15丸:200丸/瓶*1瓶/盒*20盒'
  cells.SCCS.value = '通药制药集团股份有限公司'
  cells.SPPH.value = '260401'
  const row = { cells: () => cells }
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
  const editedFields: string[] = []
  const pageWindow = {
    setTimeout,
    bodyczing: false,
    gridEditBody: { getRows: () => [row] },
    afterGridEdit: (event: { dataIndex: string }) => {
      editedFields.push(event.dataIndex)
      if (event.dataIndex === 'DHSL' || event.dataIndex === 'SHSL') {
        cells.JSSL.value = String(Number(cells.DHSL.value) - Number(cells.SHSL.value))
      }
    }
  }
  const context = {
    window: pageWindow,
    document: { getElementById: (id: string) => elements.get(id) ?? null },
    HTMLInputElement: FakeInput,
    HTMLSelectElement: FakeSelect,
    HTMLTextAreaElement: FakeTextArea,
    Event: FakeEvent,
    KeyboardEvent: FakeEvent,
    setTimeout
  }

  const result = await vm.runInNewContext(
    buildExtractedAutofillScript(goodsReceiptExtraction([receiptItem()])),
    context
  ) as { filledDetailRows: number }

  assert.deepEqual(editedFields, ['DHSL', 'SHSL'])
  assert.equal(cells.JSSL.value, '0')
  assert.equal(result.filledDetailRows, 1)
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

test('production autofill reports a stale reject quantity after ERP grid edits', async () => {
  const cells = Object.fromEntries(
    detailFieldNames.map((field) => [field, new InteractiveCell()])
  ) as Record<string, InteractiveCell>
  cells.SPMC.value = '安神补心丸'
  cells.SPBH.value = 'SP001'
  cells.GG.value = '2g/15丸:200丸/瓶*1瓶/盒*20盒'
  cells.SCCS.value = '通药制药集团股份有限公司'
  cells.SPPH.value = '260401'
  const row = { cells: () => cells }
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
      bodyczing: false,
      gridEditBody: { getRows: () => [row] },
      afterGridEdit: () => {}
    },
    document: { getElementById: (id: string) => elements.get(id) ?? null },
    HTMLInputElement: FakeInput,
    HTMLSelectElement: FakeSelect,
    HTMLTextAreaElement: FakeTextArea,
    Event: FakeEvent,
    KeyboardEvent: FakeEvent,
    setTimeout
  }

  const result = await vm.runInNewContext(
    buildExtractedAutofillScript(goodsReceiptExtraction([
      receiptItem({ arrivalQuantity: 2000, receiptQuantity: 1990 })
    ])),
    context
  ) as { skippedFields: string[] }

  assert.ok(result.skippedFields.some((field) => field.includes('拒收数量未按到货数量减收货数量更新')))
})
