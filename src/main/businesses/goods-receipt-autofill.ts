import goodsReceiptFixture from '../../../test-data/goods-receipt.ckfh26070523.json'
import type {
  GoodsReceiptExtraction,
  GoodsReceiptHeader,
  GoodsReceiptItem
} from '../../shared/business'

interface GridCell {
  setValue: (value: string, eventTrigger?: boolean) => void
  getValue?: () => unknown
  getElement?: () => HTMLElement | null
  value?: unknown
}

interface GridRow {
  cells: () => Record<string, GridCell | undefined>
}

interface GridController {
  getRows: () => GridRow[]
}

interface GoodsReceiptPageWindow extends Window {
  gridEditBody?: GridController
  gridhandler?: (operation: string, gridBit: string) => void
  afterGridEdit?: (event: Record<string, unknown>) => void
  bodyczing?: boolean
}

interface PageAutofillResult {
  filledHeaderFields: number
  filledDetailRows: number
  skippedFields: string[]
}

interface GoodsReceiptAutofillPayload {
  supplierName: string | null
  header: Record<string, string>
  items: GoodsReceiptItem[]
  populateBlankRows: boolean
}

function buildGoodsReceiptPayload(
  header: GoodsReceiptHeader,
  items: GoodsReceiptItem[],
  populateBlankRows = false
): GoodsReceiptAutofillPayload {
  const candidates: Record<string, string | number | null> = {
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
    supplierName: header.supplierName,
    header: Object.fromEntries(
      Object.entries(candidates)
        .filter((entry): entry is [string, string | number] => entry[1] !== null && entry[1] !== '')
        .map(([key, value]) => [key, String(value)])
    ),
    items,
    populateBlankRows
  }
}

function buildGoodsReceiptFixturePayload(): GoodsReceiptAutofillPayload {
  const fixturePayload = goodsReceiptFixture.erpPayload
  return buildGoodsReceiptPayload(
    fixturePayload.header as GoodsReceiptHeader,
    fixturePayload.items.map((item) => ({ ...item, sourcePages: [1] })) as GoodsReceiptItem[],
    true
  )
}

async function runGoodsReceiptAutofill(
  payload: GoodsReceiptAutofillPayload
): Promise<PageAutofillResult> {
  const pageWindow = window as GoodsReceiptPageWindow
  const skippedFields: string[] = []
  let filledHeaderFields = 0
  let supplierResolved = payload.supplierName === null

  const setElementValue = (fieldId: string, value: string): boolean => {
    const element = document.getElementById(fieldId)
    if (!(element instanceof HTMLInputElement || element instanceof HTMLSelectElement || element instanceof HTMLTextAreaElement)) {
      skippedFields.push(fieldId)
      return false
    }
    if (element.disabled || (!(element instanceof HTMLSelectElement) && element.readOnly)) {
      skippedFields.push(`${fieldId}（只读或已禁用）`)
      return false
    }
    element.value = value
    element.dispatchEvent(new Event('input', { bubbles: true }))
    element.dispatchEvent(new Event('change', { bubbles: true }))
    element.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: 'Unidentified' }))
    return true
  }

  for (const [fieldId, value] of Object.entries(payload.header)) {
    if (setElementValue(fieldId, value)) filledHeaderFields += 1
  }

  if (payload.supplierName) {
    if (payload.populateBlankRows) {
      if (setElementValue('DWMC', payload.supplierName)) {
        filledHeaderFields += 1
        supplierResolved = true
      }
    } else {
      const supplierElement = document.getElementById('DWMC')
      const supplierCodeElement = document.getElementById('DWBH')
      const currentSupplier = supplierElement instanceof HTMLInputElement
        ? supplierElement.value.trim()
        : ''
      const supplierCode = supplierCodeElement instanceof HTMLInputElement
        ? supplierCodeElement.value.trim()
        : ''
      supplierResolved = currentSupplier === payload.supplierName.trim() && supplierCode !== ''
      if (!supplierResolved) {
        skippedFields.push(`单位名称（请通过 ERP 参照选择“${payload.supplierName}”）`)
      }
    }
  }

  const grid = pageWindow.gridEditBody
  if (!grid) {
    skippedFields.push('商品明细表（ERP网格尚未就绪）')
    return { filledHeaderFields, filledDetailRows: 0, skippedFields }
  }
  if (!supplierResolved) {
    skippedFields.push('商品明细（供应商尚未通过 ERP 参照匹配）')
    return { filledHeaderFields, filledDetailRows: 0, skippedFields }
  }

  const normalize = (value: unknown): string => String(value ?? '').replace(/\s+/g, '').trim()
  const cellValue = (cell: GridCell | undefined): unknown => {
    if (!cell) return ''
    if (typeof cell.getValue === 'function') return cell.getValue()
    return cell.value ?? ''
  }
  const wait = (milliseconds: number): Promise<void> =>
    new Promise((resolve) => window.setTimeout(resolve, milliseconds))
  const waitUntil = async (
    predicate: () => boolean,
    timeoutMilliseconds = 15000
  ): Promise<boolean> => {
    const deadline = Date.now() + timeoutMilliseconds
    while (Date.now() < deadline) {
      if (predicate()) return true
      await wait(100)
    }
    return predicate()
  }
  const waitForRowCount = async (expectedCount: number): Promise<boolean> => {
    const deadline = Date.now() + 10000
    while (Date.now() < deadline) {
      if ((pageWindow.gridEditBody?.getRows().length ?? 0) >= expectedCount) return true
      await wait(100)
    }
    return false
  }
  const triggerCellEdit = async (
    rowIndex: number,
    fieldName: string,
    value: string
  ): Promise<boolean> => {
    const row = pageWindow.gridEditBody?.getRows()[rowIndex]
    const cell = row?.cells()[fieldName]
    if (!cell) return false
    const oldValue = cellValue(cell)
    cell.setValue(value, false)
    if (typeof pageWindow.afterGridEdit !== 'function' || typeof cell.getElement !== 'function') {
      return true
    }
    try {
      pageWindow.afterGridEdit({
        type: 'cellChgdExitFunc',
        cell,
        td: cell.getElement(),
        dataIndex: fieldName,
        oldValue,
        newValue: value,
        rowIndex
      })
    } catch {
      return false
    }
    return waitUntil(() => pageWindow.bodyczing !== true)
  }

  if (payload.populateBlankRows) {
    const addGridRow = pageWindow.gridhandler
    if (!addGridRow && grid.getRows().length < payload.items.length) {
      skippedFields.push('商品明细表（无法新增测试行）')
    } else {
      while (grid.getRows().length < payload.items.length && addGridRow) {
        const expectedCount = grid.getRows().length + 1
        addGridRow.call(pageWindow, 'add', 'B')
        if (!(await waitForRowCount(expectedCount))) {
          skippedFields.push(`商品明细第${expectedCount}行（新增超时）`)
          break
        }
      }
    }
  }

  const rows = grid.getRows()
  const usedRows = new Set<GridRow>()
  let filledDetailRows = 0

  for (let itemIndex = 0; itemIndex < payload.items.length; itemIndex += 1) {
    const item = payload.items[itemIndex]
    const matchingRows = rows.filter((candidate) => {
      if (usedRows.has(candidate)) return false
      const cells = candidate.cells()
      if (normalize(cellValue(cells.SPMC)) !== normalize(item.productName)) return false
      const evidence: Array<[string | null, GridCell | undefined]> = [
        [item.specification, cells.GG],
        [item.manufacturer, cells.SCCS],
        [item.batchNumber, cells.SPPH]
      ]
      return evidence.every(([expected, cell]) => {
        const expectedValue = normalize(expected)
        const actualValue = normalize(cellValue(cell))
        return !expectedValue || !actualValue ||
          actualValue.includes(expectedValue) || expectedValue.includes(actualValue)
      })
    })
    let row = matchingRows.length === 1 ? matchingRows[0] : undefined
    if (!row && payload.populateBlankRows) {
      row = rows.find((candidate) => {
        if (usedRows.has(candidate)) return false
        return normalize(cellValue(candidate.cells().SPMC)) === ''
      }) ?? rows.find((candidate) => !usedRows.has(candidate))
    }
    if (!row) {
      const reason = matchingRows.length > 1
        ? '存在多个相同的 ERP 采购订单行，无法唯一匹配'
        : '请先在 ERP 中选择对应采购订单商品'
      skippedFields.push(`商品“${item.productName}”（${reason}）`)
      continue
    }
    usedRows.add(row)

    const cells = row.cells()
    let changed = false
    const values: Record<string, string | null> = payload.populateBlankRows
      ? {
          SPMC: item.productName,
          GG: item.specification,
          SCCS: item.manufacturer,
          DW: item.unit,
          DJ: item.unitPrice === null ? null : String(item.unitPrice),
          DDSL: item.packageQuantity === null ? null : String(item.packageQuantity),
          DHSL: item.arrivalQuantity === null ? null : String(item.arrivalQuantity),
          SHSL: item.receiptQuantity === null ? null : String(item.receiptQuantity),
          JSSL: '0',
          SPPH: item.batchNumber,
          SCRQ: item.productionDate,
          YXQZ: item.expiryDate,
          SPM: item.productName,
          JX: item.dosageForm,
          BZ: item.remark
        }
      : {
          DHSL: item.arrivalQuantity === null ? null : String(item.arrivalQuantity),
          SHSL: item.receiptQuantity === null ? null : String(item.receiptQuantity),
          BZ: item.remark
        }
    const criticalFields = new Set(payload.populateBlankRows ? ['SPMC', 'DHSL', 'SHSL'] : ['DHSL', 'SHSL'])
    for (const [fieldName, value] of Object.entries(values)) {
      if (value === null || value === '') continue
      const cell = cells[fieldName]
      if (!cell) {
        if (criticalFields.has(fieldName)) {
          skippedFields.push(`商品“${item.productName}”.${fieldName}`)
        }
        continue
      }
      const rowIndex = rows.indexOf(row)
      const filled = payload.populateBlankRows || (fieldName !== 'DHSL' && fieldName !== 'SHSL')
        ? (cell.setValue(value), true)
        : await triggerCellEdit(rowIndex, fieldName, value)
      if (!filled) skippedFields.push(`商品“${item.productName}”.${fieldName}`)
      if (criticalFields.has(fieldName) && filled) changed = true
    }
    if (
      !payload.populateBlankRows &&
      item.arrivalQuantity !== null &&
      item.receiptQuantity !== null &&
      cells.JSSL
    ) {
      const rejectQuantityText = normalize(cellValue(cells.JSSL))
      const rejectQuantity = Number(rejectQuantityText)
      const expectedRejectQuantity = item.arrivalQuantity - item.receiptQuantity
      if (
        rejectQuantityText === '' ||
        !Number.isFinite(rejectQuantity) ||
        Math.abs(rejectQuantity - expectedRejectQuantity) > 0.0001
      ) {
        skippedFields.push(
          `商品“${item.productName}”（ERP 拒收数量未按到货数量减收货数量更新）`
        )
      }
    }
    if (changed) filledDetailRows += 1
  }

  return { filledHeaderFields, filledDetailRows, skippedFields }
}

export function buildGoodsReceiptFixtureAutofillScript(): string {
  return `(${runGoodsReceiptAutofill.toString()})(${JSON.stringify(buildGoodsReceiptFixturePayload())})`
}

export function buildGoodsReceiptExtractedAutofillScript(
  extraction: GoodsReceiptExtraction
): string {
  const payload = buildGoodsReceiptPayload(extraction.header, extraction.items)
  return `(${runGoodsReceiptAutofill.toString()})(${JSON.stringify(payload)})`
}
