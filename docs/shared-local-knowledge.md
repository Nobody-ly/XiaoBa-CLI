# 本地共享知识库

同一 XiaoBa 用户数据根目录下运行的 bot 共用 `<userData>/knowledge/`。根目录遵循 `PathResolver.getRuntimeDataRoot()`：优先使用 `XIAOBA_USER_DATA_DIR` 等已有运行时配置，未配置的 CLI 使用 cwd。独立 CLI 进程如需共享，应显式配置同一用户数据目录。

默认系统提示词按需引导 Agent 使用内置 `xiaoba-knowledge` Skill。用户也可以说“记到知识库”“更新这个流程”。没有定时任务、强制收尾钩子或停止后的维护任务；自动触发由模型判断，不保证每轮执行。自定义系统提示词不会被覆盖，可自行加入相关引导。

## 文件与生命周期

- `documents/KB-<uuid>.md`：文档正文和单行 JSON/YAML frontmatter，包含固定 ID、标题、摘要、分类、来源、更新时间、修改原因。
- `index.md`：面向阅读的分类/摘要索引，可重建。
- `changes.md`：根据当前文档与历史版本生成的修改记录，可重建。
- `.history/<ID>/<sha256>.md`：更新前的完整文档版本。
- `.write.lock`：仅写入期间存在，记录维护进程 PID 和开始时间。

知识文件位于持久化用户数据目录，独立于安装包、bot Skill 工作区及其云同步、Turn Skill 快照。没有 bot 私有权限或跨 XiaoBa 同步。同名用户 Skill 可以覆盖内置 Skill；内置默认版本不需要联网安装。
内置版本在 Dashboard 中标记为系统 Skill，不能通过管理入口禁用、删除或分享安装包中的文件；CLI 同样拒绝移除内置文件。用户目录的同名自定义版本仍按普通用户 Skill 管理。

## 使用与维护

通过 `skill` 工具加载 `xiaoba-knowledge`，工具结果会提供知识目录、脚本和 Node 绝对路径。按 SKILL.md 操作即可；脚本仅使用 Node 标准库，复用 `execute_shell` 的本机路由和既有权限流程。

`index` / `search` 每页最多 30 条，`read` 每页最多 12000 字符，返回 nextOffset。索引与搜索直接读取当前文档，避免派生 index.md 过时导致查不到更新。长文分页读取时检查 revision 是否一致。

写入使用 UTF-8 JSON 请求文件；创建需 `expectedRevision:null`，更新需 `id` 和 read 返回的 SHA-256 revision。脚本持有跨进程锁，检查版本，归档旧正文，再原子替换当前文档。过期版本返回 `REVISION_CONFLICT`，必须重读合并。内容未变化不会新增版本。

正文保存后若派生索引写入失败，返回 `saved:true` 和 warning，使用 `reindex` 修复；不能将其误认为未保存而重复创建。每份文件原子替换，index.md 和 changes.md 不构成跨文件事务，helper 查询仍以正文为准。

写入进程崩溃可能留下锁或 `.tmp-*` 文件。脚本返回 `LOCK_BUSY` 而不会自动抢锁，确认锁中 PID 对应进程已退出后，才可移除该锁并运行 reindex。历史数据和正文属于长期知识，不作为测试临时文件清理。

用户可直接编辑 Markdown 正文，保留 frontmatter 和文档 ID；直接编辑不会自动生成历史版本，可运行 reindex 更新索引。Agent 更新应使用 helper，以保留版本与冲突检查。操作不支持知识根目录及其内部的符号链接/目录联接和硬链接文件。

## 提示词与缓存

动态知识、索引、版本及更新时间不进入系统提示词或 Skill 列表。文档变化不会改变这些稳定内容；实际路径只在 Skill 调用结果中提供。新文档内容通过后续工具结果进入上下文，不回写旧消息。缓存效果仍由模型提供商、前缀结构和有效期决定，检索/写入也有 token 成本。

## 验证

`tests/shared-knowledge.test.ts` 覆盖独立进程共享读写、同版本并发冲突、归档、索引修复、分页、路径检查、内置发现和快照兼容，以及文档更新后提示词和 Skill 列表稳定性。实际模型是否自主调用 Skill 需要另行验收，确定性测试不能代表触发率。
