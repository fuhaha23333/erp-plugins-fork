import assert from 'node:assert/strict'
import test from 'node:test'
import { assessProductRecovery, mergeRecoveredProducts, PRODUCT_RECOVERY_FIELDS } from '../src/main/businesses/purchase-order-recovery'
import type { PurchaseOrderSubmission } from '../src/main/businesses/purchase-order-tool'
import {
  calculatePurchaseOrderCoverage,
  mergePurchaseOrderExtractions,
  normalizePurchaseOrderSubmission,
  needsPurchaseOrderHeaderOcr,
  needsPurchaseOrderDetailOcr
} from '../src/main/businesses/purchase-order-tool'

test('purchase header recovery checks the letterhead rather than a table manufacturer', () => {
  assert.equal(needsPurchaseOrderHeaderOcr('吉林省信茂药业有限公司销售出库单\n票号：202610100039 发货日期：2026-10-10\n收货单位：买方公司\n通用名称 数量'), false)
  assert.equal(needsPurchaseOrderHeaderOcr('吉林柏锦医药有限公司随货同行单\n发货日期：2026-09-02 XS112659\n通用名称 数量'), false)
  assert.equal(needsPurchaseOrderHeaderOcr('通用名称 数量 生产厂商\n商品 300 通化金汇药业股份有限公司'), true)
  assert.equal(needsPurchaseOrderHeaderOcr('收货单位：买方公司\n票号：123456 发货日期：2026-10-10\n商品名称 数量'), true)
})

test('detail recovery detects missing dates, truncated approval, ambiguous text and unbalanced money', () => {
  const table = '|通用名称|规格|生产企业|批准文号|批号|数量|单价|金额|生产日期|有效期|\n|---|---|---|---|---|---|---|---|---|---|\n|示例片|12片|合成厂家|国药准字Z20026368|250304|300|5.00|1500.00|2025-03-21|2028-03-20|'
  assert.equal(needsPurchaseOrderDetailOcr(table, 2161), false)
  assert.equal(needsPurchaseOrderDetailOcr(table, 872), true)
  assert.equal(needsPurchaseOrderDetailOcr(table.replace('2028-03-20', ''), 2161), true)
  assert.equal(needsPurchaseOrderDetailOcr(table.replace('Z20026368', 'Z200263'), 2161), true)
  assert.equal(needsPurchaseOrderDetailOcr(table.replace('示例片', '?片'), 2161), true)
  assert.equal(needsPurchaseOrderDetailOcr(table.replace('1500.00', '150.00'), 2161), true)
  assert.equal(needsPurchaseOrderDetailOcr('没有完整表格', 2161), true)
})

function submission(
  quantities: number[],
  pageNumber = 1
): PurchaseOrderSubmission {
  const batches = ['251103', '251202', '251203', '251203']
  const productionDates = ['2025-11-08', '2025-12-05', '2025-12-05', '2025-12-05']
  const expiryDates = ['2027-10-31', '2027-11-30', '2027-11-30', '2027-11-30']
  return {
    header: {
      supplierName: '江西康强医药有限公司',
      sourceOrderNumber: 'SCKGAK000007111',
      invoiceDate: '2026-08-11',
      departureDate: '2026-08-11',
      customerName: '吉林柏锦医药有限公司',
      receivingAddress: null,
      carrierName: '江西仁济医药有限公司',
      transportMethod: null,
      coldChain: null,
      transportTimeLimit: null,
      receiptRemark: null,
      remark: null,
      paymentMethod: null,
      groupName: null
    },
    items: quantities.map((quantity, index) => ({
      productName: '健胃消食片',
      specification: '0.8g*8片*4板/盒',
      dosageForm: '片剂',
      manufacturer: '修正药业集团股份有限公司',
      origin: '通化市修正路36号',
      approvalNumber: '国药准字Z20063187',
      marketingAuthorizationHolder: '修正药业集团股份有限公司',
      unit: '盒',
      packageQuantity: 300,
      batchNumber: batches[index] ?? `batch-${index}`,
      quantity,
      taxIncludedUnitPrice: 4.221,
      taxIncludedAmount: quantity * 4.221,
      productionDate: productionDates[index] ?? '2025-12-05',
      expiryDate: expiryDates[index] ?? '2027-11-30',
      qualityStatus: '合格',
      sourcePages: [pageNumber]
    })),
    evidence: [],
    reviewRequired: []
  }
}

test('preserves every printed purchase row even when products and prices are identical', () => {
  const extraction = normalizePurchaseOrderSubmission(
    submission([17100, 120, 180, 12600]),
    1
  )

  assert.equal(extraction.header.supplierName, '江西康强医药有限公司')
  assert.equal(extraction.header.customerName, '吉林柏锦医药有限公司')
  assert.equal(extraction.items.length, 4)
  assert.deepEqual(extraction.items.map((item) => item.quantity), [17100, 120, 180, 12600])
  assert.deepEqual(extraction.items.map((item) => item.taxIncludedAmount), [
    72179.1,
    506.52,
    759.78,
    53184.6
  ])
  assert.deepEqual(extraction.items.map((item) => item.batchNumber), [
    '251103',
    '251202',
    '251203',
    '251203'
  ])
  assert.ok(extraction.items.every((item) => item.taxIncludedUnitPrice === 4.221))
  assert.equal(
    extraction.items.reduce((total, item) => total + (item.quantity ?? 0), 0),
    30000
  )
  assert.equal(extraction.readyForAutofill, true)
  assert.ok(extraction.reviewRequired.some((item) => item.includes('付款方式')))
  assert.equal(calculatePurchaseOrderCoverage(extraction), 86)
})

test('appends identical products across OCR pages without aggregation', () => {
  const first = normalizePurchaseOrderSubmission(submission([100], 1), 2)
  const second = normalizePurchaseOrderSubmission(submission([200], 2), 2)
  const merged = mergePurchaseOrderExtractions(first, second)

  assert.equal(merged.items.length, 2)
  assert.deepEqual(merged.items.map((item) => item.quantity), [100, 200])
  assert.deepEqual(merged.items.map((item) => item.taxIncludedAmount), [422.1, 844.2])
  assert.deepEqual(merged.items.map((item) => item.sourcePages), [[1], [2]])
})

test('product recovery uses the overall missing ratio, including exactly 50%, independent of headers', () => {
  const extraction = normalizePurchaseOrderSubmission(submission([100, 200]), 1)
  for (const key of PRODUCT_RECOVERY_FIELDS.slice(1)) Object.assign(extraction.items[0], { [key]: null })
  assert.deepEqual(assessProductRecovery(extraction), { required: false, totalFields: 20, missingCount: 9, missingRatio: 0.45 })
  extraction.items[1].specification = null
  assert.deepEqual(assessProductRecovery(extraction), { required: true, totalFields: 20, missingCount: 10, missingRatio: 0.5 })
  extraction.header.supplierName = null
  assert.equal(assessProductRecovery(extraction).missingRatio, 0.5)
  extraction.items = []
  assert.equal(assessProductRecovery(extraction).required, true)
})

test('recovery supplements all missing fields and preserves existing values, header and row count', () => {
  const original = normalizePurchaseOrderSubmission(submission([100, 200]), 1)
  const recovered = structuredClone(original)
  for (const key of PRODUCT_RECOVERY_FIELDS.slice(1)) Object.assign(original.items[0], { [key]: null })
  original.items[1].specification = null
  recovered.header.supplierName = '不得覆盖原供应商'
  const merged = mergeRecoveredProducts(original, recovered, 1)
  assert.equal(merged.filledFields, 10)
  assert.equal(merged.extraction.header.supplierName, original.header.supplierName)
  assert.equal(merged.extraction.items.length, 2)
  assert.deepEqual(merged.extraction.items, recovered.items)
  assert.equal(assessProductRecovery(merged.extraction).required, false)
})

test('recovery rejects ambiguous row changes and preserves the first result when retry is worse', () => {
  const original = normalizePurchaseOrderSubmission(submission([100, 200]), 1)
  const recovered = structuredClone(original)
  original.items[0].specification = null
  recovered.items.reverse()
  assert.equal(mergeRecoveredProducts(original, recovered, 1).extraction, original)
  recovered.items.pop()
  assert.equal(mergeRecoveredProducts(original, recovered, 1).extraction, original)
  assert.equal(mergeRecoveredProducts(original, structuredClone(original), 1).extraction, original)
  const empty = structuredClone(original)
  empty.items = []
  assert.equal(mergeRecoveredProducts(empty, original, 1).extraction.items.length, 2)
})
