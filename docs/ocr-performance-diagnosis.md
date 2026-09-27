# OCR 后处理性能诊断

本轮基于当前 `erp-plugins`、pi-ai / pi-agent-core 0.84.3。仅添加观测和独立测试；未修改生产模型、请求的 thinking 参数、业务 Prompt、Schema、normalize/merge 规则、ERP 代填或依赖版本。

## 调用链与等待位置

1. `pi-document-client.ts` 的 `extractDocument` 加载业务 adapter；`prepareDocument` 在本地读取图片/PDF。每页通过 `renderTail` 排队，`document-images.ts` 渲染图片。
2. `processPage` 创建 OCR Agent，经 `trackedPrompt → promptWithTimeout → agent.prompt` 发出 Qwen 请求。空文本/重复结果可重试；商品收货缺表头时还会裁剪当前页顶部并追加 OCR。
3. 同页 OCR 文本准备好后，`adapter.createSubmissionTool` 建立业务工具，创建 normalizer Agent，仍经 `trackedPrompt → agent.prompt` 发出 DeepSeek 请求。并非等全部页面 OCR 完成才启动 normalizer。
4. `extraction-registry.ts` 选择 `unit-initial-approval-tool.ts`、`goods-receipt-tool.ts` 或 `purchase-order-tool.ts` 的原有 system prompt、TypeBox Schema 和提交工具。模型返回工具参数，SDK 校验后执行本地 `execute`，通过 callback 设置 `submitted`。
5. 三个成功提交工具均返回 `terminate: true`，正常提交后不再请求模型生成总结。未知工具、参数校验失败等异常可能触发后续轮次，因此日志统计 modelResponses、toolCalls、toolResults 和 toolErrors。
6. Agent 结束后执行本地 `adapter.normalize`，随后 `acceptPageResult` 执行 `adapter.merge`、覆盖率和进度计算。结果经 IPC 回到人工复核界面。Tool 回调、normalize、merge 本身没有网络调用。

模型阶段计时包含网络、服务端排队/推理、流式读取、SDK 解析与工具校验执行，不能解释为纯服务端推理时间。本地 PDF 渲染涉及原生库，实际成本也需要计时。

## SDK 的 thinking 证据

- `model-registry.ts` 注册 `reasoning: false`，没有兼容格式或额外采样参数。
- Agent 的 `thinkingLevel: 'low'` 在 `pi-agent-core/dist/agent.js` 转为 `reasoning: 'low'`。
- `pi-ai/dist/models.js` 的 `getSupportedThinkingLevels / clampThinkingLevel` 对 `reasoning: false` 只允许 `off`。
- `pi-ai/dist/api/openai-completions.js` 的 `streamSimple` 将 off 转成 `reasoningEffort: undefined`。构造 `enable_thinking` 和 `reasoning_effort` 的分支又要求 `model.reasoning` 为真，因此当前路径不写这些参数。
- `erp-field-normalizer` 是自定义 provider，DashScope URL 也不匹配 SDK 的 DeepSeek 专用 provider/URL 检测；不能根据 model id 含 DeepSeek 推断使用其专属参数格式。
- SDK 在 `client.chat.completions.create(params)` 前调用 `onPayload`。离线捕获验证两个模型都没有 `enable_thinking / reasoning_effort / thinking / reasoning / chat_template_kwargs`，网络调用数为 0。`npm run test:performance` 保留了 normalizer HTTP 边界的离线回归测试。
- 百炼[官方 DeepSeek 文档](https://help.aliyun.com/en/model-studio/deepseek-api)说明 `deepseek-v4-flash-0731` 默认开启 thinking，默认 effort 为 high。OpenAI-compatible HTTP 的开关是顶层 `enable_thinking`；Python SDK 的 `extra_body` 是 SDK 参数，不能原样嵌套进 HTTP JSON。
- 两页合成 PDF 的真实请求观测均为 `enableThinking: not-sent`、`reasoningEffort: not-sent`，但响应确实有 thinking block 和正的 reasoning token 数。当前运行中已观察到服务端思考，不只是根据默认值推测。

SDK 将 `reasoning_content` 等字段解析为 thinking block，将 `completion_tokens_details.reasoning_tokens` 映射到 `usage.reasoning`。但 0.84.3 使用 `reasoning_tokens || 0`，无法区分真实零和字段缺失。因此应用日志只在各响应都有正值时报告累计 reasoningTokens，否则为 null 并写 `reasoning metrics unavailable`。A/B 脚本读取原始 SSE，能保留真实 0 与缺失的区别。reasoningTokens 是 outputTokens 的子集，不再与 output 相加。

## 性能日志

`npm run dev` 默认输出到 Electron 主进程终端；`ERP_PERFORMANCE_LOG=0` 可关闭。生产构建通过 `import.meta.env.DEV` 禁用这些日志。

- `[Performance][Page N]`：renderQueueMs、renderMs、ocrMs、headerCropMs、normalizerMs、normalizeMs、mergeMs、pageTotalMs。
- renderMs 从真正开始渲染计时，队列等待单列；ocrMs 累加每次 OCR Agent 调用，包括重试与顶部补识别；裁剪列入本地 headerCropMs。
- normalizerMs 从调用 Agent 到结束；normalizeMs / mergeMs 分别包住原来的同步函数，返回值及异常继续原样传播。
- pageTotalMs 从 worker 领取该页到合并及进度处理结束，包含渲染排队；不包含尚未领取该页时的 worker 等待。
- `[Normalizer]`：模型、耗时、输入/输出/reasoning tokens、thinking block 是否存在及字符数、停止原因、工具调用/结果/错误数量，以及请求开关的白名单统计。输入 token 包含 SDK 拆出的缓存读写 token。
- `[Performance][Document]`：总页数、选中/排除页数、各阶段累计耗时、测得的本地阶段累计耗时，以及从 extractDocument 开始到资源清理结束的 wall-clock elapsedMs。它不包含此前的文件选择和隐私预览。
- 多页并发时 cumulative 不能相加当作用户等待时间。localProcessingMs 只累计读取/渲染/裁剪/normalize/merge/清理这些测量点，既非全部本地开销，也非 CPU 时间。
- 异常时会记录已开始、已完成及仍未结束的页数；文档日志是返回时快照，若原有调度逻辑的其他 worker 后续结束，其页日志标记 completedAfterDocumentReturn。本轮没有改动原来的并发取消行为。
- 每条日志带同一进程内的 documentId，便于并行文档关联。不打印文件名、路径、OCR 原文、工具参数、思考正文、响应体或 API Key。

## 独立 A/B

```bash
# 无联网、无 Key：检查配置
node scripts/normalizer-thinking-ab.mjs --dry-run

# Node 将本地 .env 注入进程环境；脚本只从 process.env 读取 Key
node --env-file=.env scripts/normalizer-thinking-ab.mjs --runs 3

# 环境变量已设置时，也可以用 npm；支持每种模式 3～5 次
npm run test:normalizer-thinking -- --runs 5
```

模型沿用 `MAIN_VITE_PI_NORMALIZER_MODEL`，默认与应用一致；Key 优先级为 PI_NORMALIZER_API_KEY、DASHSCOPE_API_KEY、PI_API_KEY。脚本仅调用 HTTPS 百炼域名，不操作 ERP，不读取业务资料。

所有请求采用相同合成中文文本、Prompt、工具 Schema、4096 输出上限、stream 和 tool_choice；仅切换顶层 enable_thinking。reasoning_effort 两组均不发送。顺序交替 on/off、off/on，串行执行，无自动重试；记录每次耗时、首个内容到达时间、tokens、reasoning 字符数、工具数及提取校验结果。平均/中位/最快/最慢仅统计完整且字段正确的结果，失败与不完整结果单列并返回非零退出码。

这是两行票据的精简 Tool Calling 微基准，不等同于三个完整业务 Schema，也不是整份 PDF 的 A/B。相同客户端输入在两种模式下的服务端 token 统计可能不同。

## 本轮实际结果（合成数据，单次运行环境）

### 两页 PDF，应用原有模型与完整商品收货 adapter

| 页 | render ms | OCR ms（含补识别） | normalizer ms | normalize ms | merge ms | pageTotal ms | reasoning tokens |
|---|---:|---:|---:|---:|---:|---:|---:|
| 1 | 47.70 | 7394.02 | 19178.28 | 0.18 | 0.63 | 26634.46 | 1266 |
| 2 | 69.96 | 6411.89 | 18490.73 | 0.54 | 0.11 | 25040.23 | 1040 |

文档 wall-clock：26639.83 ms；OCR 累计 13805.91 ms；normalizer 累计 37669.01 ms；测得本地阶段累计 150.36 ms。每页只有一个模型回复、一个提交工具调用，toolErrors 为 0，均有 thinking。结果 completed、4 行商品，但 readyForAutofill=false：此合成测试没有通过完整业务可代填条件，不作为业务准确率验收。

### 独立 A/B，最终严格校验版本，每组 3 次

| 指标 | thinking=true | thinking=false |
|---|---:|---:|
| 三次耗时 ms | 3825 / 3935 / 2998 | 2249 / 1953 / 3307 |
| 平均 ms | 3585.92 | 2503.19 |
| 中位 ms | 3824.85 | 2248.94 |
| 最快 / 最慢 ms | 2997.70 / 3935.21 | 1953.21 / 3307.43 |
| 平均 input tokens | 650 | 571 |
| 平均 output tokens（包含 reasoning） | 317.33 | 221.67 |
| 平均 reasoning tokens | 139.33 | 未提供，不能记为 0 |
| reasoning 字符数 | 344 / 538 / 274 | 0 / 0 / 0 |
| 正确工具提取 | 3/3 | 3/3 |

复核时补充了禁止额外字段的校验及反例测试，然后重新执行 A/B。上表为最终版本结果，精简任务平均耗时下降约 30.19%，但第三对样本关闭 thinking 反而略慢。这不表示完整 normalizer 或整份文档也会快 30.19%。较早一轮的平均值为 3597.29 / 2592.19 ms（约下降 27.94%），未与最终这轮混合统计。没有用这些样本调整任何生产开关。

## 验证与下一步

- `npm run typecheck`、`npm run build` 通过。
- 现有 OCR recovery 11、incremental 2、business isolation 9、goods receipt 17、purchase order 2：共 41 个用例通过。
- `npm run test:performance`：11 个离线用例通过，覆盖并发时长、关闭日志、敏感内容隔离、usage 缺失、真实 SDK 请求边界、A/B SSE 分片、禁止额外字段及错误统计。
- `npm run test:document-images` 仍因仓库已有缺失素材 `f1be425b3289565524cce105c39875d5.png` 报 ENOENT，5 个用例未开始。本轮未替换素材或修改业务测试。

测得的主要等待在 normalizer，thinking 已被实际观察到。下一步优先用完整业务 Schema 与人工标注的代表性样本做 on/off 对照，同时看字段质量和可代填率；通过后才考虑关闭生产 thinking。Prompt 精简、更快 normalizer、Jev 决策等均未实施。当前证据不足以承诺某项优化的整体收益。
