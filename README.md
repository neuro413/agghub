# 注意：阅读代码与调试时不要直接把数据库中的api配置信息加载到上下文中，里面有api key


# 🍊 AggHub

轻量化 LLM 渠道聚合网关，专注**内网个人自托管**。参考经典项目 new-api 的核心思想，砍掉面向多租户的重型部分（令牌体系、用户系统、额度计费、Redis、Docker），只保留个人真正需要的能力。

## ✨ 特性

- **渠道聚合**：支持 OpenAI Chat / OpenAI Responses / Anthropic / Vertex(API Key) 四种上游格式
- **对外三入口**：OpenAI 兼容（`/v1/chat/completions`、`/v1/models`）+ Anthropic 原生（`/v1/messages`）+ OpenAI Responses（`/v1/responses`），三种入口与四种上游任意组合互转
- **智能选路**：优先级分主备梯队 + 同级权重加权随机
- **故障转移**：请求失败自动重试降级、坏渠道命中状态码自动熔断
- **请求预处理**：提示词正则改写、工具黑名单、丢弃 / 伪造 thinking，以及按渠道 / 入口格式 / 模型限定的**参数修改**规则（增删改 `top_p`、`temperature`、`thinking` 等参数，或对排除消息后的请求体 JSON 做正则替换，给兼容性欠佳的上游扫地）
- **数据统计**：请求量 / 成功率 / Token / 延迟趋势 + 渠道与模型分布 + 可回看对话正文与上游原始回复（非流式 JSON / 流式 SSE 原文 / 错误体）
- **软萌 WebUI**：橙白圆角风格，渠道 / 统计 / 设置三页
- **零依赖部署**：Node + SQLite 单文件落库，无需 Docker / Redis

## 技术栈

- 后端：Node.js + TypeScript + Express + better-sqlite3
- 前端：React + TypeScript + Vite（手写设计系统 + 手写 SVG 图表）

## 快速开始

环境要求：Node.js ≥ 18（推荐 22）

```bash
npm install        # 安装依赖（含 better-sqlite3 预编译二进制）

# 开发模式：前端 5173（热更新）+ 后端 3210，前端自动代理 /api /v1
npm run dev

# 生产模式：构建前端后由后端单进程托管
npm run build
npm start          # 默认 http://localhost:3210
```

## 使用

1. 浏览器打开 `http://localhost:3210`
2. **渠道**页点「新增渠道」，填写名称 / 类型 / API Key / 支持的模型 / 优先级 / 权重，可先「测试连接」
3. 在客户端（SillyTavern、各类 LLM 工具）中配置网关地址：
   - **OpenAI 格式**：Base URL = `http://<内网IP>:3210/v1`
   - **Anthropic 格式**：Base URL = `http://<内网IP>:3210`
   - 默认**无需 API Key**（内网免鉴权；如需可在设置页配置「访问令牌」）
4. **统计**页查看调用趋势与请求明细（可展开看正文），**预处理**页配置提示词正则 / 工具过滤 / 参数修改规则，**设置**页调整重试 / 超时 / 熔断 / 数据留存

## 选路与故障转移

- `priority` 越大越优先（主备梯队）；同一优先级内按 `weight` 加权随机分配流量
- 请求失败时自动切换到下一个可用渠道，并按优先级逐级降级
- 命中熔断状态码（默认 `401,403`，多为凭证失效）的渠道会被自动停用，可在渠道页手动恢复

## 配置

- 端口：环境变量 `PORT`（默认 `3210`）
- 数据库：`data/agghub.db`（SQLite，自动创建）
- 其余运行参数（重试次数、超时、熔断、日志留存、正文存储）均可在 WebUI 设置页调整

## 目录结构

```
agghub/
├── server/   后端：选路 / 中继 / 故障转移 / 适配器 / 格式转换 / REST API
└── web/      前端：设计系统 / 通用组件 / SVG 图表 / 三大页面
```

## 说明

- 跨格式转换（如 OpenAI 入口 → Claude 上游）会尽力保真，少数厂商特有字段（如 Claude 的 `cache_control`）可能不保留
- Responses 入口 → Responses 渠道为直通，请求体全部字段（`previous_response_id`、`conversation`、内置工具、`include` 等）原样转发；Responses 入口 → 其它渠道走转换，`previous_response_id` / `conversation` / `prompt` / `context_management` 这类有状态字段无法转换，会直接返回 400，`web_search` 等托管工具会被丢弃
- 以 Responses 作为上游时默认 `store: false` 并带上 `include: ["reasoning.encrypted_content"]`，推理项在多轮工具调用时会随 IR 回传；一次响应里的多个 reasoning 项（多段摘要 / 工具调用之间的交错推理）对 Anthropic 客户端会合并成一个 thinking 块，签名回传时再展开成原来的多个 reasoning 项并按原顺序插回 message / function_call 之间；gpt-5.5+ 为防蒸馏返回的「有密文但摘要为空」的推理项，thinking 正文用占位 `null` 表示（多段时为换行 + `null`）
- 本项目面向内网个人使用，对外入口默认无鉴权，请勿直接暴露到公网
