# 生产 Normalizer 思考开关

在项目根目录 `.env` 中配置：

```dotenv
MAIN_VITE_PI_NORMALIZER_ENABLE_THINKING=false
```

- `true`：向百炼 normalizer 请求显式发送顶层 `enable_thinking: true`。
- `false`：显式发送 `enable_thinking: false`。
- 删除该项或留空：不发送此参数，沿用服务端默认行为，兼容此前配置。
- 仅接受小写 `true` / `false`，自动去除首尾空格；其他非空值报配置错误，避免误启用思考。

该设置只影响字段标准化，不影响 OCR。生产关闭诊断日志时同样生效；开发性能日志记录的是设置后的实际开关。模型、Prompt、Schema、max tokens、reasoning_effort、merge 和 autofill 均保持现状。

配置读取沿用项目现有优先级：非空 `import.meta.env.MAIN_VITE_*` 构建值优先，否则回退到同名进程环境变量。开发修改 `.env` 后重启 `npm run dev`。发行版修改构建配置后须重新构建、打包；安装目录的 `.env` 不会被自动读取，非空内置值也不会被启动环境变量覆盖。

本次仅接入配置能力，未在本地 `.env` 中自动开启或关闭思考。上一轮 benchmark 报告属于接入该配置前的历史实验；本开关不会改变其 A/B/C 测试脚本中显式指定的实验分组。

验证命令：

```bash
npm run test:normalizer-config
npm run typecheck
npm run build
```

配置测试通过真实 `PiDocumentClient`、Agent、SDK、Tool、normalize/merge 路径，在 HTTP 边界提供固定模拟响应，验证开发/生产模式的 true、false、未配置，以及 OCR 隔离、严格布尔解析和日志保留。

## 本次验证（2026-09-23）

类型检查、生产构建、新增 4 项配置测试和既有相关 57 项测试通过。另行运行的 `test:document-images` 仍因缺少 `f1be425b3289565524cce105c39875d5.png` 在断言前失败，未改动该测试或无关业务逻辑。

生产模式 `PiDocumentClient` 还完成了两次真实百炼 normalizer 冒烟请求，模型为 `deepseek-v4-flash-0731`。OCR 响应由固定合成文本提供，不重新调用 OCR；新环境变量经过真实配置读取和生产请求钩子，不在测试中覆盖 normalizer payload：

| 配置及实际发送值 | normalizer 耗时 | Input Tokens | Output Tokens | Reasoning Tokens | Thinking 字符数 | 固定字段评分 |
|---|---:|---:|---:|---:|---:|---:|
| false | 7.09 秒 | 2611 | 793 | N/A | 0 | 100% |
| true | 26.79 秒 | 2690 | 3179 | 1873 | 6054 | 100% |

两次均 HTTP 200、一次 Tool Call、readyForAutofill=true。N/A 是原始 API 未提供字段，不是零。每种模式只跑一次，目的是验证开关生效，不替代此前三轮 benchmark 或生产质量验收。统计保存在 `tmp/normalizer-config/live-smoke-results.json`，不保存返回参数或 reasoning 正文。

本地 `.env` 前后哈希一致，未自动切换默认模式。
