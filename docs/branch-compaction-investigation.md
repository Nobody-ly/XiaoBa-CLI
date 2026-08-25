# Branch 会话压缩调查记录

## 项目目标

研究并改进 branch 机制，用于会话压缩：

1. 会话上下文约达到 60%–70% 时，启动 branch 异步生成压缩结果，并记录启动压缩时的节点。
2. 如果会话未达到 85%，将历史替换为“压缩结果 + 压缩节点之后的新内容”。
3. 如果会话达到 85%，取消之前启动的 branch，直接对最新历史执行串行压缩，再用串行结果替换历史。
4. 当前阶段只做调查和方案沉淀，不开发功能。

## 当前工作分支

`research/branch-compaction-feasibility`

基线：XiaoBa-CLI `main`，初始提交 `4f34dcb`。

## 当前实现事实

### BranchSession

文件：`src/core/branch-session.ts`

- branch 拥有独立 messages、工具执行器、日志和 AbortController。
- branch 可以被取消。
- branch 不会持久化写回父会话 transcript。
- branch 当前是隔离的 agent loop，不是可直接提交的父会话历史快照。

### ObservationBranchSession

文件：`src/core/observation-branch-session.ts`

- 用于向父 runner 发布 synthetic observation。
- 结果通过 `SyntheticObservationQueue` 传递。
- 结果可以当前 turn 注入，也可以延迟到下一 turn。
- 队列支持取消、去重、丢弃和生命周期日志。
- 这种机制的语义是 transient runtime context，不适合直接承载 durable checkpoint 替换。

### Memory branch carryover

文件：`src/core/agent-turn-controller.ts`

- 当前已有 branch carryover。
- branch 结果带有 `originTurn` 和 timing 信息。
- 未消费结果可在取消或 TTL 到期时丢弃。
- 该机制解决的是异步观察结果生命周期，不解决父历史并发改写。

### CheckpointCompactionCoordinator

文件：`src/core/checkpoint-compaction.ts`

- 默认压缩触发线是最大上下文的 80%。
- 支持 `pre_turn`、`mid_turn`、`restore` 三个阶段。
- 支持 `episodeId`，能识别当前 episode。
- 压缩 durable transcript，分离 transient 消息。
- 生成 continuation summary，并保留继续任务所需的用户输入和尾部内容。
- 调用方在压缩成功后整体替换 messages 并持久化；失败时保留原始上下文。

### AgentSession

文件：`src/core/agent-session.ts`

- 恢复、远端历史补入等路径会调用 checkpoint 压缩。
- 持久化前会去除 transient 消息和 assistant artifacts。
- 当前压缩调用是串行流程，没有与异步 branch candidate 协调的提交协议。

## 可行性结论

方案方向有条件可行，但不能直接把现有 ObservationBranchSession 改造成压缩 branch。

推荐新增独立的 `CheckpointCandidate` 或 `CheckpointBranch`，复用现有压缩算法，但采用 durable checkpoint 语义：

1. 在 60%–70% 创建不可变 snapshot。
2. snapshot 至少记录 `revision`、`episodeId`、durable message hash、边界位置、token 使用量和启动节点。
3. branch 只生成候选压缩结果，不修改父 messages，不进入 synthetic observation queue。
4. 父会话继续执行时，revision 单调递增。
5. 候选完成后只能通过 compare-and-swap 提交。
6. 提交前必须确认当前历史仍以 snapshot boundary 为前缀，且 revision、episodeId、边界 hash 一致。
7. 发生 85% 抢占时取消候选；候选即使晚返回，也只能标记 stale，不得写回。
8. 串行压缩必须基于最新快照执行。

## 主要风险

1. 旧 snapshot 直接写回会覆盖 branch 运行期间新增的消息。
2. 异步候选和 85% 串行压缩可能发生双重压缩或完成顺序反转。
3. 数组下标不能作为稳定节点，必须使用 revision 和内容 hash。
4. 未完成的 tool call/tool result 不能被摘要伪装成已完成。
5. synthetic observation 是 transient、可延迟、可丢弃；checkpoint 是 durable、需要原子提交，两者生命周期相反。
6. 异步压缩会增加模型调用、并发额度和缓存前缀成本。

## 建议阈值

- 50%–60%：只估算和记录趋势，不启动模型调用。
- 60%–70%：最多启动一个候选压缩 branch，设置 TTL、预算和并发上限。
- 70%–80%：候选完成后先做 CAS 校验，不满足则标记 stale。
- 80%–85%：可以短暂等待候选，但不能依赖候选保证安全。
- 85% 及以上：取消候选，对最新历史串行压缩。

## 当前验证状态

- 已阅读 branch、observation、controller、checkpoint、runner 和 agent session 相关实现及文档。
- 当前测试脚本和 `package.json` 已声明 `glob` 依赖，但本工作区的 `node_modules` 未安装该依赖；运行 `npm test` 时仍会在测试发现阶段报 `ERR_MODULE_NOT_FOUND`，因此本轮尚未进入测试断言阶段。该问题属于依赖安装状态，不是测试脚本缺少依赖声明。
- 当前 XiaoBa-CLI 工作区唯一已知未提交文件是本调查文档 `docs/branch-compaction-investigation.md`；未将其它仓库工作区状态作为本项目事实。
- 本轮未执行远程 fetch。因此本记录不宣称仓库已更新到最新版本。

## 第一轮实现边界

本轮仅新增纯逻辑的 checkpoint candidate 模块和单元测试，不接入 `AgentSession`，不启动后台 branch，不修改运行时压缩算法、阈值、队列或持久化行为。

新增内容：

- `src/core/checkpoint-candidate.ts`：不可变 snapshot、durable message hash、revision/episode/boundary 比较、candidate 状态机和 CAS 提交保护。
- `tests/checkpoint-candidate.test.ts`：snapshot 隔离、匹配提交、revision/episode/boundary 失效、取消后迟到结果等测试。

下一轮接入前仍需补充：candidate 与现有 checkpoint 算法的异步调用适配、85% 抢占协调、持久化失败回滚测试，以及完整 tool-call 边界测试。
