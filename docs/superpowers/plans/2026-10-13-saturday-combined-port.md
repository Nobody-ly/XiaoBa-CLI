# Saturday PR #7 组合版本执行记录

设计依据：`../specs/2026-10-13-saturday-memory-summary-port-design.md`。

1. 从最新 upstream/main 建立干净适配分支，保留旧 #7 备份。
2. 移植 evidence 结束契约，保留上游服务端 Memory 检索；在现有注入边界增加 15 分钟、有增量、不重叠的长 Episode 续搜。
3. 移植异步 checkpoint 候选，沿用 main 的 checkpoint-only、安全持久化与手动 compact；消除旧压缩路径依赖。
4. 验证触发阈值、等待、后缀/tool pair、取消、重试、用量记录、Memory 增量和 carryover。独立审查后修复并复验。
5. 更新原 #7 到 main 基线，保留其一个组合交付入口；等待 CI。
6. 在 Saturday 空闲时备份版本、构建切换、重启，核对 SHA、服务连接、两个 Branch 设置；不合并 PR，不动其他服务。

审查收敛要求：后台候选耗尽重试或 deadline 后不得在安全停止点重新领一套额度；手动 compact 与恢复串行执行；无效摘要仍计入用量；禁用候选时的同步 checkpoint 也进入会话计量。
