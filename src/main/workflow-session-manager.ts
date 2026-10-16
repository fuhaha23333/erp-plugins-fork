import type { BusinessExtraction, BusinessId } from '../shared/business'

export interface PendingDocumentSelection {
  sessionId: string
  businessId: BusinessId
  token: string
  filePath: string
  pageCount: number
}

interface CompletedWorkflowSession {
  businessId: BusinessId
  extraction: BusinessExtraction
}

export class WorkflowSessionManager {
  private readonly pageBindings = new Map<string, { businessId: BusinessId; pageId: string }>()
  private readonly pendingSelections = new Map<string, PendingDocumentSelection>()
  private readonly completedSessions = new Map<string, CompletedWorkflowSession>()

  bindToPage(sessionId: string, businessId: BusinessId, pageId: string): void {
    if (this.pageBindings.has(sessionId)) throw new Error('会话已绑定单据页，请创建新会话')
    this.pageBindings.set(sessionId, { businessId, pageId })
  }

  getPageId(sessionId: string, businessId: BusinessId): string {
    const binding = this.pageBindings.get(sessionId)
    if (!binding) throw new Error('单据页已关闭或会话已失效，请重新识别')
    if (binding.businessId !== businessId) throw new Error('会话属于其他业务')
    return binding.pageId
  }

  retainOpenPages(pageIds: string[]): void {
    const open = new Set(pageIds)
    for (const [sessionId, binding] of this.pageBindings) {
      if (!open.has(binding.pageId)) this.discard(sessionId)
    }
  }

  discard(sessionId: string): void {
    this.pageBindings.delete(sessionId)
    this.pendingSelections.delete(sessionId)
    this.completedSessions.delete(sessionId)
  }

  setPending(selection: PendingDocumentSelection): void {
    this.getPageId(selection.sessionId, selection.businessId)
    this.pendingSelections.set(selection.sessionId, selection)
    this.completedSessions.delete(selection.sessionId)
  }

  takePending(
    sessionId: string,
    businessId: BusinessId,
    token: string
  ): PendingDocumentSelection {
    const selection = this.pendingSelections.get(sessionId)
    if (!selection || selection.token !== token) {
      throw new Error('文件选择已失效，请重新选择票据')
    }
    if (selection.businessId !== businessId) {
      throw new Error('当前票据属于其他业务，已拒绝跨业务识别')
    }
    this.pendingSelections.delete(sessionId)
    return selection
  }

  cancel(sessionId: string, token?: string): void {
    const selection = this.pendingSelections.get(sessionId)
    if (!selection || (token && selection.token !== token)) return
    this.pendingSelections.delete(sessionId)
  }

  complete(
    sessionId: string,
    businessId: BusinessId,
    extraction: BusinessExtraction
  ): void {
    if (extraction.documentType !== businessId) {
      throw new Error('识别结果与业务类型不一致，已拒绝保存到会话')
    }
    this.getPageId(sessionId, businessId)
    this.completedSessions.set(sessionId, { businessId, extraction })
  }

  getExtraction(sessionId: string, businessId: BusinessId): BusinessExtraction {
    const session = this.completedSessions.get(sessionId)
    if (!session) throw new Error('识别会话不存在或已失效')
    if (session.businessId !== businessId || session.extraction.documentType !== businessId) {
      throw new Error('识别结果属于其他业务，已拒绝跨业务代填')
    }
    return session.extraction
  }

  clear(): void {
    this.pageBindings.clear()
    this.pendingSelections.clear()
    this.completedSessions.clear()
  }
}
