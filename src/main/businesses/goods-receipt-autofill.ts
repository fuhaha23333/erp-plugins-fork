import goodsReceiptFixture from '../../../test-data/goods-receipt.ckfh26070523.json'
import type { GoodsReceiptExtraction, GoodsReceiptHeader, GoodsReceiptItem } from '../../shared/business'

interface GridCell {
  setValue: (value: string, eventTrigger?: boolean) => void
  getValue?: () => unknown
  value?: unknown
}
interface GridRow { cells: () => Record<string, GridCell | undefined> }
interface GoodsReceiptPageWindow extends Window {
  gridEditBody?: { getRows: () => GridRow[] }
  gridhandler?: (operation: string, gridBit: string) => void
}
interface PageAutofillResult {
  filledHeaderFields: number
  filledDetailRows: number
  skippedFields: string[]
}
interface GoodsReceiptAutofillPayload {
  header: Record<string, string>
  items: GoodsReceiptItem[]
}

function buildGoodsReceiptPayload(header: GoodsReceiptHeader, items: GoodsReceiptItem[]): GoodsReceiptAutofillPayload {
  const candidates: Record<string, string | number | null> = {
    DWMC: header.supplierName,
    QYRQ: header.departureDate,
    CYDW: header.carrierName,
    CYFS: header.transportMethod,
    SHRQ1: header.receiptDateTime,
    WBWD: header.surfaceTemperature,
    YSFS: header.transportVehicle,
    qydd: header.departurePlace,
    QYRS: header.departureDateTime,
    SHSJ: header.receiptDateTimeDetail,
    SJYSSJ: header.actualTransportHours,
    SHDJBZ: header.receiptRemark
  }
  return {
    header: Object.fromEntries(Object.entries(candidates)
      .filter((entry): entry is [string, string | number] => entry[1] !== null && entry[1] !== '')
      .map(([key, value]) => [key, String(value)])),
    items
  }
}

// Both OCR and the working fixture use this same grid insertion/assignment path.
// Serialized into the ERP frame: keep all runtime dependencies inside it.
async function runGoodsReceiptAutofill(payload: GoodsReceiptAutofillPayload): Promise<PageAutofillResult> {
  const page = window as GoodsReceiptPageWindow
  const result: PageAutofillResult = { filledHeaderFields: 0, filledDetailRows: 0, skippedFields: [] }
  const normalize = (value: unknown): string => String(value ?? '').replace(/\s+/g, '')
  const cellValue = (cell: GridCell | undefined): unknown => cell?.getValue?.() ?? cell?.value ?? ''
  const rows = (): GridRow[] => page.gridEditBody?.getRows() ?? []
  const supplier = document.getElementById('DWMC')
  const supplierCode = document.getElementById('DWBH')
  if (supplier instanceof HTMLInputElement && supplierCode instanceof HTMLInputElement &&
    supplierCode.value.trim() && payload.header.DWMC && normalize(supplier.value) !== normalize(payload.header.DWMC)) {
    result.skippedFields.push('单位名称（当前单据已关联其他供应商，请在新的空白单据中代填）')
    return result
  }
  for (const [id, value] of Object.entries(payload.header)) {
    const element = document.getElementById(id)
    if (!(element instanceof HTMLInputElement || element instanceof HTMLSelectElement || element instanceof HTMLTextAreaElement)) {
      result.skippedFields.push(id)
      continue
    }
    if (element.value === value) { result.filledHeaderFields += 1; continue }
    if (element.disabled || (!(element instanceof HTMLSelectElement) && element.readOnly)) {
      result.skippedFields.push(`${id}（只读或已禁用）`)
      continue
    }
    element.value = value
    element.dispatchEvent(new Event('input', { bubbles: true }))
    element.dispatchEvent(new Event('change', { bubbles: true }))
    element.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: 'Unidentified' }))
    if (element.value === value) result.filledHeaderFields += 1
    else result.skippedFields.push(`${id}（写入后核验失败）`)
  }
  if (!page.gridEditBody) {
    result.skippedFields.push('商品明细表（ERP 网格尚未就绪）')
    return result
  }

  const matchesItem = (row: GridRow, item: GoodsReceiptItem): boolean => {
    const cells = row.cells()
    if (normalize(cellValue(cells.SPMC)) !== normalize(item.productName)) return false
    return ([['GG', item.specification], ['SCCS', item.manufacturer], ['SPPH', item.batchNumber]] as const)
      .every(([field, expected]) => {
        const actual = normalize(cellValue(cells[field]))
        const wanted = normalize(expected)
        return !actual || !wanted || actual === wanted ||
          (field === 'GG' && (actual.includes(wanted) || wanted.includes(actual)))
      })
  }
  const blankRow = (row: GridRow): boolean =>
    ['SPMC', 'SPBH', 'GG', 'SCCS', 'SPPH'].every(field => !normalize(cellValue(row.cells()[field])))

  // Allocate all rows before filling, as in the working fixture. Adding a row
  // can refresh the entire grid, so retain indexes rather than row objects.
  const used = new Set<number>()
  const assignments: number[] = []
  for (const item of payload.items) {
    let current = rows()
    let index = current.findIndex((row, i) => !used.has(i) && matchesItem(row, item))
    if (index < 0) index = current.findIndex((row, i) => !used.has(i) && blankRow(row))
    if (index < 0 && page.gridhandler) {
      const expectedCount = current.length + 1
      try {
        page.gridhandler('add', 'B')
        const deadline = Date.now() + 10000
        while (rows().length < expectedCount && Date.now() < deadline) {
          await new Promise(resolve => page.setTimeout(resolve, 100))
        }
        current = rows()
        if (current.length >= expectedCount) index = current.findIndex((row, i) => !used.has(i) && blankRow(row))
      } catch { /* Report this item without overwriting another product row. */ }
      if (index < 0) {
        result.skippedFields.push(`商品“${item.productName}”（新增行失败或超时，请重试）`)
        // Do not start another add while a timed-out ERP request may still be pending.
        break
      }
    }
    assignments.push(index)
    if (index >= 0) used.add(index)
  }

  const numericFields = new Set(['DJ', 'DHSL', 'SHSL', 'JSSL'])
  for (let i = 0; i < payload.items.length; i += 1) {
    const item = payload.items[i]
    const index = assignments[i] ?? -1
    if (index < 0 || !rows()[index]) {
      result.skippedFields.push(`商品“${item.productName}”（无可用明细行）`)
      continue
    }
    // Never invent internal product/order IDs. Preserve ERP-linked master data.
    const linked = Boolean(normalize(cellValue(rows()[index].cells().SPBH)))
    const values: Record<string, string | number | null> = {
      ...(linked ? {} : {
        SPMC: item.productName, GG: item.specification, SCCS: item.manufacturer,
        DW: item.unit, DJ: item.unitPrice, SPPH: item.batchNumber,
        SCRQ: item.productionDate, YXQZ: item.expiryDate, SPM: item.productName,
        JX: item.dosageForm
      }),
      DHSL: item.arrivalQuantity,
      SHSL: item.receiptQuantity,
      JSSL: item.arrivalQuantity !== null && item.receiptQuantity !== null
        ? item.arrivalQuantity - item.receiptQuantity : null,
      BZ: item.remark
    }
    let complete = true
    let wroteProduct = false
    for (const [field, value] of Object.entries(values)) {
      if (value === null || value === '') continue
      const cell = rows()[index]?.cells()[field]
      if (!cell) {
        if (['SPMC', 'DHSL', 'SHSL'].includes(field)) {
          complete = false
          result.skippedFields.push(`商品“${item.productName}”.${field}（字段不存在）`)
        }
        continue
      }
      try {
        cell.setValue(String(value))
        const actual = cellValue(rows()[index]?.cells()[field])
        const matches = numericFields.has(field)
          ? String(actual).trim() !== '' && Math.abs(Number(actual) - Number(value)) < 0.0001
          : String(actual) === String(value)
        if (!matches) throw new Error('readback mismatch')
        if (['SPMC', 'DHSL', 'SHSL'].includes(field)) wroteProduct = true
      } catch {
        complete = false
        result.skippedFields.push(`商品“${item.productName}”.${field}（写入后核验失败）`)
      }
    }
    if (complete && wroteProduct) result.filledDetailRows += 1
  }
  return result
}

function buildAutofillScript(header: GoodsReceiptHeader, items: GoodsReceiptItem[]): string {
  return `(${runGoodsReceiptAutofill.toString()})(${JSON.stringify(buildGoodsReceiptPayload(header, items))})`
}

export function buildGoodsReceiptFixtureAutofillScript(): string {
  return buildAutofillScript(goodsReceiptFixture.erpPayload.header,
    goodsReceiptFixture.erpPayload.items.map(item => ({ ...item, sourcePages: [1] })))
}

export function buildGoodsReceiptExtractedAutofillScript(extraction: GoodsReceiptExtraction): string {
  return buildAutofillScript(extraction.header, extraction.items)
}
