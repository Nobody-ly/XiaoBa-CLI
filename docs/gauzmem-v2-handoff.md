# GauzMem V2 实现封存与后续开发说明

本文用于封存当前 `gauzmem-memory-v2` 分支上的 GauzMem 实现思路、代码结构、数据流、已知问题与后续改进方向，方便后续重新接手时快速恢复上下文。

## 当前定位

GauzMem V2 是 XiaoBa-CLI 的外部长期图记忆模块。它不是替代主 Agent 上下文，而是作为旁路记忆系统：

- 记录完整会话 source journal，避免上下文压缩导致原始信息丢失。
- 后台将会话内容构造成 evidence graph。
- retriever 在用户输入时从 graph 中找相关记忆。
- 可选择把 recall prompt 作为 transient block 注入主 Agent。
- 即使关闭“记忆辅助注入”，后台仍可继续 source 收集和 construct，用于灰度验证与 A/B 数据积累。

当前实现更适合称为 evidence graph memory：

- node 是独立事实句。
- edge 是两个事实之间的中文关系句。
- state 记录 node/edge 的 score、selected/rejected 次数、遗忘状态。

## 核心文件

- `src/gauzmem/service.ts`
  - GauzMem 主服务，负责 recall、construct 调度、run 记录、snapshot、dashboard settings。
- `src/gauzmem/graph-store.ts`
  - node/edge/state 的 JSONL 存储、去重、score 更新、衰减、graph scan、disclose。
- `src/gauzmem/reasoner.ts`
  - 所有 LLM reasoner 调用。使用内部 submit tool 结构化输出，不使用 MiniMax 不兼容的 `output_config.format`。
- `src/gauzmem/source-journal.ts`
  - 将每轮 user/assistant/tool 信息写入独立 source journal，并提供 source window 搜索。
- `src/gauzmem/paths.ts`
  - GauzMem 数据文件路径。
- `src/tools/gauzmem-search-tool.ts`
  - 主动搜索工具。
- `dashboard/gauzmem.html`
  - GauzMem Dashboard。
- `src/dashboard/routes/gauzmem.ts`
  - Dashboard API 路由。

## 数据位置与文件

当前代码路径由 `src/gauzmem/paths.ts` 计算：

- `getGauzMemRoot() = path.resolve(process.cwd(), 'data', 'gauzmem')`
- `getGauzMemSourceDir() = path.resolve(process.cwd(), 'data', 'session-memory', 'gauzmem')`
- `getGauzMemStoreDir() = getGauzMemRoot()/store`

重要风险：

- 当前实现仍依赖 `process.cwd()`。
- dev/prod 下如果 cwd 不同，数据可能落到 D 盘项目目录或 AppData 对应目录。
- 上线前应再次确认 Electron 启动时 cwd/user data 目录策略，最好统一到 XiaoBa 的 app data 目录。

主要文件：

- `data/session-memory/gauzmem/session_messages.jsonl`
  - 长期 source journal。
  - 不应随着 graph store 清理一起删除。
- `data/gauzmem/store/nodes.jsonl`
  - node 追加式记录，同一 nodeId 可多次出现，读取时按 id 取最后版本。
- `data/gauzmem/store/edges.jsonl`
  - edge 追加式记录，同一 edgeId 可多次出现，读取时按 id 取最后版本。
- `data/gauzmem/store/node_state.jsonl`
  - node score/state 追加日志。
- `data/gauzmem/store/edge_state.jsonl`
  - edge score/state 追加日志。
- `data/gauzmem/store/runs.jsonl`
  - GauzMem run 日志，记录 recall/construct 的关键过程。
- `data/gauzmem/store/graph_snapshots.jsonl`
  - recall 前轻量 graph snapshot。
- `data/gauzmem/store/construct_artifacts.jsonl`
  - construct 的完整输入、LLM patch、apply result。

## Runtime 接入语义

### 开关

- `GAUZMEM_ENABLED`
  - 内部部署开关。默认实现中 `isEnabled()` 只在显式 `0/false/no/off` 时关闭。
  - 不应该作为用户界面的“记忆是否启用”感知开关。
- `gauzmem.promptInjectionEnabled`
  - 用户态“记忆辅助”开关。
  - true：recall 成功时把 `[transient_gauzmem_recall]` 注入主 Agent。
  - false：仍可后台 recall/construct/记录 run，但不注入 prompt。
- `GAUZMEM_PROMPT_INJECTION=false`
  - 环境变量强制覆盖记忆辅助注入。

### scope

当前支持：

- `global`
  - graph 跨 session 可见。
- `session`
  - 按 sessionKey 过滤可见 graph。

相关环境变量：

- `GAUZMEM_SCOPE`
- `GAUZMEM_SESSION_ALLOWLIST`
- `GAUZMEM_SESSION_TYPE_ALLOWLIST`

## Source Journal

写入位置：`GauzMemSourceJournal.appendTurn()`

每轮记录：

- user input
- assistant text
- tool_call
- tool_result
- final assistant response 如果未出现在 newMessages 中会补写

会跳过：

- `message.__injected`

record 字段核心：

- `sourceId`
- `sessionKey`
- `sessionType`
- `turnId`
- `role`
- `blockType`
- `text`
- `timestamp`
- `toolCall`
- `sourceRef`

当前 source journal 已取消早期 6000 字截断设计，适合后续 A/B 从完整 source 重建输入。

## Graph Store

### Node

node 是 evidence fact。当前 node 创建来自：

- construct graph patch
- 旧流程里的 evidence extraction 残留能力

node 去重：

- canonical exact id：`gzn_ + stableHash(canonicalText)`
- near duplicate：`NEAR_DUPLICATE_THRESHOLD = 0.86`
- 命中已有 node 时追加 evidenceRefs，不创建新 node。

### Edge

edge 是两个 node 间的事实关系。

edge id：

- 无向端点排序后 hash：`gze_ + stableHash(left:right:edgeText)`

edge 文本当前规范化：

- 中文短关系句。
- normalize 会清理英文模板等噪音。

### Score 与遗忘

初始分：

- `INITIAL_SCORE = 0.45`

正常检索线：

- `NORMAL_RETRIEVAL_THRESHOLD = 0.1`

深度线：

- `DEEP_RETRIEVAL_THRESHOLD = -0.45`

加减分：

- selected node：`+0.12`
- rejected node：`-0.01`
- selected edge：`+0.08`
- rejected edge：`-0.015`

衰减：

- `DECAY_LAMBDA = 0.08`
- `DECAY_FLOOR = -0.2`
- 每次 recall 会按 turn 进行衰减。

faded：

- state score 低于 deep threshold 后 `faded = true`。
- faded 不参与正常 graph scan/disclose。

## Retriever 当前流程

入口：`GauzMemService.recall()`

当前流程：

1. 判断 enabled / session allowed。
2. 提取最近上下文：
   - current user input
   - previous user
   - previous assistant final reply
3. LLM `buildQueryPlan()`：
   - 输出 `{ rootQuery, searchTerms }`
   - searchTerms 用于 grep。
4. 保存 recall 前 graph snapshot。
5. `applyRecallDecay()` 对现有 state 做遗忘衰减。
6. 读取 normal retrievable graph，并按 scope 过滤。
7. `graphScan(searchTerms)`：
   - node text 命中任一 term。
   - edge text 命中任一 term。
   - edge 命中会把 from/to 端点 node 加入候选。
8. `compressRelevanceCandidates()`：
   - 当前方案 A：term 保护式候选压缩。
9. LLM `selectRelevant()`：
   - 只判断压缩后的 grep candidates。
   - selected 按 usefulness 降序。
   - omitted 自动视为 rejected。
10. `applySelection()`：
   - selected 加分。
   - rejected 轻扣分。
11. `discloseSelectedContext()`：
   - 从 selected node + selected edge 两端 node 做一跳。
   - 当前实现为完整一跳。
12. `buildPromptBundle()`：
   - 生成 transient recall prompt。
   - “记忆辅助”关闭时只记录 run，不注入。
13. 写入 `runs.jsonl`。

### 方案 A 候选压缩

目标：降低 relevance 输入量，但保留高信号 term 覆盖。

硬上限：

- `MAX_RELEVANCE_NODES = 48`
- `MAX_RELEVANCE_EDGES = 24`

term 频率：

- normal：`ratio < 0.10`
- high：`0.10 <= ratio < 0.20`
- very_high：`ratio >= 0.20`

高频 only 限流：

- single + very_high：每 term 最多 5
- single + high：每 term 最多 8
- multi + highOnly：每轮最多 8，含 very_high 时最多 5

最终收口：

1. 每个 normal/mixed term 尽量保留 1 个最高 priority 候选。
2. 有预算时每个 normal/mixed term 再保留第 2 个。
3. 剩余预算按 priority 补位。
4. dropped candidates 不进入 rejected，不扣分。

priority 信号：

- normal term boost
- multi-term boost
- direct hit boost
- score / selectedCount / recency
- moderate degree tiny boost
- endpoint-only penalty
- high-only single penalty
- hub penalty

## Construct 当前流程

Construct 已从早期 query-time root/node construct 改为后台 maintainer。

调度：

- 当前常量：`CONSTRUCT_NEW_TURN_COUNT = 1`
- `CONSTRUCT_CONTEXT_TURN_COUNT = 2`
- source journal 写入后 fire-and-forget 调度 construct。
- 主 Agent 不等待 construct。

输入：

- 最近 2 个 turn source。
- 当前 graph context。
- 上轮 construct / 本轮 retriever 子图相关能力曾讨论过，当前代码请以 service.ts 实际实现为准。

LLM：

- `reasoner.buildGraphPatch()`
- 使用内部 submit tool：`submit_gauzmem_graph_patch`

Patch schema：

- `batchSummary`
- `nodes: [{ tempId, text, sourceIds }]`
- `edges: [{ from, to, text, sourceIds? }]`
- `merges?: [{ tempId, existingNodeId }]`
- `skipped?: string[]`

Apply：

- temp node upsert 成真实 node。
- merge 合法则追加 source refs。
- edge 端点重定向。
- 自环、空文本、非法端点、泛关系会被跳过并记录 warning。

Construct run：

- `runs.jsonl` 记录摘要。
- `construct_artifacts.jsonl` 记录完整输入、raw patch、apply result。

## Reasoner 与结构化输出

当前不使用 Anthropic `output_config.format`。

原因：

- MiniMax/BuildSense Anthropic-compatible endpoint 对 `output_config` 支持不稳定或直接报错。
- 普通 JSON text 易出现截断、空响应、非 JSON。

当前方案：

- 每个 step 定义内部 submit tool。
- 强制或引导模型调用指定 submit tool。
- 从 tool call input 获取结构化对象。
- 每个 step 最多 retry 5 次。

工具：

- `submit_gauzmem_query_plan`
- `submit_gauzmem_relevance`
- `submit_gauzmem_evidence`
- `submit_gauzmem_parent_terms`
- `submit_gauzmem_graph_patch`

## Dashboard 当前能力

入口：GauzMem Dashboard。

主要展示：

- 记忆辅助开关。
- source/node/edge/run/faded 数量。
- LLM provider/model/base/timeout/thinking 状态。
- runs 列表。
- Run Replay。
- Persistent Graph。
- Probe LLM。

图展示：

- normal / deep / all 视图。
- node 颜色按簇，明暗/灰度按 score。
- hovered node/edge 显示 tooltip。
- faded/低分视图有不同显示策略。

已讨论但未完全理想：

- Dashboard run 详情还可进一步简化。
- construct run 与 recall run 的展示逻辑仍有历史字段痕迹。
- graph layout 可继续参考 Obsidian/force-directed 社区布局。

## 当前 graph 质量观察

最近正常线 edge 统计：

- 正常线 edge 约 322。
- 优秀关系词约 108，约 33.5%。
- 可用关系词约 124，约 38.5%。
- 泛关键词约 8，约 2.5%。
- 其他标签约 82，约 25.5%。

说明：

- 当前 construct 已经很少生成“同主题/同场景/相关”这种泛 edge。
- edge 整体质量中上。
- 主要问题不是 edge 数量少，而是 one-hop full disclose 会把低相关边也带出。

优秀关系词示例：

- `约束`
- `因果`
- `结果`
- `风险`
- `确认`
- `推断`
- `路径`
- `条件`
- `目标`
- `触发`
- `局限`

可用关系词示例：

- `补充`
- `计划`
- `执行`
- `背景`
- `细节`
- `恢复`
- `说明`
- `关联`

泛关键词示例：

- `相关`
- `涉及`
- `关系`
- `信息`
- `内容`
- `分析`
- `同主题`
- `同场景`
- `同角色`

## 已知问题

### 1. 路径仍依赖 process.cwd()

`paths.ts` 目前没有直接绑定 XiaoBa app data。

风险：

- dev/prod 数据位置可能不一致。
- D 盘 workspace 与 AppData 数据混用。

建议上线前修正为统一依赖 app data 路径。

### 2. Retriever 仍偏慢

主要耗时：

- query build LLM。
- relevance LLM。

方案 A 已将 relevance candidates 控制到 48/24，但如果模型慢仍会 10s+。

后续可考虑：

- promptInjection=false 时 recall 完全异步，不阻塞主 Agent。
- query build 轻量化或缓存。
- relevance 模型换更快模型。
- 少量 deterministic 过滤进一步压缩 candidates。

### 3. One-hop full disclose 噪声偏多

当前 selected 后完整一跳在大图上可能带出 50+ edges。

最近模拟显示：

- full one-hop 有效比例约 55%-80%。
- 按 edge quality 排序后 top16/top24 有效率可接近 90%。

建议下一步改为 edge-quality filtered one-hop。

### 4. Edge 关系词没有正式分类系统

当前 edge 标签由 LLM 自由生成。

优点：

- 表达自由。
- construct 质量较自然。

缺点：

- retriever 排序要处理新标签。

短期建议：

- 小 seed list 做 soft boost。
- unknown 不惩罚。
- 记录 prefix stats。

### 5. Construct 失败批次的处理需要更严格

曾讨论：

- LLM/API 失败不应造成后续 construct 卡死。
- 失败批次不应被静默消费造成记忆缺口。

需要检查当前实现是否已经满足：

- 失败 batch 是否保留待重试。
- 新 batch 到来时是否串行排队。
- LLM 连接错误是否重试。

### 6. Rejected 惩罚仍需观察

当前 rejected 是轻惩罚：

- node `-0.01`
- edge `-0.015`

由于 grep 召回大而 selected 少，长期可能有“误召回导致扣分”的风险。

当前方案 A dropped 不扣分，这已经缓解。

## 后续改进路线

### A. Edge-quality one-hop

目标：

- 保留 selected 邻域的高质量关系。
- 降低 prompt 噪声。

建议流程：

1. selected node + selected edge 两端作为 anchors。
2. collect full adjacent edges。
3. 对 edge 排序：
   - selected anchor 连接。
   - edge text 命中 searchTerms。
   - relation prefix quality。
   - edge score / selectedCount。
   - endpoint node score。
   - recency/stable id。
4. 默认保留 top 24 edges。
5. nearby nodes 由保留 edges 两端自然带出。
6. one-hop 不参与 selected/rejected 和 weight changes。

关系词只做 soft prior：

- 强关系：`约束 / 因果 / 结果 / 风险 / 确认 / 推断 / 路径 / 条件 / 目标 / 触发 / 局限`
- 中关系：`补充 / 计划 / 执行 / 背景 / 细节 / 恢复 / 说明 / 关联`
- 泛关系：`相关 / 涉及 / 关系 / 信息 / 内容 / 分析 / 同主题 / 同场景 / 同角色`
- unknown：中性，不惩罚。

### B. Construct prompt 轻约束 edge

不要强制枚举标签。

建议规则：

- edge text 必须是中文短关系句。
- 必须说明两个事实之间的具体关系。
- 优先使用具体关系词，如 `约束/因果/结果/风险/确认/路径/条件`。
- 允许使用更贴切的新标签。
- 禁止 `同主题/同场景/同角色/相关/有关/涉及`。

### C. Prefix stats

为每种 edge prefix 记录：

- selected 次数。
- rejected 次数。
- one-hop 后进入 prompt 次数。
- 平均 edge score。
- 最近 N 次表现。

短期只展示，不自动改词表。

后续可做 dreaming 建议：

- 哪些 unknown prefix 应升为 strong/useful。
- 哪些 prefix 应降权。

### D. Construct 队列可靠性

上线前建议实现或确认：

- construct pending queue 按 turn 顺序处理。
- LLM/API 失败的 batch 不丢失。
- 成功后再标记 consumed。
- 失败 run 明确记录 not applied。
- construct 不阻塞主 Agent。

### E. A/B 测试支持

当前数据基本支持粗粒度 A/B：

- source journal 有完整 user/assistant/tool 内容。
- runs 有 query、terms、selected、prompt、weightChanges、snapshotId。
- graphSnapshots 有 normal/deep id + score。
- constructArtifacts 有 construct 输入输出。

可进一步增强：

- 每轮记录 final answer sourceId。
- 记录当轮实际 GauzMem prompt。
- 记录 context reduction policy。
- 定期或每轮保存 graph state snapshot。

当前阶段如果目标是“砍上下文后，有 GauzMem vs 无 GauzMem 的效果差异”，基本够用。

### F. Dashboard 整理

建议把 Dashboard 面向用户分成：

- 状态：记忆辅助、后台学习状态、统计。
- Runs：只展示核心信息。
- Graph：主视图。
- Debug details：折叠。

Recall Run Replay 最小信息：

- rootQuery。
- searchTerms。
- selected memory text。
- final prompt。

Construct Run Replay 最小信息：

- created nodes。
- created edges。
- merged nodes。
- skipped/warnings。

## 继续开发优先级建议

如果短期要上线：

1. 修正/确认路径统一到 AppData。
2. 确认 promptInjection=false 时不阻塞主 Agent。
3. 确认 construct 失败不会丢 batch。
4. 保留当前 scheme A candidate compression。
5. Dashboard 保持简单，默认不暴露内部 scope/allowlist。

如果继续优化检索效果：

1. 实现 edge-quality one-hop top24。
2. construct prompt 轻约束 edge relation text。
3. 加 prefix stats。
4. 观察 1-2 天 runs 后再调整词表和 topN。

如果继续优化构图：

1. 加 dreaming repair，但只做离线/后台。
2. dreaming 任务：
   - merge duplicate nodes。
   - link near source-neighbor nodes。
   - repair hub/spoke edges。
   - classify edge prefixes。
3. 不让 dreaming 直接影响主 Agent 回复，先只写建议或低风险 patch。

## 快速排查命令

查看 store：

```powershell
Get-ChildItem C:\Users\28119\AppData\Roaming\xiaoba-cli\data\gauzmem\store
```

查看最近 runs：

```powershell
Get-Content C:\Users\28119\AppData\Roaming\xiaoba-cli\data\gauzmem\store\runs.jsonl -Tail 5
```

查看 source journal：

```powershell
Get-Content C:\Users\28119\AppData\Roaming\xiaoba-cli\data\session-memory\gauzmem\session_messages.jsonl -Tail 5
```

构建验证：

```powershell
npm run build
```

GauzMem 相关测试：

```powershell
node_modules\.bin\tsx.cmd --test tests\gauzmem-runtime-integration.test.ts tests\gauzmem-graph-store.test.ts tests\gauzmem-source-journal.test.ts
```

