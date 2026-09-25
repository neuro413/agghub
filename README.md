# 🍊 AggHub

轻量化 LLM 渠道聚合网关，专注**内网个人自托管**。参考 new-api 的核心思想，保留渠道管理、协议转换、选路重试和请求观测，不引入多租户用户系统、额度计费或 Redis。

## ✨ 特性

- **渠道聚合**：支持 OpenAI Chat、OpenAI Responses、Anthropic、Vertex 四类渠道；支持模型别名映射、优先级与权重。
- **三类调用入口**：OpenAI Chat Completions、Anthropic Messages、OpenAI Responses；同协议优先直通，跨协议通过内部中间表示（IR）转换，支持非流式与 SSE。
- **选路与故障转移**：同渠道重试、跨渠道降级、空回复检测、按状态码自动停用渠道，以及全局 HTTP 代理。
- **请求预处理**：提示词正则、工具黑名单、thinking 清理、参数修改；提供可视化规则编辑和预览，以及限定链路的伪思考与历史续接。
- **统计与请求日志**：请求量、成功率、Token、平均延迟概览；可对照原始与改写后请求，查看网关响应及上游原始 JSON / SSE / 错误体。
- **轻量部署**：Node.js + SQLite 本地持久化，日志正文切块去重并压缩；React WebUI 提供渠道、统计、请求日志、预处理、设置五个页面。

## 快速开始

### 环境要求

- **Node.js ≥ 20.18.1，推荐使用较新的 Node.js 22**。当前 `undici` 依赖要求 Node.js ≥ 20.18.1。
- npm，在项目根目录安装依赖；无需额外数据库服务、Docker 或 Redis。
- `better-sqlite3` 包含原生模块；安装时优先使用预编译二进制，无法取得匹配版本时需要本机编译环境。

> **旧版升级提醒**：请先停止服务并备份整个 `data/` 目录。检测到行内存储正文的旧版 `request_logs` 表时，启动迁移会丢弃旧请求日志并重建日志表；渠道和设置保留。

```bash
npm install

# 开发模式：前端热更新 + 后端监听源码变化
npm run dev
# WebUI：http://localhost:5173
# 网关 API：http://localhost:3210

# 生产模式：先构建前端，再由后端单进程托管
npm run build
npm start
# WebUI 和网关 API：http://localhost:3210
```

- `npm run build` 只构建前端，输出到 `web/dist/`；后端通过 `tsx` 直接运行 TypeScript，**启动环境也需要安装开发依赖**，不要使用 `npm install --omit=dev`。
- Windows 下的 `start.bat` 仅执行 `npm start`，首次使用仍需安装依赖并构建前端。
- 开发服务器将 `/api`、`/v1` 代理到 `localhost:3210`。修改后端 `PORT` 时，也要同步调整 [web/vite.config.ts](web/vite.config.ts) 中的代理目标。
- 可通过 `GET /api/health` 检查服务是否启动；该接口不要求访问令牌。

## 客户端接入

1. 打开 WebUI，在**渠道**页新增渠道，填写类型、上游地址、凭证和支持的模型，并按需设置模型映射、优先级与权重。
2. 在客户端（如 SillyTavern 或其他 LLM 工具）中选择入口格式，填写网关地址和模型名。
3. 默认无需 API Key；若客户端强制要求填写，可使用占位值。设置访问令牌后，客户端必须填写该令牌。

| 入口 | 请求接口 | 常见客户端 Base URL |
| --- | --- | --- |
| OpenAI Chat | `POST /v1/chat/completions` | `http://<内网IP>:3210/v1` |
| OpenAI Responses | `POST /v1/responses` | `http://<内网IP>:3210/v1` |
| Anthropic Messages | `POST /v1/messages` | `http://<内网IP>:3210` |
| 模型列表 | `GET /v1/models` | 返回启用渠道配置的模型名及映射别名并集 |

客户端对 Base URL 的拼接方式可能不同，请以最终请求路径为准。模型列表来自本地渠道配置，不会在每次请求时实时拉取上游列表。

配置访问令牌后，`/api` 管理接口与 `/v1` 调用接口共用同一令牌，支持 `Authorization: Bearer <令牌>` 或 `x-api-key: <令牌>`。WebUI 会提示输入令牌，并保存在当前浏览器的 `localStorage` 中。

## 渠道管理

### 上游类型

| 类型 | 上游协议 | 凭证与说明 |
| --- | --- | --- |
| OpenAI Chat（`openai`） | Chat Completions | Bearer API Key，可配置兼容服务的 Base URL |
| OpenAI Responses（`responses`） | Responses | Bearer API Key，可配置兼容服务的 Base URL |
| Anthropic（`anthropic`） | Messages | `x-api-key`，可配置兼容服务的 Base URL |
| Vertex（`vertex`） | Gemini 或 Vertex Claude | API Key / 服务账号 JSON，支持区域与 Base URL 配置 |

Vertex 的区域默认 `global`：

- Gemini 使用 `generateContent` / `streamGenerateContent`；支持 API Key 或服务账号 JSON。
- 映射后的上游模型名以小写 `claude` 开头时，使用 Anthropic `rawPredict` / `streamRawPredict`。Vertex Claude 建议使用包含 `project_id`、`private_key`、`client_email` 的服务账号 JSON，由网关换取 OAuth 令牌；模型可用性取决于项目、区域及上游权限。
- 服务账号 JSON 填入同一个凭证输入框；当前没有 ADC / Workload Identity 接入。
- Vertex 跨格式转换使用模型别名时，应保持入口模型名与上游模型名的 `claude` 前缀分类一致，避免响应解析选择到另一种协议。

### 可配置项与连接测试

- 模型列表、`别名=上游模型` 映射、优先级、权重，以及启用 / 手动停用状态。
- 渠道级超时覆盖、User-Agent 覆写、去除非必要请求头。
- 每个渠道保存一份凭证；多份 Key 可分别建为不同渠道。当前没有渠道内 Key 池、并发配额或任意自定义请求头编辑器。
- OpenAI / Responses / Anthropic 的“测试连接”和“拉取模型”使用上游 `GET /v1/models`，最多读取返回列表前 50 个模型。因此测试结果不能完全代表实际生成接口的可用性。
- Vertex 的测试会发送一次输出上限为 1 Token 的生成请求，可能产生实际调用费用，不返回可拉取的模型列表。

## 选路、重试与超时

1. 根据请求模型筛选启用渠道，模型映射用于将对外别名替换为上游模型名。
2. `priority` 越大越优先；同一优先级内按 `weight` 加权随机。
3. 当前渠道失败后先按配置进行同渠道重试；仍失败则排除该渠道，选择剩余候选，同级耗尽后降到较低优先级。
4. 开启自动熔断时，命中配置的状态码会立即将渠道标记为自动停用。当前需要在渠道页**手动恢复**，没有定时探测、冷却或自动恢复机制。

两个重试设置都表示**首次尝试以外的额外次数**：默认同渠道重试 `1` 次、跨渠道重试 `2` 次，即候选充足时最多尝试 3 个渠道、每个渠道最多 2 次。实际次数还受错误类型、熔断及客户端断开影响。

- 网络异常、超时、`429`、`5xx` 等瞬时错误会优先在同渠道重试；`400`、`413`、`422` 直接结束请求，不切换渠道。其他错误可能跳过本渠道剩余重试。
- 权重 `0` 不能用于保证停用：当同层剩余候选权重全为 `0` 时仍可能被选中。需要停用时请关闭渠道启用开关。

**流式与超时边界：**

- 流式初始事件会先缓冲，尚未向客户端输出实质内容时，错误或空回复可以进入重试；一旦开始输出，就不会再重试或切换渠道。
- 全局超时默认 `120000 ms`，可被渠道配置覆盖。非流式用于约束单次上游请求及响应读取；流式每收到一个带数据的 SSE 事件会重置计时，主要约束事件间的空闲时间。
- 每次重试独立计时，重试间隔另算；Vertex OAuth 等前置操作也有独立行为，因此该值不能视为整个客户端请求的总耗时上限。
- 全局 `proxy_url` 使用 HTTP 代理，作用于上游请求；当前没有每渠道代理配置。

## 请求预处理

在**预处理**页配置规则。提示词、工具过滤和参数规则可按渠道、客户端入口格式和请求模型限定范围，各维度同时满足才生效，留空表示不限。模型名使用映射前的客户端请求名称，按精确值匹配。

| 功能 | 能力与边界 |
| --- | --- |
| 提示词规则 | 可视化生成字面量规则或手写正则，替换文本留空可删除；支持角色范围和只处理最后 N 条消息 |
| 工具过滤 | 按工具名精确匹配黑名单，清理对应工具定义及相关历史调用 / 结果 |
| thinking 清理 | 仅在 Anthropic 同协议直通路径清理历史块，可保留最近 N 个 thinking / redacted_thinking 块；另有独立的 redacted 清理开关 |
| 参数修改 | 支持赋值、缺失时添加、存在时修改、删除及参数 JSON 正则替换；支持点路径、数组下标和 JSON 值 |
| 伪思考 | 将指定标签内的普通输出整理为 Anthropic thinking 块，并通过本地记录续接历史内容 |
| 跨格式思维链 | 配置推理密文暂存容量，以及转换到 Claude 时是否自动调整不兼容的推理 / 采样参数 |

处理顺序为：命中时恢复伪思考历史并注入指令 → 清理 `top_p` / thinking → 工具过滤 → 提示词规则 → 构造上游请求 → 参数规则。提示词规则和参数规则分别按列表顺序执行，每次渠道尝试重新判断作用范围。

**参数规则作用于适配器构造完成后的最终上游请求体**，参数名应对应上游格式，可以删除适配器自动补充的字段。它主要面向非消息参数；消息、系统提示和由中继控制的字段有按协议设置的保护范围，消息内容改写应使用提示词规则。后置参数规则也可能重新添加前面删除的参数。

thinking 清理不用于跨格式 IR 路径；单独的 `redacted_thinking` 清理开关不继承普通 thinking 清理的渠道 / 模型范围。

修改后需要点击**保存修改**。提示词规则支持 JSON 导入 / 导出和单段文本预览；参数测试只试运行当前单条规则，不发送上游请求，也不模拟完整转换链路。

### 伪思考与思维链库

- 仅支持 **Anthropic 入口 → `anthropic` 类型渠道**的同格式路径；当前不支持 Vertex Claude 或跨格式路径。
- 需要开启“丢弃 thinking”、将保留数量设为 `0`，并同时命中 thinking 清理与伪思考的渠道 / 模型范围。
- 可配置起止标签和引导提示词；匹配到的标签文本会持续存入本地思维链库，后续根据客户端回传的签名自动恢复历史 assistant 内容。
- 这些内容来自模型输出的标签文本；网关生成的标识只用于本地续接，不具备上游原生 thinking 签名的认证能力。
- 思维链库用于查看和管理此类记录，无法给任意模型或任意请求自由注入库中条目。Responses 推理密文暂存属于另一类记录，不显示在该管理弹窗中。

## 协议转换与兼容边界

三种入口可路由至四类渠道；**同协议优先直通，跨协议尽力转换常用能力**。这里的直通仍会执行模型映射、已启用的预处理和必要的协议调整，SSE 也会经过解析重组。

### 通用能力

- 支持常用文本对话、函数工具定义 / 调用 / 结果、图片输入及可映射的流式增量。
- Anthropic 与 Responses 之间可转换部分文件内容字段；上游文件 ID 无法跨厂商自动解析或上传。Gemini 转换侧主要支持文本和图片输入。
- 多候选输出、复杂工具 Schema、音视频和厂商扩展字段不保证等价转换。`cache_control` 等缓存控制字段可能丢失；缓存 Token 计数的转换单独处理。
- 当前没有 Gemini 原生入口，也没有实现完整的 Responses 查询、取消、删除、Conversations 或 Files API。

### Responses 的状态与托管工具

- Responses → Responses 保留原生字段，由上游执行有状态会话及内置工具；模型映射和已启用的预处理仍会生效。
- Responses 转其他协议时，`previous_response_id`、`conversation`、`prompt`、`context_management`，以及 `item_reference` / `compaction` / `compaction_trigger` 输入项无法转换，会返回 `400`。
- 网关没有按 response ID 或 conversation 绑定渠道。选到不兼容渠道后也不会自动寻找另一个 Responses 渠道；有状态请求应固定到持有相应状态的 Responses 上游。
- Responses `web_search` 与 Claude `web_search_*` 的部分工具定义可以双向映射；搜索调用历史、结果块、引用及其他托管工具不保证转换。Chat / Gemini 路径不消费这套托管工具定义。
- Responses `custom` 工具可在部分路径映射为函数参数包装，grammar 等约束不会完整保留。

### thinking / reasoning 往返

- Claude 与 Responses 间支持推理意图、可读思考、签名及推理密文的转换与历史回传；相关续接依赖客户端保留这些字段及本地暂存记录仍然存在。
- **跨格式构造 Responses 上游请求时**默认使用 `store: false`，并自动追加 `include: ["reasoning.encrypted_content"]`。显式 `store: true` 时不自动追加；Responses 同格式直通不会补这两个默认值。
- Responses 相邻的一组 reasoning 项会合并为一个 Anthropic thinking 块，遇消息或工具调用时分组；回传时利用本地记录尝试恢复原有项及顺序。
- 推理项含密文但没有可读摘要时，thinking 文本使用字符串 `"null"` 占位。暂存淘汰或无法匹配后继内容时，部分推理项无法恢复。
- Gemini 当前提取返回的 thought 文本，尚未实现 `thinkingConfig` / `thoughtSignature` 的完整往返。
- 上游 `store: false` 不会关闭 AggHub 自身的日志和推理暂存；本地封装、哈希及压缩也不提供数据加密保护。

## WebUI、统计与请求日志

| 页面 | 主要用途 |
| --- | --- |
| 渠道 | 新增 / 编辑 / 启停 / 删除渠道，测试连接，拉取模型和配置映射 |
| 统计 | 24 小时 / 7 天 / 30 天概览，请求量和 Token 趋势、渠道与模型分布 |
| 请求日志 | 条件筛选、分页、正文详情、删除单条或清空全部请求日志 |
| 预处理 | 提示词、工具、thinking 与参数规则，预览及思维链库管理 |
| 设置 | 入口地址、访问令牌、重试、超时、熔断、代理及日志留存 |

### 统计口径

- 总请求、成功率、Token 和平均延迟按**最终结果记录**统计，不累计中间重试尝试。
- 平均延迟取最终一次尝试的完整耗时：流式包含该次流的消费过程，不含此前尝试与重试等待，无法用作首 Token 延迟。
- usage 主要依赖上游返回，包含可识别的缓存读写等明细；缓存 Token 属于输入 Token 的子集，不能再次加到总量中。
- 图表展示请求量和 Token 趋势；成功率与平均延迟显示为概览指标。统计直接来自留存日志，删除或过期清理日志会改变统计结果。

### 日志查看

- 支持按状态、入口格式、流式与否、渠道、模型筛选；关键词搜索匹配模型、上游模型、渠道名及错误信息，不搜索正文。
- 详情可查看对话、请求头、非消息参数、原始 / 改写后请求、网关响应、上游原始回复，以及存在时的历史思考注入记录。
- 默认列表只展示最终结果；管理 API `GET /api/logs?include_retries=1` 可包含中间尝试。当前没有按请求关联的完整尝试链视图、日期范围筛选或文件导出功能。
- “清空日志”作用于全部请求日志和正文块，不受当前列表筛选条件限制。

## 配置与默认值

端口通过环境变量 `PORT` 设置，默认 `3210`。其余设置保存在 SQLite 中，通过 WebUI 调整。下面列出**新数据库的默认值**，已有设置不会被默认值覆盖；完整定义见 [server/src/config.ts](server/src/config.ts)。

| 设置 | 默认值 | 说明 |
| --- | --- | --- |
| `single_retry_times` | `1` | 同渠道额外重试次数 |
| `channel_retry_times` | `2` | 跨渠道额外重试次数 |
| `retry_interval_ms` | `0` | 失败后的重试间隔，毫秒 |
| `request_timeout_ms` | `120000` | 单次上游请求 / 流式事件空闲超时，毫秒 |
| `auto_ban` | 开启 | 命中状态码后自动停用渠道 |
| `auto_ban_codes` | `401,403` | 自动停用的状态码 |
| `proxy_url` | 空 | 全局 HTTP 代理；留空直连 |
| `access_token` | 空 | 留空不鉴权；同时用于管理与模型调用 |
| `log_retention_days` | `30` | 请求日志保留天数 |
| `store_request_body` | 开启 | 保存请求头、请求正文、改写后正文及思考注入信息 |
| `store_response_body` | 开启 | 保存网关响应和上游原始回复 |
| `drop_thinking` / `drop_redacted_thinking` | 关闭 | 历史思考清理 |
| `pseudo_thinking_enabled` | 关闭 | 伪思考处理 |
| `pseudo_thinking_store_max` | `5000` | 伪思考暂存条数上限 |
| `reasoning_store_max` | `2000` | Responses 推理密文暂存条数上限 |
| `reasoning_auto_adjust` | 开启 | 允许跨格式时自动调整 Claude 推理相关参数 |

## 数据存储、备份与安全

- 数据库位于 `data/agghub.db`，首次启动自动创建并启用 SQLite WAL；运行期间可能同时存在 `-wal` / `-shm` 文件。
- 请求日志元数据与正文都在同一数据库内。正文按 SHA-256 寻址，适用时结构化切块去重；优先使用运行时支持的 Zstd，否则回退到 gzip，较小内容可直接存储。
- **含 Zstd 正文的数据库需要支持 Zstd 的 Node.js 才能读取相关记录**。迁移和恢复时尽量保持兼容的运行时版本，避免直接降级。
- 过期日志在启动时及每 6 小时清理，同时回收无引用正文块。关闭正文存储只影响后续写入，既有正文仍会保留；思维链暂存有独立的容量设置。
- 备份时建议先停止服务，再复制整个 `data/` 目录；尤其在升级旧日志结构前，应先完成备份。
- **默认无鉴权，请勿直接暴露公网**。后端未限定为仅监听回环地址，应配合可信内网、防火墙及必要的反向代理访问控制；静态页面和 `/api/health` 即使配置令牌也仍可访问。
- 管理接口可以读取上游凭证；共享访问令牌也带有管理权限，不适合作为多人分发的独立调用 Key。请妥善保护数据库、备份及浏览器中的令牌。
- 日志只对部分认证头做服务端脱敏，请求 / 响应正文没有通用敏感信息过滤。提示词、工具参数和错误信息可能包含隐私内容，分享日志前请自行检查。

## 技术栈与目录结构

- 后端：Node.js + TypeScript + Express + `better-sqlite3` + `undici`，通过 `tsx` 运行。
- 前端：React + TypeScript + Vite，手写设计系统与 SVG 图表。
- 工程：npm workspaces，根脚本统一管理 `server` 与 `web`。

```text
agghub/
├── package.json                 根脚本与 workspaces
├── data/                        SQLite 数据（运行时创建）
├── server/src/
│   ├── index.ts                 HTTP 服务、鉴权、路由和静态托管
│   ├── config.ts / db.ts        默认配置、数据库结构与迁移
│   ├── entry/                   三类客户端入口
│   ├── adapters/                上游请求构建、认证、Vertex OAuth
│   ├── convert/                 IR、协议 / SSE / 推理 / usage 转换
│   ├── core/                    选路、中继、重试、代理与预处理
│   │   ├── paramRules.ts        参数规则
│   │   ├── pseudoThinking.ts    伪思考拆分与历史续接
│   │   └── thinkingStore.ts     伪思考及推理密文暂存
│   ├── routes/                  渠道、设置、统计、日志等管理 API
│   └── stats/                   日志记录、正文块存储与清理
└── web/src/
    ├── pages/                   五个主页面及编辑 / 详情弹窗
    ├── api/                     管理 API 客户端与令牌处理
    ├── lib/                     请求正文解析
    ├── components/              通用组件
    ├── charts/                  SVG 图表
    └── styles/                  设计变量与样式
```
