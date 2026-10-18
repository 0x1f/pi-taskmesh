# pi-taskmesh

[English](README.md) | **简体中文**

面向 Pi 的任务感知、多模型编排扩展，版本 **0.7.0**。项目从现有 pi-jev-multi-provider 演进：TaskMesh 负责拆解任务、选模型和协调执行；Jev 成为可选判断后端，原有功能继续兼容。

默认直接使用 Pi 中已经认证的聊天模型，**不需要 Jev Key**。本项目不注册聊天 provider，也不内置子代理执行器。

## 快速开始

从 GitHub 安装：

```bash
pi-bolt install git:github.com/0x1f/pi-taskmesh
```

上游 Pi 用户将 `pi-bolt` 换成 `pi`。安装后重启或 `/reload`。本地验证可在源码目录执行 `pi-bolt -e ./extensions/index.ts`，无需全局安装；远程安装时应固定实际已发布的提交。

准备支持 `subagents:rpc:v1` 的兼容 `pi-subagents` 扩展、已认证的 Pi 模型，以及计划需要的代理定义：`scout`、`researcher`、`worker`、`reviewer`、`evidence-auditor`。先做一次明确授权的任务：

```text
/taskmesh run 重构请求解析器，验证行为，并独立审查最终 diff
/taskmesh status
/taskmesh explain
```

自动委派默认关闭。要持续允许自动编排：

```text
/taskmesh on
请检查这个项目，实现请求的修改并验证、审查。
/taskmesh resume
/taskmesh off
```

`on` 将用户的自动委派选择保存为全局默认，跨项目、跨会话生效，授权对合适的后续任务进行拆解和子代理执行。模型判断 `team` 只说明适合拆分，不授予删除数据、发布或远程修改等权限。当前请求禁止委派时仍以当前请求为准。`off` 关闭后续自动委派；已有任务继续运行，显式 `run` 仍可使用。

## 命令与配置

| 命令 | 行为 |
| --- | --- |
| `/taskmesh on`、`/taskmesh off` | 保存全局自动委派开关。 |
| `/taskmesh run <任务>` | 主代理空闲时，明确授权并启动一个工作流。 |
| `/taskmesh status` | 显示配置，存在任务时查询原生运行状态。 |
| `/taskmesh explain` | 查看最近判断、任务图、模型、选型依据与启动状态。 |
| `/taskmesh resume` | 重新连接已有任务、查询状态，不创建新任务图。 |
| `/taskmesh help` | 显示用法。 |

配置保存在 `~/.pi/agent/taskmesh.json`；设置 `PI_CODING_AGENT_DIR` 时使用该目录。默认值：

```json
{
  "enabled": false,
  "decisionBackend": "pi",
  "maxConcurrency": 3
}
```

`maxConcurrency` 控制并发读任务数，范围 1–3；写任务独占共享工作目录。配置 Jev 后才能将 `decisionBackend` 改为 `jev`。手动编辑后重新加载扩展。命令以原子替换保存、保留无关字段，并报告保存错误；配置损坏时自动模式关闭，修复后才能开启。

可以使用 `PI_TASKMESH=1` 或 `--taskmesh` 明确开启；`PI_TASKMESH=off` 会在重启后覆盖保存值。旧 `jev.json.features.autoAgents`、`PI_JEV_AGENTS` 和 `--jev-agents` 不再初始化新核心；交互式 `/jev auto-agents on|off` 仍作为兼容命令保存 TaskMesh 开关。自动编排不依赖 `/jev auto` 或 `/jev auto-model`。并发保存采用最后写入者胜出，原子替换防止文件写到一半，不保证多个进程同时更新不丢修改。

### 在 Pi 中使用 Jev 参与编排判断

在 Pi 中执行 `/jev setup typesafe` 或 `/jev setup vercel`，再用 `/jev status` 检查配置。将 `~/.pi/agent/taskmesh.json` 中的 `"decisionBackend"` 改为 `"jev"`，保留其他设置。重新加载；如果需要自动编排，再开启自动模式：

```text
/reload
/taskmesh on
/taskmesh status
```

Jev 判断合适的请求是否需要委派，并为各子任务选择模型；Pi 聊天模型仍负责生成任务计划，原生 `pi-subagents` 负责执行子代理。`/jev agents <任务>` 与 `/taskmesh run <任务>` 使用同一个 TaskMesh 判断后端，不必给每个子代理单独接入 Jev。切换判断后端不会开启 Jev 工具路由、参数检查或压缩。Jev 判断和 Pi 模型调用均可能计费。

## 判断、路由与执行边界

1. 对符合条件的纯文本输入判断 `solo`、`team`、`resume` 或 `uncertain`。简单或不确定的输入通常交回主代理；已有任务运行时，不确定的继续请求只显示状态。常见中英文禁止委派表述直接绕过分类器。图片、扩展消息和流式追加输入沿用正常通路。
2. Pi 根据本次请求、最多 10,000 字符的近期公开对话和最多 6,000 字符的近期 Goal 生成 **1–6 个任务**。不包含 thinking 和工具结果。验证依赖存在、图无环，以及每个写任务之后有依赖于它的审查任务。
3. 每个任务从会话 scope 内、已认证且满足估算上下文要求的模型中选定明确的 `provider/model`。默认 Pi JSON 判断，可选 Jev choice 判断；每任务最多比较 16 个候选，依据需求、reasoning/上下文元数据、负载和已有执行回执。判断失败时使用元数据与负载评分回退。这些是选型估计，**不是编码能力基准测试**。条件适合时鼓励审查模型不同，但不强制模型多样性。
4. 使用原生 `pi-subagents` 执行脚本。读任务可并行，worker 独占共享 cwd，后续节点收到依赖结果。只读提示词不等于操作系统权限或沙箱。子代理使用有界上下文，不复制完整历史。
5. 已报告的认证、额度、限流等失败只冷却对应 `provider/model`，不屏蔽同一网关下的其他模型。成功/失败回执不等于质量评分，重新加载后计数与冷却重置。

每次纯 Pi 推理最多尝试两个模型，每次限时 30 秒。规划、选型发生在子任务启动前。**子任务失败或启动结果未知时，不自动重放执行。** 没收到启动回执时保留请求 ID 并阻止重复派发，直到原生状态或完成事件给出确定结果。新会话记录使用 `taskmesh-orchestration`，仍可恢复旧 `jev-orchestration` 记录。

原生执行器负责执行、完成通知和结果交付。`resume` 用于连接和查看，不重启失败/暂停的工作流，也不重放未确认的副作用；保留子任务的继续操作使用原生执行器的显式控制。没有兼容执行器时，能力检查约 10 秒失败，不启动子代理。

自动模式即使最终决定保持 solo，也可能产生一次 Pi 判断费用。委派通常增加判断、规划和选型调用，再加子代理调用；有限重试和另外启用的 Jev 功能也可能增加费用。项目没有费用硬上限，也不进行实时能力跑分。

## Jev 兼容命令

Jev 工具与自动功能默认关闭，已有明确偏好会保留。需要时使用 `/jev setup` 配置、`/jev status` 检查、`/jev enable` 启用三个工具。`/jev test` 会发送真实样例并可能计费。密钥输入框不保证遮蔽，不要把 Key 放入聊天或命令参数。

| 命令 | 用途 |
| --- | --- |
| `/jev setup [auto\|typesafe\|vercel]` | 保存 provider 选择并按需配置密钥。 |
| `/jev provider [auto\|typesafe\|vercel]` | 查看或修改全局 provider。 |
| `/jev enable`、`/jev disable` | 保存 Jev 工具启用状态，保留无关工具。 |
| `/jev test [prompt]` | 真实连通性/判断测试；提供 prompt 时还调用 Pi 模型。 |
| `/jev skills [query]` | 列出或搜索既有技能。 |
| `/jev auto [on\|off]` | Jev 工具与技能路由。 |
| `/jev auto-model [on\|off]` | 独立的主代理本地模型选择。 |
| `/jev tool-guard [on\|off]`、`/jev compact [on\|off]` | 可选参数检查与历史片段选择。 |
| `/jev auto-agents [on\|off]` | TaskMesh 自动委派兼容开关。 |
| `/jev agents <任务>` | 显式派发兼容入口。 |
| `/jev schedule explain`、`/jev schedule status` | 兼容调度诊断入口。 |

旧功能命令省略 `on`/`off` 会切换开关；查看状态请用 `/jev status`。除 TaskMesh 独立偏好外，旧设置继续保存于 `jev.json`。`/jev disable` 只隐藏工具，自动功能需要分别关闭。`PI_JEV_AUTO`、`PI_JEV_AUTO_MODEL`、`PI_JEV_TOOL_GUARD`、`PI_JEV_COMPACT` 及对应 `--jev-*` 参数继续覆盖保存的启动值。布尔值接受 `1/true/yes/on` 和 `0/false/no/off`。

TypeSafe SDK 已改为可选依赖、按需加载，默认 Pi 通路不依赖它。Jev 选定传输失败后不会自动改用其他传输。

## 可选 Jev：Provider、配置与工具

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

## 代码与验证

| 路径 | 职责 |
| --- | --- |
| [extensions/index.ts](extensions/index.ts) | 集成、事件钩子与兼容功能。 |
| [src/taskmesh-config.ts](src/taskmesh-config.ts)、[src/taskmesh-commands.ts](src/taskmesh-commands.ts) | 独立配置与命令。 |
| [src/decision-backend.ts](src/decision-backend.ts) | Pi/可选 Jev 判断、JSON 验证与有限纯推理重试。 |
| [src/task-planner.ts](src/task-planner.ts)、[src/capability-router.ts](src/capability-router.ts) | 上下文、任务图验证与模型分配。 |
| [src/orchestrator.ts](src/orchestrator.ts) | 原生脚本、RPC 关联、状态恢复与防重派。 |
| [src/jev.ts](src/jev.ts) | 旧凭据解析与可选 Jev 传输。 |

```bash
npm ci --ignore-scripts
npm run typecheck
npm test
npm run test:native  # 需要已安装的兼容 pi-subagents
npm run smoke        # 需要 pi-bolt，仅做私有配置离线加载
```

锁文件固定开发依赖，含 Pi SDK 0.85.0；针对该 SDK 类型检查通过，不代表兼容所有 Pi 版本。扩展声明 Node >=20.3，宿主可能需要更高版本。原生测试可通过首个参数或 `PI_SUBAGENTS_DIR` 指定包目录。

验证使用合成数据、假的模型/执行器回执、跨进程配置检查、已安装原生工作流验证器/沙箱加本地假子任务，以及私有离线配置中的真实 Pi-Bolt 加载。smoke 阻止网络调用，不调用模型。还在实际移除可选 TypeSafe SDK 后验证了运行时回归与真实宿主加载。`typecheck` 仍不包含旧 Gate runner。这些检查验证本地合同，不能证明真实 provider 兼容性、模型质量或付费子代理端到端效果。
