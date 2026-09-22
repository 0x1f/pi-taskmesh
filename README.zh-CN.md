# pi-jev-multi-provider

[English](README.md) | **简体中文**

为 [Pi coding agent](https://github.com/earendil-works/pi) 提供 Jev System One 结构化判断、工具路由和技能推荐，支持 **TypeSafe Direct** 与 **Vercel AI Gateway** 两种传输。

本仓库由 `0x1f` 维护，当前包版本为 **0.5.2**。

> 这里的“多 Provider”指 Jev 判断请求的服务商选择，并不是给 Pi 注册两个通用聊天模型。`auto` 按凭据选择服务商，不是请求失败后的自动容灾切换。

## 快速开始

### 1. 安装

需要已安装的 Pi、Git，以及满足 Pi 自身要求的 Node.js。此扩展的 `package.json` 声明 Node.js `>=20`；Pi 的版本要求可能更高。开发依赖以 Pi `^0.85.0` 为基线，不代表所有 Pi 版本都已验证兼容。

```bash
pi install git:github.com/0x1f/pi-jev-multi-provider
```

安装后重启 Pi；在已运行的会话中可尝试 `/reload`。如需固定版本，可使用 `git:github.com/0x1f/pi-jev-multi-provider@<commit>`，将 `<commit>` 替换为实际提交 SHA。

若装过旧仓库版本，先运行 `pi list`，再按显示的源地址移除旧条目并安装本仓库；不会自动迁移旧安装地址。也请检查是否同时启用了其他 Jev 路由扩展，避免重复工具和自动请求。**不要批量移除无关扩展。**

### 2. 在 Pi 中配置

```text
/jev setup
```

选择 `Vercel AI Gateway`、`TypeSafe Direct` 或 `Auto-detect`。也可直接指定：

```text
/jev setup vercel
/jev setup typesafe
/jev setup auto
```

- `vercel` / `typesafe` 通过 UI 输入密钥；留空则保留现有凭据，取消则退出。
- `auto` 只保存自动选择偏好，不会索取或生成密钥。
- Provider 偏好写入全局 `jev.json`，密钥写入对应 secret 文件；代码设置 `0600` 权限，在不支持 POSIX 权限的文件系统上仅作尽力处理。
- 密钥输入使用普通 `ctx.ui.input()`，不要假定输入会被掩码；避免在录屏或共享终端中输入密钥，也不要把它放进聊天消息或 slash 命令参数。

### 3. 检查状态与连通性

```text
/jev status
/jev test
```

`status` 只检查配置及会话统计，**不是联网验证**。`test` 会向选中的 Jev 服务发送固定示例，可能产生费用。配置完成后，三个 Jev 工具可按需使用；五项自动/辅助功能默认均关闭。

## Provider 与配置

| 选择 | 默认模型 | 凭据环境变量 | 传输 |
| --- | --- | --- | --- |
| `typesafe` | `jev-latest` | `TYPESAFE_API_KEY` | `@typesafe-ai/sdk` 的 `systemOne()` |
| `vercel` | `typesafe-ai/jev` | `AI_GATEWAY_API_KEY` | 原生 `fetch()` 调用 Gateway evaluation-model 协议 |
| `auto` | 随选中的 Provider | 上述任一变量或其他凭据来源 | 有 TypeSafe 凭据优先 TypeSafe，否则 Vercel |

两个 Provider 都没有凭据时为未配置状态。显式选择的 Provider 缺少凭据，或 `auto` 选中的 Provider 请求失败时，**不会自动改用另一个 Provider**。

### 全局配置与 secret 文件

默认路径如下；设置 `PI_CODING_AGENT_DIR` 可改变此扩展的配置根目录。

```text
~/.pi/agent/
├── jev.json
└── secrets/
    ├── typesafe_api_key
    └── ai_gateway_api_key
```

Vercel 还兼容 `secrets/vercel_ai_gateway_api_key`，优先读取 `ai_gateway_api_key`。

建议将密钥独立保存，`jev.json` 只记录偏好和功能开关。例如以下是**显式启用自动路由**的配置，不是出厂默认值：

```json
{
  "provider": "vercel",
  "features": {
    "auto": true,
    "autoModel": false,
    "toolGuard": false,
    "compact": false,
    "autoAgents": false
  }
}
```

也支持在 JSON 中配置 `typesafe.apiKey` / `vercel.apiKey`，但独立 secret 文件更便于权限和备份管理；两种方式都属于**本地明文存储**。

### 环境变量方式

二选一，在启动 Pi 的 shell 中配置。以下密钥是占位符；真实凭据建议通过 `/jev setup` 或可信的密钥管理方式提供，避免写入 shell 历史。

```bash
export JEV_PROVIDER=vercel
export AI_GATEWAY_API_KEY="YOUR_VERCEL_KEY"
```

```bash
export JEV_PROVIDER=typesafe
export TYPESAFE_API_KEY="YOUR_TYPESAFE_KEY"
```

Provider 选择优先级：

1. 当前 `JevClient` 的会话覆盖值（`/jev provider`，或 `/jev setup` 保存时设置）。
2. `JEV_PROVIDER`，未设置时使用兼容变量 `PI_JEV_PROVIDER`。
3. 全局 `jev.json` 的 `provider`。
4. `auto`。

每个 Provider 内部的密钥优先级：**会话密钥 → 环境变量 → `jev.json` → secret 文件**。

因此 `/jev setup` 新保存的密钥在当前会话优先，但重启后，旧环境变量或 JSON 中的密钥仍可能覆盖 secret 文件。以 `/jev status` 的凭据来源为准。环境变量也会在重启后覆盖保存的 Provider 偏好。

### 模型与端点覆盖

可在 `jev.json` 中加入以下字段（与已有配置合并，不要覆盖需要保留的开关）：

```json
{
  "provider": "vercel",
  "vercel": {
    "model": "typesafe-ai/jev",
    "baseURL": "https://ai-gateway.vercel.sh/v4/ai"
  },
  "typesafe": {
    "model": "jev-latest"
  }
}
```

- 模型优先级：单次请求的 `model` → 对应 Provider 的 JSON `model` → 默认模型。
- TypeSafe 自定义端点：`TYPESAFE_BASE_URL` → `typesafe.baseURL` → SDK 默认值。
- Vercel 自定义端点：`JEV_VERCEL_BASE_URL` → `vercel.baseURL` → `https://ai-gateway.vercel.sh/v4/ai`。
- Vercel 会在根地址后追加 `/evaluation-model`，不要重复写入该后缀。此接口不是 OpenAI Chat Completions 接口。
- 默认模型名会在两种协议间归一化；自定义模型是否可用取决于服务端。
- `/jev status` 当前显示的是 Provider 默认模型，不一定反映 JSON 或单次请求的模型覆盖。

只将端点设为可信地址：请求内容及认证密钥会发送给该地址。

## 三个工具

| 工具 | 行为 |
| --- | --- |
| `jev_find_tools` | 从已经注册但未激活的工具中筛选候选，通过 Jev 判断后增量激活；不会安装工具或移除当前工具。 |
| `jev_find_skill` | 推荐当前 Pi 已发现的技能及路径；不会自动执行技能，需读取 `SKILL.md` 或调用对应技能命令。 |
| `jev_evaluate` | 对 `state` 提交 `choice`、`noul`、`score` 问题，返回结构化结果，而不是自由文本回答。 |

工具和技能筛选的默认阈值为源码常量 `JEV_THRESHOLD = 0.65`，不是环境变量；手动工具调用可传 `threshold` 覆盖。

`jev_evaluate` 的调用参数示例：

```json
{
  "state": {
    "message": "Payment failed because the card expired."
  },
  "questions": {
    "is_billing": {
      "type": "noul",
      "instructions": "Is this a billing issue?"
    },
    "category": {
      "type": "choice",
      "instructions": "Classify the issue.",
      "criteria": {
        "billing": "Payments, invoices, or cards",
        "bug": "Software malfunction",
        "other": "Other requests"
      }
    }
  }
}
```

`noul` 表达是/否概率；`choice` 的 `criteria` 是选项到描述的对象；`score` 的 `criteria` 是评分等级字符串数组。返回答案包含 `type`、`value`，并按服务端响应提供 `confidence` / `distribution` 等字段。概率是模型判断，不能当作事实证明或权限授权。

### 路由的实际边界

先做本地关键词候选筛选，再交给 Jev：工具最多 **10** 个候选，技能最多 **12** 个。关键词按 ASCII 字母和数字拆分；纯中文查询可能取目录中的前几个条目，相关工具若未进入候选集就不会被 Jev 评估。可在查询中补充工具名或英文技术关键词。

未配置或请求失败时，手动工具路由不激活任何候选；技能查询可返回关键词匹配结果，概率记为 `0` 并标记 fallback，并非有效的 Jev 概率。未配置时，自动路由整体跳过。

## 命令与功能开关

| 命令 | 作用 / 持久性 |
| --- | --- |
| `/jev`、`/jev status` | 查看 Provider、凭据来源、功能状态及成功请求统计。 |
| `/jev setup [auto\|typesafe\|vercel]` | 交互配置，保存到全局。 |
| `/jev provider [auto\|typesafe\|vercel]` | 查看或切换 Provider，修改保存到全局。 |
| `/jev test` | 向 Jev 发送固定示例。 |
| `/jev test <prompt>` | 先调用 Pi 当前聊天模型设计问题，再调用 Jev；两者都需要凭据，均可能计费。 |
| `/jev skills [query]` | 无参数列出技能，有参数筛选技能。 |
| `/jev enable`、`/jev disable` | 只改变三个 Jev 工具的激活状态，并保存到全局。 |
| `/jev auto [on\|off]` | 每次 prompt 前自动路由工具和推荐技能。 |
| `/jev auto-model [on\|off]` | 按本地任务规则选择 Pi 聊天模型，不调用 Jev 判断模型。 |
| `/jev tool-guard [on\|off]` | 用 Jev 判断工具参数是否疑似虚构，并辅助分类工具错误。 |
| `/jev compact [on\|off]` | 在 Pi 压缩上下文时提供 Jev 筛选的历史摘录。 |
| `/jev auto-agents [on\|off]` | 开关自动 agent 编排。 |
| `/jev agents <task>` | 显式提交编排任务，需要兼容的 `pi-subagents`。 |
| `/jev help` | 查看内置帮助。 |

五个功能开关无参数时是**切换**，不是查询；修改立即生效，并保存为之后所有项目/会话的全局默认值。保存失败会提示，当前会话的修改仍然有效。

`/jev provider` 和 `/jev enable` / `/jev disable` 现在也会立即持久化。工具激活状态保存在 `jev.json` 的 `toolsEnabled` 中，启动或重载时恢复，没有凭据时也生效；不改变其他工具或自动功能开关。未保存 `toolsEnabled` 时保留 Pi 原始工具选择。设置是全局的，不是按项目隔离；重启后现有环境变量覆盖仍优先。

| JSON 字段 | 环境变量 | 启动参数 |
| --- | --- | --- |
| `features.auto` | `PI_JEV_AUTO` | `--jev-auto` |
| `features.autoModel` | `PI_JEV_AUTO_MODEL` | `--jev-auto-model` |
| `features.toolGuard` | `PI_JEV_TOOL_GUARD` | `--jev-tool-guard` |
| `features.compact` | `PI_JEV_COMPACT` | `--jev-compact` |
| `features.autoAgents` | `PI_JEV_AGENTS` | `--jev-agents` |

未配置的开关默认 `false`。环境变量接受 `1/true/yes/on` 与 `0/false/no/off`，覆盖保存的启动默认值；Pi 的对应 CLI flag 可进一步覆盖启动值。

**当前自动模型选择和自动 agent 编排都在 `auto` 的事件入口内，因此还需 `/jev auto on`。** 显式 `/jev agents <task>` 不要求打开 `auto` 或 `auto-agents`。

自动路由分别请求工具和技能判断，两类均有候选时会发起 **2 次 Jev 调用**，不是固定每次 prompt 1 次；tool guard、编排和压缩还可能增加请求。

已有权限系统或专用压缩器时，可从以下组合开始：

```text
/jev enable
/jev auto on
/jev auto-model off
/jev tool-guard off
/jev compact off
/jev auto-agents off
```

`/jev disable` **不是总停用开关**，不会关闭事件钩子。要停止这些自动功能，应将上面五个开关都设为 `off`；完全卸载则使用 `pi remove` 并重启 Pi。

## 可选集成与限制

### Agent 编排

通过 `subagents:rpc:v1:request` 事件协议与兼容的 `pi-subagents` 集成；这个扩展**不包含子代理执行器**。根据工作流需提供 `scout`、`worker`、`reviewer`、`researcher`、`evidence-auditor` 等 agent 定义。无兼容监听器时，提交约 10 秒后超时。

Jev 用于选择 implementation / research / review / general 工作流；未配置或判断失败时退回本地关键词分类。`agent: "jev"` / `"typesafe-jev"` 则处理结构化判断请求，不是通用编码 agent。

### Tool guard 与压缩

- Tool guard 仅看工具名与参数，并不验证文件实际存在；疑似虚构概率达到 `0.85` 时阻止调用。评估异常时**放行**，所以它不能替代沙箱、权限控制或确定性校验。
- 压缩当前只考虑 `branchEntries` 的**前 24 条**，每条序列化后截取 **900 字符**，保留阈值为 `0.55`。这是有限摘录，不是完整语义摘要；长会话应谨慎启用，避免遗漏关键上下文。

### Gate CLI

包声明了 `pi-jev-gate` 和 `jev-gate` 两个 bin，评估传入文本/文件/diff 是否满足标准，默认通过阈值 `0.7`。它不会实际运行测试，也不会从模型概率证明测试通过。

**当前打包限制：** `bin/jev-gate.js` 固定使用 `node --import tsx` 启动，但 `package.json` 没有声明 `tsx` 依赖，不能假定全新安装后 CLI 可直接运行。需要使用 CLI 时，可在源码目录显式准备加载器：

```bash
npm install
npm install --no-save --package-lock=false tsx
node ./bin/jev-gate.js --help
node ./bin/jev-gate.js --criteria "The supplied text explains installation and configuration." --file README.zh-CN.md --json
```

最后一条会把文件内容发送到选中的 Jev 服务。支持 `--diff`（读取 `git diff HEAD`，不含未跟踪文件）、`--file` 和 stdin。正常评估通过退出 `0`，不通过退出 `1`，runner 捕获的配置/API 等异常退出 `2`；`--fail-open` 会将捕获的异常改为成功退出，不宜用于强制验收。启动器自身异常不应被当作有效判定。

CLI 创建独立的 `JevClient`，读取环境变量和全局配置，包括 `/jev provider` 成功保存的选择，但不继承另一 Pi 进程的内存覆盖值。

## 代码结构

| 路径 | 职责 |
| --- | --- |
| [`extensions/index.ts`](extensions/index.ts) | 注册工具、命令、启动参数和生命周期钩子。 |
| [`src/jev.ts`](src/jev.ts) | Provider/凭据解析、全局配置、两种传输和响应归一化。 |
| [`src/router.ts`](src/router.ts)、[`src/skills.ts`](src/skills.ts)、[`src/auto.ts`](src/auto.ts) | 候选筛选、增量激活、技能推荐和自动调度。 |
| [`src/tools.ts`](src/tools.ts)、[`src/commands.ts`](src/commands.ts) | 工具参数与 `/jev` 命令。 |
| [`src/designer.ts`](src/designer.ts) | 使用当前 Pi 模型设计结构化评估问题。 |
| [`src/model-router.ts`](src/model-router.ts) | 本地模型选择及部分 HTTP 错误后的短期避让。 |
| [`src/agent.ts`](src/agent.ts)、[`src/orchestrator.ts`](src/orchestrator.ts) | Jev agent RPC 和多 agent 工作流。 |
| [`src/tool-guard.ts`](src/tool-guard.ts)、[`src/compact.ts`](src/compact.ts) | 可选参数判断及有限历史压缩。 |
| [`src/gate.ts`](src/gate.ts)、[`bin/jev-gate.js`](bin/jev-gate.js) | 评估型 CLI gate 与启动器。 |

## 开发与验证范围

```bash
git clone https://github.com/0x1f/pi-jev-multi-provider.git
cd pi-jev-multi-provider
npm install
npm run typecheck
npm test
```

包另有 `npm run smoke`，它会启动 Pi 并发送 prompt，可能使用本机模型凭据、触发网络请求和费用；不是离线单元测试。`typecheck` 当前不覆盖 `bin/jev-gate-runner.ts`。`npm test` 使用临时配置目录和全新子进程运行离线持久化回归测试，不使用真实凭据。本版未附依赖锁文件。

本次文档整理依据源代码静态核对，并非 TypeSafe/Vercel 实网兼容性或安全性认证；没有运行付费推理、`smoke` 或编排任务。部署前请在自己的受控环境中验证所选 Pi 版本和 Provider。
