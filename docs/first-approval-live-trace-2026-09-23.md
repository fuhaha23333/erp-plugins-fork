# 首营审批真实识别调用记录（2026-09-23）

本报告来自用户本次手动选择资料、筛选页面并执行识别的真实应用日志，不是合成 benchmark。仅保存页面编号、时间、token、数量和请求开关统计，不保存文件名、OCR 原文、字段值、银行/证件信息或思考正文。没有重新识别或自动执行 ERP 代填/保存。

## 本轮结果

- 文件共 16 页，选择 14 页，排除 2 页。成功处理页为 1～10、13～16；结合页面调度代码可知第 11、12 页未参与识别。
- 识别阶段 wall-clock 为 **161.10 秒**，全部页面已结束（unsettledPages=0），状态 completed，并进入人工复核。
- 日志对应约北京时间 **23:44:44.57～23:47:25.67**。开始时刻由文档结束日志时间减 elapsedMs 推算；这不包含此前的文件选择、缩略图预览和人工筛页时间，也不包含后续人工复核。
- 8 个页面工作槽并发；渲染排队串行执行。每个工作槽完成一页的 OCR、normalizer、normalize/merge 后才领下一页，因此不是只限制 OCR 请求数量。
- 14 个 normalizer 调用均出现一次请求构造记录、一个 assistant 响应、一次 Tool Call、一个 Tool result，toolErrors 均为 0，stopReason 均为 toolUse。
- 14 个请求构造记录均为 `enableThinking: true`、`reasoningEffort: not-sent`、`toolCount: 1`。均返回 thinking block，本次已确认思考实际发生。

## 实际执行链路

1. **本地选文件和预览**：`App.vue` 的 selectDocument → preload IPC → `index.ts` 的 `ocr:select-document`。主进程打开文件选择器，生成 16 页本地缩略图并建立一次性 selection token。此时尚未执行 OCR/normalizer。
2. **点击开始识别**：`App.vue` 的 startExtraction → `ocr:extract-document`。主进程校验首营业务、会话、token 和排除页码，再调用 `PiDocumentClient.extractDocument`。
3. **选择首营 Adapter**：`extraction-registry.ts` 选中 `unit-initial-approval`，使用 `unitInitialApprovalSystemPrompt` 和完整首营 SubmissionSchema/Tool。首营路径没有商品收货业务专用的表头补充 OCR。
4. **逐页渲染及 OCR**：本地 prepareDocument/renderPage → OCR Agent → model-registry → pi-ai 的 OpenAI-compatible 流式接口 → Qwen OCR。`runOcrWithRepeatedRecovery` 清理可用文本；遇到 repeated 或不可用文本时允许一次业务重试。本轮日志只保留聚合 ocrMs，不能确认每页实际 OCR 请求数或第 15 页是否重试。
5. **每页独立 normalizer**：该页 OCR 原文、原始页码、首营 systemPrompt、完整 Tool Schema → 新建 normalizer Agent → registry.models.streamSimple → pi-ai 构造请求 → 生产 onPayload 加入 `enable_thinking: true` → 百炼 `deepseek-v4-flash-0731` 流式返回 thinking 和 Tool arguments。不是把所有 14 页合在一次 DeepSeek 请求里。
6. **本地 Tool 执行**：SDK 解析/校验 Tool 参数，调用 `submit_unit_initial_approval`，其 execute 只是把 submission 回传应用；返回 terminate:true，所以成功后没有第二轮模型总结。Tool Calling 不是另一家远程服务，也不是 ERP 保存。
7. **本地 normalize**：`normalizeUnitInitialApprovalSubmission` 处理空值、日期、空格/大小写、资质行、来源页、证据及复核提示，计算推荐字段缺失和 readyForAutofill。模型结果此时仍需人工核验。
8. **每页完成即 merge**：`acceptPageResult` 调用 `incremental-extraction.ts` 的 mergeExtractions。基本信息补空；冲突按证据置信度选择并提示复核；经营范围去重合并；资质按证件类别/编号（无编号时按类别、发证机关和日期）合并。随后计算字段覆盖率并发出进度 IPC。此阶段无额外模型请求。
9. **进入人工环节**：所有工作槽结束后，返回 OcrClientResult；主进程 workflowSessions.complete 保存本次业务会话结果，Vue 将会话状态改为 reviewing。确认代填会另走 `erp.fillSession`；本次监测没有触发代填或保存。

## 每页实测

渲染单位为毫秒，其他耗时为秒。页总耗时包含该页渲染排队及本地处理；各页之间重叠，不能相加当作用户等待。Output Tokens 包含 Reasoning Tokens。

| 原页码 | 渲染 ms | OCR 秒 | Normalizer 秒 | 页总耗时秒 | Input Tokens | Output Tokens | Reasoning Tokens |
|---|---:|---:|---:|---:|---:|---:|---:|
| 1 | 145.97 | 3.49 | 17.57 | 21.21 | 3802 | 1955 | 1043 |
| 2 | 129.87 | 2.28 | 27.30 | 29.87 | 3673 | 3019 | 1993 |
| 3 | 110.13 | 6.09 | 44.10 | 50.58 | 4112 | 4548 | 3765 |
| 4 | 116.85 | 16.78 | 53.28 | 70.56 | 5415 | 4702 | 3422 |
| 5 | 112.31 | 4.48 | 51.62 | 56.73 | 3737 | 5715 | 4582 |
| 6 | 127.56 | 6.80 | 22.04 | 29.59 | 3722 | 2188 | 1690 |
| 7 | 121.16 | 12.21 | 6.49 | 19.57 | 4823 | 627 | 232 |
| 8 | 125.50 | 7.81 | 34.29 | 43.10 | 4353 | 3308 | 2820 |
| 9 | 164.32 | 10.72 | 16.05 | 26.93 | 4040 | 1601 | 1143 |
| 10 | 145.59 | 13.71 | 32.88 | 46.73 | 3798 | 2587 | 2127 |
| 13 | 106.23 | 1.93 | 36.31 | 38.35 | 3642 | 3600 | 2847 |
| 14 | 128.83 | 16.73 | 14.90 | 31.76 | 3595 | 1499 | 1024 |
| 15 | 165.28 | 98.46 | 19.37 | 118.00 | 16164 | 1800 | 1345 |
| 16 | 142.62 | 13.14 | 40.96 | 54.24 | 3880 | 4304 | 3646 |

## 累计工作时间与真实等待

| 阶段 | 累计工作时间 |
|---|---:|
| 本地渲染 | 1.842 秒 |
| OCR | 214.632 秒 |
| Normalizer | 417.151 秒 |
| TypeScript normalize | 6.21 毫秒 |
| 跨页 merge | 2.43 毫秒 |
| 本地处理合计（含 prepare/render/dispose） | 1.857 秒 |
| **文档 wall-clock** | **161.103 秒** |

Normalizer 平均每页 **29.80 秒**，P50 **30.09 秒**，范围 **6.49～53.28 秒**。以上累计阶段时间是并发工作时间，417 秒不代表用户等待了 417 秒。normalize+merge 合计仅 **8.64 毫秒**，不是本轮主要瓶颈。

## 为什么最后等到了 161 秒

根据页结束时间减页总耗时，近似还原以下时间线（不是额外抓取的服务端时间戳）：

- t≈0：原页 1～8 进入 8 个工作槽。
- t≈19.58：第 7 页完成，第 9 页开始。
- t≈43.10：第 8 页完成，第 15 页开始。
- 第 15 页随后本地渲染约 0.165 秒，OCR **98.46 秒**。
- t≈141.73：第 15 页 OCR 阶段结束，normalizer 开始。
- 第 15 页 normalizer 再用 **19.37 秒**，t≈161.10 结束整份文件。
- 其他选中页最晚在 t≈100.75 完成；最后约 **60.35 秒**等待主要集中在第 15 页剩余 OCR 和 normalizer。

所以：**累计工作量以 normalizer 为主，但决定本轮结束时间的长尾是第 15 页，尤其其 OCR。** 不能把这次全部等待笼统归因于 thinking。

第 15 页 normalizer input 为 **16164 tokens**，其余页约 **3595～5415**。同一业务模板下，这提示第 15 页传入的 OCR 文本更长；但本次没有保存原文、OCR token 用量或尝试次数，不能确定 98.46 秒具体来自长输出、重复识别、重试、服务端排队还是网络。

## Thinking 证据

- normalizer 模型：deepseek-v4-flash-0731。
- 14/14 构造请求明确开启 thinking；14/14 返回 thinking block。
- 累计 input **68756**、output **41453**、reasoning **31679** tokens。
- reasoning 占 output **76.42%**；不能把这个 token 比例直接解释为耗时占比，也不能把 reasoning 和 output 再相加。
- 只记录思考字符数，累计 **109981**，未记录其内容。

本轮未做同一真实资料的 thinking-off 对照，没有抓原始 SSE 首 token/分块时间，因此无法精确分离 TTFT、reasoning 生成和 Tool arguments 生成秒数。当前 SDK 还存在请求重试封装；onPayload 只记录请求构造，故以上 14 次不能保证等于实际 HTTP 尝试总次数。

## 证据范围与当前状态

数据完整性：14 页 Page 记录、14 页 Normalizer 记录、1 份 Document 记录，均为同一 documentId=1。无 Tool 错误，无未结束页面。没有人工 Ground Truth，本轮验证的是调用过程与耗时，不是逐字段准确率；界面进度 100% 和覆盖率也不等于准确率 100%。

冻结统计见 `first-approval-live-trace-2026-09-23.json`；原采集路径为 `tmp/live-monitor/run-1790178034438.jsonl`。应用保持运行供人工复核，当前开发进程由统计采集脚本托管；没有为结束分析关闭窗口，也没有修改生产业务代码。
