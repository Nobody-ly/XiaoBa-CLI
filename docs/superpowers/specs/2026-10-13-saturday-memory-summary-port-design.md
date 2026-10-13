# Saturday Branch Memory 与 Branch Summary 适配设计

## 目标与基线

以 XiaoBa 上游 `main` 为行为基线，将 Saturday fork 中仍有价值的两项实验能力移植到当前架构：长 Episode 的 Branch Memory 续搜，以及异步 Branch Summary。**只交付原 PR #7 的一个组合版本**；旧 PR #4、#5 仅作为实现参考，不更新、不部署。基线在设计时为 `a6154c4a`；实施前再核对上游 HEAD。

本次不恢复旧本地 JSONL 检索、旧的压缩开关或其他与这两项 branch 无关的代码。上游现有 CatsLog 服务端检索、两阶段 Memory 决策、checkpoint-only 压缩、安全和计费边界优先。将 PR #10 已验证的 `evidence` 结束契约及截断摘要保护纳入组合版本，不复制一份旧 `ref`/`refs` 合约；PR #7 的可运行性不依赖先合并 PR #10。

## 分支与交付关系

```text
fork main（同步上游 main）
  └─ PR #7：Memory 续搜 + 异步 Summary + PR #10 的必要修复
```

只更新既有 PR #7 的 head/base，不另开功能 PR，也不改 PR #4、#5。改写远端分支前保存原 HEAD，使用 `--force-with-lease`，并仅在本地测试通过后推送。PR #10 不自动合并。用户已授权测试、审查通过后部署 Saturday 的 PR #7 HEAD，不合并上游。

## Branch Memory

Episode 开始时仍立即启动一次当前上游的服务端 Memory Branch。主 Agent 的模型/工具循环到达现有 synthetic-observation 注入边界时，检查前一次 Memory Branch 是否结束且距离结束已超过默认 15 分钟。没有新主 Agent 消息就跳过，不调用模型；仍在运行的 Branch 不重叠启动。符合条件时，以同一 Episode 的原始用户任务锚点、上次激活后的新增主 Agent 消息、此前真正注入的短摘要启动新的短 Memory Branch。后续分支仍使用当前 CatsLog 检索与 `evidence` 结束工具；此前引用只是去重提示，不是硬黑名单。

游标仅在新分支实际启动后前进；Synthetic Observation 本身不进入新增消息。Episode 结束后不再激活新分支，只沿用现有的一轮 carryover 边界。取消、失败或 Branch Agents 关闭时停止活跃分支并丢弃迟到观察。当前 `BranchSession` 已有 checkpoint 能力，不移植旧分支的第二套压缩代码。15 分钟从上次分支完成时算起，是默认值，可通过内部选项测试和调整，不增加新的用户开关。检查发生在现有模型/工具边界，不新增独立定时器；边界期间即使超过 15 分钟，也不会并发唤起模型。

## Branch Summary

基于当前主 Session 的 checkpoint coordinator 增加一个后台候选，不另建压缩机制。完整请求占用**严格超过**模型物理窗口 75% 后启动候选；占用严格超过安全停止点（目标 85%，仍受模型输出余量约束）后，主 Agent 在下一次模型请求前等待同一个候选，不杀死后重跑。Provider usage 校准持久上下文；尚未发送的 tool 定义、transient prompt 和增量各只估算一次。

若安全停止点不高于启动点（例如物理窗口虽大，但输出上限占用过多），不启动无效后台候选，直接沿用串行 checkpoint。候选使用主 Session 同一模型、AIService 与凭据。从完整边界制作快照，摘要完成后只在 Episode、revision、前缀 hash、边界及 tool pair 均匹配时原子提交，快照后的有效 suffix 保留。候选在模型请求前和完整 tool batch 后协调；Episode 正常结束时只提交已完成候选，不为此等待或把成功回合改判失败。候选失败在同一生命周期内最多尝试 3 次，总计最多 18 次 Provider 请求，且受 15 分钟总期限约束；认证失败不重复请求。最终失败保留原始上下文，并在安全停止点阻止危险的新主模型请求。Summary 的模型用量、次数、耗时与等待时长沿用现有 checkpoint 日志和指标语义。

旧 PR #5 中通过 `XIAOBA_CHECKPOINT_COMPACTION_ENABLED=false` 回到另一套压缩路径的条款已与上游 checkpoint-only 架构冲突，本次不恢复。显式 `/compact`、正常 pre/mid-turn checkpoint 和已有恢复路径继续工作。

## 验收与边界

- Memory：首轮即搜；15 分钟后有新增才续搜；无新增不调用；同一 Episode 不重叠；通过提示避免重复结论，不增加硬编码过滤；合法 `evidence` 引用可重复使用；结束后不再启动。
- Summary：75% 前不启动；超过 75% 启动一次；超过停止点只等待同一候选；候选快照失效时不错误提交；后续 tool pair 和新增消息不丢；网络/空摘要/截断输出有界重试，401 不无界重试；最终失败不裁剪历史。
- 组合：两项同时运行时不互相覆盖 Session 消息或 checkpoint；主 Agent、Memory Branch、Summary 的模型调用和计费可区分；取消/重启不泄漏后台任务。
- 执行定向测试、完整构建、`release:check`、仓库 CI。通过后检查 Saturday 活跃任务，备份当前版本和必要配置，切换到 PR #7 HEAD、重启连接；保留全部 state、skills、历史和用户配置，核对服务状态、连接、运行 SHA 与启用设置。

