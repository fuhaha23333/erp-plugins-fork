import type { ErpAutofillResult } from '../shared/erp'

export function normalizeAutofillResult(value: unknown, expectedDetailRows = 0): ErpAutofillResult {
  const result = value as Partial<ErpAutofillResult> | null
  if (!result || !Number.isSafeInteger(result.filledHeaderFields) || result.filledHeaderFields! < 0 ||
    !Number.isSafeInteger(result.filledDetailRows) || result.filledDetailRows! < 0 ||
    !Array.isArray(result.skippedFields)) {
    return { status: 'failed', message: 'ERP 页面没有返回有效的代填结果', filledHeaderFields: 0, filledDetailRows: 0, skippedFields: [] }
  }
  const filledHeaderFields = result.filledHeaderFields!
  const filledDetailRows = result.filledDetailRows!
  const skippedFields = result.skippedFields.filter((field): field is string => typeof field === 'string')
  if (filledDetailRows < expectedDetailRows) {
    skippedFields.unshift(`商品或资质明细仅完成 ${filledDetailRows}/${expectedDetailRows} 条`)
  }
  const changed = filledHeaderFields > 0 || filledDetailRows > 0
  const status = !changed ? 'failed' : skippedFields.length ? 'partial' : 'filled'
  const summary = `已填入 ${filledHeaderFields} 个基本字段和 ${filledDetailRows} 条明细`
  return {
    status, filledHeaderFields, filledDetailRows, skippedFields,
    message: status === 'filled'
      ? `${summary}；请核对后手动保存`
      : `${summary}；代填未完成，请处理未填项目后重试`
  }
}
