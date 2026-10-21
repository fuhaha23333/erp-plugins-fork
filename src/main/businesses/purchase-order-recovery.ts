import type { PurchaseOrderExtraction, PurchaseOrderItem } from '../../shared/business'
import { normalizePurchaseOrderSubmission } from './purchase-order-tool'

// Fixed denominator: optional transport/payment/header fields never affect this trigger.
export const PRODUCT_RECOVERY_FIELDS = [
  'productName', 'specification', 'manufacturer', 'approvalNumber', 'unit',
  'quantity', 'taxIncludedUnitPrice', 'batchNumber', 'productionDate', 'expiryDate'
] as const satisfies readonly (keyof PurchaseOrderItem)[]

export function usableProductValue(value: unknown): boolean {
  if (typeof value === 'number') return Number.isFinite(value) && value > 0
  return typeof value === 'string' && Boolean(value.trim()) &&
    !/[?？]/.test(value) && !/^(?:[-—/]+|未识别|未知|不详|无法辨认|null|n\/a)$/i.test(value.trim())
}

export function assessProductRecovery(extraction: PurchaseOrderExtraction) {
  const totalFields = extraction.items.length * PRODUCT_RECOVERY_FIELDS.length
  const missingCount = extraction.items.reduce((sum, item) =>
    sum + PRODUCT_RECOVERY_FIELDS.filter(key => !usableProductValue(item[key])).length, 0)
  const missingRatio = totalFields ? missingCount / totalFields : 1
  return {
    required: missingRatio >= 0.5,
    totalFields, missingCount, missingRatio
  }
}

const identityFields = ['productName', 'specification', 'manufacturer', 'approvalNumber', 'batchNumber'] as const
const comparable = (value: unknown) => String(value ?? '').toLowerCase().replace(/[\s*×()（）]/g, '')

/** Recovery is for this same page, never the cross-page append merge. */
export function mergeRecoveredProducts(
  original: PurchaseOrderExtraction, recovered: PurchaseOrderExtraction, pageCount: number
): { extraction: PurchaseOrderExtraction; filledFields: number; warning?: string } {
  if (!recovered.items.length || (original.items.length > 0 && recovered.items.length !== original.items.length)) {
    return { extraction: original, filledFields: 0, warning: '商品行数与首次结果不一致，保留原结果，请人工核对' }
  }
  const evidence = { ...original.fieldEvidence }
  let filledFields = 0
  const conflicts: string[] = []
  const items = original.items.length === 0 ? recovered.items.map((item, index) => {
    filledFields += PRODUCT_RECOVERY_FIELDS.filter(key => usableProductValue(item[key])).length
    for (const [path, value] of Object.entries(recovered.fieldEvidence)) {
      if (path.startsWith(`items[${index}].`)) evidence[path] = value
    }
    return item
  }) : original.items.map((item, index) => {
    const candidate = recovered.items[index]
    const shared = identityFields.filter(key => usableProductValue(item[key]) && usableProductValue(candidate[key]))
    const ambiguous = (original.items.length > 1 && shared.length === 0) ||
      shared.some(key => comparable(item[key]) !== comparable(candidate[key])) ||
      (['quantity', 'taxIncludedUnitPrice'] as const).some(key =>
        usableProductValue(item[key]) && usableProductValue(candidate[key]) && item[key] !== candidate[key])
    if (ambiguous) {
      conflicts.push(`第 ${index + 1} 条商品补识别存在对应关系冲突，保留原结果`)
      return item
    }
    const merged = { ...item }
    for (const key of PRODUCT_RECOVERY_FIELDS) {
      if (!usableProductValue(item[key]) && usableProductValue(candidate[key])) {
        Object.assign(merged, { [key]: candidate[key] })
        const path = `items[${index}].${key}`
        if (recovered.fieldEvidence[path]) evidence[path] = recovered.fieldEvidence[path]
        filledFields++
      }
    }
    // A printed amount may supplement an absent amount; existing values are never replaced.
    if (merged.taxIncludedAmount === null && candidate.taxIncludedAmount !== null) merged.taxIncludedAmount = candidate.taxIncludedAmount
    return merged
  })
  if (!filledFields) return { extraction: original, filledFields: 0, warning: conflicts.join('；') || '补识别未补回关键字段，保留原结果' }
  const extraction = normalizePurchaseOrderSubmission({
    header: original.header, items,
    evidence: Object.entries(evidence).map(([fieldPath, value]) => ({ fieldPath, ...value })),
    reviewRequired: [
      ...original.reviewRequired.filter(message => !/^第 \d+ 条采购商品缺少有效(数量|含税单价)$|^未识别到可用的采购商品明细$/.test(message)),
      ...recovered.reviewRequired.filter(message => /商品|items\[/.test(message)),
      ...conflicts
    ]
  }, pageCount)
  return { extraction, filledFields, warning: conflicts.length ? conflicts.join('；') : undefined }
}
