# 完整业务 Normalizer Replay Benchmark

本轮只增加独立 benchmark、固定虚构样本和离线验证。生产默认模型、thinking 行为、业务 Prompt、Schema、商品行规则、normalize、merge 和 autofill 保持原样。

## 复现

在项目根目录，使用支持 `--env-file` 的现有 Node.js：

```bash
# 仅检查配置、生产代码和固定样本，不发 API 请求
node --env-file=.env scripts/normalizer-replay.mjs --dry-run

# 6 个样本 × 3 个配置 × 3 次；当前账号支持 C 时共 54 次
node --env-file=.env scripts/normalizer-replay.mjs --runs 3 --concurrency 2

# 离线评分、SSE、真实 Agent/Tool/HTTP 请求一致性测试
npm run test:normalizer-replay:offline
```

API Key 只通过现有环境变量读取；不要将 `.env` 提交。也可由 shell 注入环境变量而不使用 `--env-file`。脚本加载当前项目 normalizer 配置，不更换 endpoint、不设置 fallback。每次运行将统计保存到 `tmp/normalizer-replay/run-*/` 的 `manifest.json`、`runs.jsonl`、`summary.json`、`table.md`，不保存返回原文、Tool 参数或 reasoning 内容。

`--runs` 支持 3、4、5，`--concurrency` 支持 1、2。需要单请求基准时使用 `--concurrency 1`，另开一轮对照，不与本报告的并发 2 结果混合。

## 实验设计与复用边界

使用 `goods-receipt` 和 `purchase-order` 的真实 `systemPrompt`、SubmissionSchema、Tool definition 和 TypeScript normalize。`scripts/normalizer-replay-runtime.mjs` 仅在临时测试 bundle 中导出 `pi-document-client.ts` 原有的 `createAgent` 和 `promptWithTimeout`，并从 AST 提取原有 normalizer 用户消息模板；没有维护另一份精简 Prompt/Schema，也没有修改生产源文件。

调用路径为：固定 OCR 文本 → 原页面消息模板 → 原 Agent → 原 model-registry → pi-ai OpenAI-compatible streaming 请求 → 原业务 Tool → 原 normalize → 固定答案评分。没有 OCR、PDF 渲染、跨页 merge 或 ERP 写入。每个样本是一页，商品 sourcePages 固定为 `[1]`。

配置 A 为 `deepseek-v4-flash-0731` / thinking on；B 为同模型 / thinking off；C 为 `deepseek-v4.1-flash` / thinking off。仅在测试 Agent 的最终 payload hook 加入顶层 `enable_thinking`。C 只改变测试 registry 的 modelId。最大输出保持 16384，temperature 和 reasoning_effort 均未显式发送，使用相同服务端默认行为，超时沿用当前配置 180 秒。

百炼参数来源：[DeepSeek API 官方文档](https://help.aliyun.com/en/model-studio/deepseek-api)。账号是否可用以完整业务请求的 HTTP 实测为准。C 无成功 HTTP 响应时保留失败记录并跳过其余 C 请求，绝不改 endpoint 绕过。

同一样本第一轮请求移除 model 和 enable_thinking 后计算整个 payload 的 SHA-256；所有配置和重复必须一致。manifest 另保存 OCR、完整样本、systemPrompt、Schema、用户消息及生产调用文件的哈希。离线测试进一步在 HTTP body 边界验证三组请求差异，并确认真实 Tool 成功后终止 Agent，不触发额外总结请求。

先以真实收货简单样本探测 C，成功则计入 C 第一次；其余按样本及轮次轮换配置顺序，并发上限 2。服务端缓存不强制清除，记录原始 cached input tokens。因此它是当前账号下的混合缓存在线回放，并非严格冷缓存或统计显著性试验。

## 固定样本与质量口径

`test-data/normalizer-replay/` 共 6 份纯虚构文本，每业务分别 2、8、16 行，共 52 个预定义商品行。重复 3 次后，每配置评估 156 行。没有真实企业、个人、银行卡、API Key 或生产 OCR 入库。旧票据仅提供版式参考。

Ground Truth 来自 API 实验前固定的合成字段规格，由编码助手协助编写，并非被测模型的抽取答案，也不是人工独立标注的真实票据。样本具有完整列标题、明确合计和受控换行，结论不能直接替代生产噪声样本的验收。

包含同商品/规格/厂家/批号/单价但不同数量的独立行，以及复杂样本完全相同的两行；这些行必须逐行保留。涵盖名称、规格、厂家、批准文号、批号、数量、单价、金额、日期等完整商品字段。

- 字段准确率：固定 Header 字段和全部商品字段的精确匹配比例；数字容差 1e-6，字符串精确匹配；显式 null 也计分。另报非空 Header 准确率，避免大量 null 掩盖错误。
- 商品行准确率：按原始顺序，整行全部固定字段正确才算一行正确，分母取期望/实际行数的较大值。漏行后移位会连带扣分，属于严格位置准确率。
- Header：统计漏提取、填入预期空字段、错误复用其他 Header 值，以及错误字段名。精确匹配失败不自动等于事实错误，可能存在同义表达，不能据此替代人工语义判分。
- 采购单 `remark` / `receiptRemark` 是自由文本，实验前即排除精确字符串评分；仍使用完整生产 Schema 校验。这不是所有输出字段的完整质量验收。
- 商品：同时记录缺行/额外行、超过标准答案重数的重复行、潜在合并行。潜在合并检测只是启发式；以整行精确匹配和行数为主要证据。
- 同时评分原 Tool submission 和 normalize 后结果，分别统计 Tool、Schema、normalize、readyForAutofill。readyForAutofill 只是现有业务规则状态，不等价于抽取无误，也未实际执行 autofill。
- 失败尝试保留在成功率分母中；耗时主表统计已完成请求，另保留所有尝试耗时。严格正确要求执行完成、Tool/Schema/normalize 成功且所有受评字段和行正确。

## Token 与延迟口径

input/output/reasoning tokens 来自原始 SSE usage，不能用 SDK 将缺失字段填成的 0。reasoning_tokens 未提供时保留 `null`，表格显示 N/A（reasoning metrics unavailable）；Tool argument token 单独分项接口未提供，也显示 N/A。thinkingChars 与 Tool 参数字符数在转发原始字节时统计，不持久化内容。

output tokens 包含 reasoning tokens，不能将两者相加。只有接口明确报告 reasoning tokens 时，才计算 reasoning/output 比例。

TTFT 指客户端发出 fetch 到首个非空 reasoning、正文或 Tool argument 内容到达；不包含只有角色或空内容的首块。它混合网络、服务端排队、prefill 和首块生成，无法准确拆成“服务端等待”。thinking / Tool arguments / 其他正文的首末到达时间是客户端可见窗口，非纯服务端计算时长；窗口间隙、尾部 usage、Agent 和本地处理另有少量余量，不能强行当成独立可加的计算阶段。

每次 elapsedMs 为整个 Agent 调用的 wall-clock。并发下所有请求耗时之和是累计工作时间，不是整轮真实等待时间。normalize 另记本地耗时。完整 Prompt、Schema 大小在各业务内固定，输入长度与商品行数、输出长度共同变化；此设计比较相同业务请求下 thinking 开关对应的实测差异，但受混合缓存、并发和服务端波动影响，不能称为纯因果成本，也不能独立分离 Prompt 与 Schema 的成本。

## 实际结果

2026-09-23 完成在线实验，当前账号/endpoint 支持 C。54/54 请求完成，均为单次 HTTP、一次 Tool Call，stopReason 均为 `toolUse`；原始 SSE 全部正常结束，无解析错误。每个样本/配置均 3 次。

整轮真实 wall-clock 约 **675.9 秒（11 分 16 秒）**，54 次 Agent 耗时累计 **1335.2 秒**；后者不能当作用户等待时间。此次归档将初版记录中误命名为 startedAt 的完成时间改名为 completedAt，未伪造开始时间；脚本已修正未来运行的时间字段。该问题不影响使用 monotonic clock 采集的 elapsedMs 或流式阶段时间。

逐请求统计、哈希及评分见同目录 `normalizer-replay-results.json`，不含模型输出正文。六份 JSON 样本在 API 实验前后哈希一致；37 份生产源码/业务配置/本地环境文件/lockfile 的前后哈希一致。

| 业务/样本 | 模型 | Thinking | 平均秒 | P50秒 | 最快秒 | 最慢秒 | Input Tokens | Output Tokens | Reasoning Tokens | 字段准确率 | 商品行准确率 | Tool成功率 | 完成/尝试 |
|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|
| goods-receipt-simple | deepseek-v4-flash-0731 | on | 31.70 | 37.60 | 17.52 | 39.97 | 2690 | 3674 | 2434 | 100.0% | 100.0% | 100.0% | 3/3 |
| goods-receipt-simple | deepseek-v4-flash-0731 | off | 10.53 | 11.43 | 7.41 | 12.74 | 2611 | 1280 | N/A | 98.8% | 66.7% | 100.0% | 3/3 |
| goods-receipt-simple | deepseek-v4.1-flash | off | 11.06 | 10.10 | 9.02 | 14.07 | 2602 | 1155 | N/A | 100.0% | 100.0% | 100.0% | 3/3 |
| goods-receipt-medium | deepseek-v4-flash-0731 | on | 39.05 | 37.61 | 36.90 | 42.64 | 3219 | 4740 | 2548 | 100.0% | 100.0% | 100.0% | 3/3 |
| goods-receipt-medium | deepseek-v4-flash-0731 | off | 14.65 | 14.60 | 14.16 | 15.18 | 3140 | 1938 | N/A | 100.0% | 100.0% | 100.0% | 3/3 |
| goods-receipt-medium | deepseek-v4.1-flash | off | 19.10 | 16.57 | 15.72 | 25.02 | 3131 | 2262 | N/A | 100.0% | 100.0% | 100.0% | 3/3 |
| goods-receipt-complex | deepseek-v4-flash-0731 | on | 71.95 | 74.69 | 65.69 | 75.48 | 4440 | 9226 | 5392 | 100.0% | 100.0% | 100.0% | 3/3 |
| goods-receipt-complex | deepseek-v4-flash-0731 | off | 25.31 | 25.45 | 24.38 | 26.09 | 4361 | 3528 | N/A | 100.0% | 100.0% | 100.0% | 3/3 |
| goods-receipt-complex | deepseek-v4.1-flash | off | 26.82 | 27.20 | 25.26 | 27.99 | 4352 | 3854 | N/A | 100.0% | 100.0% | 100.0% | 3/3 |
| purchase-order-simple | deepseek-v4-flash-0731 | on | 13.10 | 13.62 | 12.04 | 13.65 | 2184 | 1658 | 702 | 100.0% | 100.0% | 100.0% | 3/3 |
| purchase-order-simple | deepseek-v4-flash-0731 | off | 6.83 | 6.68 | 6.61 | 7.21 | 2105 | 880 | N/A | 100.0% | 100.0% | 100.0% | 3/3 |
| purchase-order-simple | deepseek-v4.1-flash | off | 9.46 | 7.80 | 7.63 | 12.95 | 2096 | 918 | N/A | 100.0% | 100.0% | 100.0% | 3/3 |
| purchase-order-medium | deepseek-v4-flash-0731 | on | 30.77 | 27.90 | 27.34 | 37.08 | 2744 | 4017 | 1753 | 100.0% | 100.0% | 100.0% | 3/3 |
| purchase-order-medium | deepseek-v4-flash-0731 | off | 15.08 | 15.13 | 14.68 | 15.44 | 2665 | 2104 | N/A | 100.0% | 100.0% | 100.0% | 3/3 |
| purchase-order-medium | deepseek-v4.1-flash | off | 20.50 | 21.32 | 14.12 | 26.05 | 2656 | 2390 | N/A | 99.3% | 100.0% | 100.0% | 3/3 |
| purchase-order-complex | deepseek-v4-flash-0731 | on | 48.00 | 48.84 | 45.93 | 49.25 | 3979 | 6387 | 2782 | 100.0% | 100.0% | 100.0% | 3/3 |
| purchase-order-complex | deepseek-v4-flash-0731 | off | 26.93 | 27.59 | 24.76 | 28.44 | 3900 | 3751 | N/A | 100.0% | 100.0% | 100.0% | 3/3 |
| purchase-order-complex | deepseek-v4.1-flash | off | 24.22 | 23.26 | 22.95 | 26.45 | 3891 | 3777 | N/A | 99.8% | 100.0% | 100.0% | 3/3 |

单位：耗时秒，tokens 为三次算术平均后四舍五入。字段准确率为每次固定字段比例的平均；行准确率为严格整行精确匹配。N/A 表示原始接口未提供 reasoning tokens，不是 0。C 的成功调用不等于质量通过。

A/B 最终 payload 去掉 model 和 enable_thinking 后，每个样本的 9 次请求只有一个 controlHash。尽管请求文本/Schema 完全相同，服务端报告 A 的 input tokens 比 B 多 79，C 比 B 少 9；这属于服务端 usage 的实测差异，内部模板/计数不可见，不能强行把 token 数写成相等。

## Thinking 开关和模型比较

| 固定样本 | A 平均秒 | B 平均秒 | B 耗时减少 | C 相对 B |
|---|---:|---:|---:|---:|
| 收货 2 行 | 31.70 | 10.53 | 66.8% | 慢 5.1% |
| 收货 8 行 | 39.05 | 14.65 | 62.5% | 慢 30.4% |
| 收货 16 行 | 71.95 | 25.31 | 64.8% | 慢 6.0% |
| 采购 2 行 | 13.10 | 6.83 | 47.9% | 慢 38.4% |
| 采购 8 行 | 30.77 | 15.08 | 51.0% | 慢 35.9% |
| 采购 16 行 | 48.00 | 26.93 | 43.9% | 快 10.1% |
| 六样本等权 | **39.10** | **16.55** | **57.7%** | **整体慢 11.9%（18.53 秒）** |

这些是本次在线运行的观测比例，不是总体性能置信区间。每格仅 3 次、无固定 seed、保留服务端默认 temperature，并发和混合缓存都可能影响重复波动。A 的收货简单样本从 17.52 到 39.97 秒，不能用单次最优代替三次统计。

## 质量结果

| 配置 | 严格正确请求 | Header 准确率 | 非空 Header 准确率 | Header 漏提取率 | 严格商品行 | Tool / Schema / normalize / ready |
|---|---:|---:|---:|---:|---:|---|
| A | 18/18 | 270/270，100% | 144/144，100% | 0/144 | 156/156，100% | 各 18/18 |
| B | 17/18 | 270/270，100% | 144/144，100% | 0/144 | 154/156，98.72% | 各 18/18 |
| C | 13/18 | 265/270，98.15% | 139/144，96.53% | 5/144，3.47% | 156/156，100% | 各 18/18 |

B 的唯一严格失败是收货简单样本第三次：两条商品 `remark` 未保持预期的 null，因此这次两行均不满足“所有字段完全正确”。表中该样本的商品行准确率 66.7% 是 4/6 行完整匹配，**不是漏了三分之一商品行**。没有保留返回备注正文，不推测填入内容或其语义；不能据此宣称所有业务字段均不受影响。

C 的五次 Header 漏提取都发生在 `transportMethod`：采购中等 3/3 次、采购复杂 2/3 次遗漏。是明确漏提取，不是单纯同义词精确匹配问题。Header 错误复用其他字段、向预期空 Header 字段填值均为 0。

三组的商品行数量、顺序、名称、规格、厂家、批号、批准文号、数量、单价、金额、日期均匹配固定答案；无缺行、额外行或超出标准重数的重复行，同商品行及完全相同行均被保留。唯一商品字段差异是上述两处 remark。原 Tool submission 与 normalize 后的质量评分一致，未由 normalize 掩盖这些差异。

按全部固定字段微平均，A 为 3000/3000，B 为 2998/3000，C 为 2995/3000。大量字段正确会稀释单字段遗漏，必须同时看逐请求严格成功和 Header 指标，不能仅凭接近 100% 的总准确率判断可上线。

## 客户端观察到的延迟组成

| 配置 | Agent 平均秒 | TTFT 平均秒 | thinking 到达窗口均值秒 | Tool arguments 到达窗口均值秒 | 其他正文到达窗口均值秒 |
|---|---:|---:|---:|---:|---:|
| A | 39.10 | 0.95 | 21.88 | 15.98 | 未观察到 |
| B | 16.55 | 1.22 | 未观察到 | 15.01 | 0.27 |
| C | 18.53 | 3.38 | 未观察到 | 14.85 | 0.26 |

这些是 SSE 内容首末到达窗口；窗口间隙、首尾块和本地执行造成余量。未直接测得服务端排队、prefill、逐 token GPU 计算时间，不能把此表命名为纯服务端耗时分解。C 的 TTFT 最大达 12.39 秒，存在较明显首内容等待波动；不能确认是哪一层服务导致。

A 的 thinking 内容为 1808～14911 字符，原始 reasoning tokens 在 18 次中均有报告；B/C 均未观察到 thinking 内容，reasoning token 字段均未提供。A 平均 output **4950.2**、reasoning **2601.8**，累计 reasoning/output 为 **52.56%**。分别看收货 2/8/16 行，比例 66.3%/53.8%/58.4%；采购 2/8/16 行为 42.3%/43.6%/43.6%。B/C 平均 output 为 **2246.8 / 2392.8**，不得把缺失的 reasoning count 写成零后计算比例。

B 的 Tool argument 到达窗口平均占 Agent 总时间约 **90.7%**，参数长度 **2117～10390 字符**。关闭 thinking 后，收货/采购 16 行仍需 **25.31 / 26.93 秒**，output **3528 / 3751 tokens**。因此完整结构化输出确实是显著剩余成本，不能期待只关 thinking 后大单也降到微基准的 2～3 秒。

完整 goods-receipt / purchase-order Schema 分别为 **4089 / 3107 UTF-8 字节**；HTTP tools 数组分别为 **4271 / 3299 字节**。OCR 长度分别为收货 **580/1369/3146**、采购 **599/1444/3299** 字符。Schema 在各业务内固定，输出却随 2→8→16 行明显变长。

B 的 18 次观测中，elapsed 与 output tokens 的 Pearson r≈**0.998**，与 Tool 参数字符数 r≈**0.987**，与 input tokens r≈**0.939**。这些变量随商品行数共同增长，不能将相关性当成独立因果证明；不过结合约 15 秒的实际 Tool 流窗口，支持“剩余等待主要落在输出生成”这一判断。没有缩减 Prompt/Schema 的实验，无法给它们各自分配独立的秒数。

本地 normalize 平均 **0.218 ms**，最大 **1.177 ms**。本轮未执行 merge，因此不新增其性能结论。

## 六个问题的结论

1. **Thinking 是否是原 18～19 秒的主要原因？** 本轮完整业务回放显示 thinking 是主要可避免成本之一，平均约 21.88 秒可见 thinking 窗口，A/B 观测差约 22.54 秒。但本轮输入不是上一轮原始页面，无法把历史那次 18～19 秒精确拆成固定的 thinking/Schema/输出秒数，也不能直接按 57.7% 换算历史请求。
2. **关闭 thinking 的完整业务提升？** 六样本等权平均 39.10→16.55 秒，耗时减少 57.7%；按样本为 43.9%～66.8%。不是上一轮精简 Tool 的推算。
3. **4.1 是否明显更快？** 本账号可用，但整体 18.53 秒，比 B 慢 11.9%。只有复杂采购样本快 10.1%，且该样本 2/3 次漏 transportMethod，不能据此更换默认模型。
4. **哪组不降正确率且最快？** 按预先固定的全字段严格标准，只有 A 在本轮达到 18/18；尚无证据支持一种更快配置完全不降正确率。B 总体最快、核心商品字段正确，但有一次备注空值偏差；C 有五次运输方式遗漏。不要把 Tool/schema/ready 的 100% 当作抽取正确率。
5. **剩余耗时与什么更相关？** 对关闭 thinking 的 B，输出长度及 Tool arguments 流最直接；大单依旧约 25～27 秒。输入行数同时增加，Prompt/Schema 的独立成本本实验不可识别。C 还有较大 TTFT 波动。
6. **是否足以进入 Jev PoC？** 尚无充分证据证明 Jev 会解决本次已测出的长结构化输出或质量问题。更合理的下一步是独立人工标注真实脱敏 OCR 回归集，扩大 B 的质量验证及并发/缓存对照；本轮不实施任何生产优化。

## 验证与改动边界

`npm run typecheck`、`npm run build`、新增 5 项 replay 离线测试，以及现有相关 52 项测试通过（goods-receipt、purchase-order、business-isolation、incremental-extraction、ocr-recovery、performance）。已知缺 PNG 的 document-images 测试不属于本轮改动路径，未为其修改业务代码。

当前分支 `fast_test`。本轮只新增 replay 脚本、6 份合成样本、报告/统计及 2 个 npm scripts；保留上一轮埋点、A/B 和已授权文件删除，未提交或推送。生产默认配置保持不变。

