# 百万字长篇小说创作流程分析与漫画生图链路审查报告

> 生成日期：2026-09-16。基于当前代码库（分支 feature/model-split-comic-delete-autobump）的代码证据分析。

---

## 第一部分：程序的长篇能力现状（能撑几百万字吗）

### 1.1 结论先行

| 维度 | 现状 | 百万字（约 500-600 章） | 几百万字（1500-3000 章） |
| --- | --- | --- | --- |
| 分卷结构 | 已支持（VolumePlan 体系） | 9-14 卷区间内 | 18-24 卷（当前硬上限 24 卷） |
| 章节规划 | 按 beat 增量拆章 + 单章 JIT 合同 | 支持 | 支持（不需要整卷标题一次生成） |
| 前情记忆 | 事实账本/伏笔账本/时间线/角色连续性 | 支持 | 支持，但依赖账本维护质量 |
| 自动执行 | 连续章节窗口（默认约 10 章）+ checkpoint 恢复 | 支持（多次推进） | 支持但需要多次手动推进 |
| 硬上限 | 卷数 ≤24；单次自动执行窗口小 | 无碍 | 24 卷 × 每卷约 100-150 章 ≈ 约 3600 章封顶 |

### 1.2 架构分层（代码证据）

宏观规划 → 卷规划 → 节奏板 → 章节执行，四层结构：

- **卷规划**：`VolumePlan` / `VolumeChapterPlan` / `VolumePlanVersion` 数据模型（server/src/prisma/schema.prisma:2082-2150）。卷战略 strategy → 审查 critique → 卷骨架 skeleton → 节奏板 beat sheet 的两段式工作流（docs/wiki/workflows/volume-planning.md）。
- **动态卷数区间**：`<30 章` 1-2 卷，`500-899 章` 9-14 卷，`900-1499 章` 14-20 卷，`1500+ 章` 18-24 卷；`allowedVolumeCountRange` 上限 24（docs/wiki/workflows/volume-planning.md:26-37）。百万字按 1800-2000 字/章约 500-600 章，落在 9-14 卷；300 万字约 1500-1700 章，落在 18-24 卷，**刚好在上限内但接近封顶**。
- **hard/soft 深度分层**：7+ 卷时只有前 3-6 卷做 hard 规划，后续卷保留方向不写死细节（volume-planning.md:92-99）——这是为超长篇设计的「不提前锁死」策略。
- **按 beat 增量拆章**：拆章默认按单个节奏段（beat）增量生成，执行合同按单章 JIT 补齐；新手先拿到当前节奏段的可写章节即可开写，不必等整卷标题生成完（volume-planning.md:113-119）。
- **全书绝对章序**：终局判断必须使用全书绝对章序，章节拆分累加前序卷预算（volume-planning.md:39）。

### 1.3 前情记忆与状态追踪（几百章不崩的关键）

- **事实账本**：docs/wiki/workflows/novel-fact-ledger.md —— 全书已确立事实的结构化记录。
- **伏笔账本**：docs/wiki/workflows/payoff-ledger-contract.md —— 伏笔的埋设与兑现追踪。
- **时间线约束层**：docs/wiki/workflows/timeline-constraint-layer.md。
- **角色连续性硬事实**：docs/wiki/debugging/character-continuity-hard-facts.md。
- **角色动态**：投影批量上限 `MAX_CHAPTERS_PER_PROJECTION_BATCH = 48`（server/src/services/novel/dynamics/characterDynamicsLlm.ts:9）——超长篇下角色动态按 48 章分批投影。
- **上下文组装**：docs/wiki/rag/knowledge-and-context-assembly.md、docs/wiki/architecture/world-context-gateway.md；章节执行按 `volume_window` 注入卷级上下文。

### 1.4 自动执行模型

- 自动导演执行范围按**连续章节窗口**指定：`DirectorAutoExecutionRange { startOrder, endOrder, totalChapterCount }`，默认 `preferredChapterCount = 10`（server/src/services/novel/director/automation/novelDirectorAutoExecution.ts:24-27, 186-205）。
- 失败/阻断时提示跳过当前章继续执行，显示剩余章节（novelDirectorAutoExecutionFailure.ts:30-40）；断路器保存 range 与恢复点（novelDirectorAutoExecutionCircuitBreakerRuntime.ts:94-104）。
- 结构化大纲恢复游标：识别第一个未完成 beat，长卷后半卷标题未生成不阻塞当前 beat 正文生产（volume-planning.md:138-147）。
- 质量门不阻塞全书：章节质量债默认非阻塞，仅 `pause_for_manual` 策略在章节边界暂停等待人工恢复（AGENTS.md Auto-Director Quality Gate Rules）。

### 1.5 百万字 → 几百万字的差距清单

**已支持（直接可用）**：
- 分卷战略/骨架/节奏板，beat 增量拆章，单章 JIT
- 事实/伏笔/时间线/角色连续性账本
- checkpoint 恢复、断路器、pending-manual-recovery 人工暂停
- 角色动态 48 章分批投影

**可绕过（操作层面解决）**：
- 单次自动执行窗口默认约 10 章 → 几百万字需要几百次「继续推进」；用分段范围 + 自动推进即可，但连续跑全书仍需人盯恢复点
- 卷数上限 24：约 3600 章（约 700 万字）以内够用；超出需改 `allowedVolumeCountRange` 上限（shared/types/volumePlanning.ts）

**严重瓶颈（暂无阻断，但需注意）**：
- 前几百万字后，账本/事实库体积增长对每次章节生成的上下文组装耗时与 token 成本的放大（docs/wiki/architecture/read-path-performance-boundaries.md 有读路径边界设计，未见百万字实测数据）
- `VolumeWindowContext.keyMilestoneGuards` 尚未完整填充，长卷执行可能提前兑现里程碑或重复卷级高潮（volume-planning.md:159-163，官方已记录的缺口）

---

## 第二部分：新手一步步操作引导（从 0 到几百万字）

### 阶段 0：一次性准备（约 5 分钟）

1. 打开程序，进入「模型设置」（顶部导航「模型设置」按钮，路由 `/settings`）。
2. 在「文本模型」分区配置至少一个厂商的 API Key（如火山方舟/智谱等），选择默认文本模型；在「生图模型」分区配置生图厂商（若需要封面/漫画）。
3. 系统会就绪性自检；后续所有 AI 能力（含漫画工作台）共用这一套配置。

### 阶段 1：创建小说（AI 自动导演 5 步）

1. 左侧导航进入「AI 自动导演」（路由 `/novels/auto-director`）。
2. 按页面 5 个阶段推进：**灵感（idea）→ 基础设定（basic）→ 世界观与文风（world_style）→ 模型运行（model_run）→ 候选方案（candidates）**（client/src/pages/novels/autoDirector/AutoDirectorCreatePage.tsx:99-145）。每一步 AI 给推荐默认值，新手只需确认或改一句话。
3. 创建完成后选择创作体验：**简易模式**（跳转 `/novels/{id}/simple`，适合新手）或**专业工作台**（`/novels/{id}/edit`）。创建草稿自动保存，中断可恢复（client/src/pages/novels/autoDirector/draft/autoDirectorCreateDraft.ts:64-130）。

### 阶段 2：全书规划（百万字的关键步骤）

1. 在简易模式下选择「AI 规划」让系统自动完成；专业模式按顺序推进：**故事宏观规划 → 卷战略 → 卷审查 → 卷骨架 → 节奏板**。
2. 设定目标字数（如 100 万），系统按章节预算给出卷数区间（100 万字约 500-600 章 → 推荐 9-14 卷），AI 结合卖点切换与阶段兑现决定最终卷数。
3. 只需要认真规划前 3-6 卷（hard），后续卷保持 soft——写作推进到后面再细化，避免结构僵化。
4. 节奏板按 beat 增量拆章：先给当前节奏段生成章节标题，立刻可以开写，不必等整卷。

### 阶段 3：开始生产章节

1. **全自动路径（推荐新手）**：简易模式开启 `full_book_autopilot`（全书自动驾驶），系统按「生成→审校→修复→定稿」的章节生产链连续产出（docs/wiki/workflows/chapter-production-chain.md）。
2. **分段路径**：自动导演一次执行约 10 章的窗口，完成后在 AI 驾驶舱点「继续推进」进入下一个窗口；任何时候失败/断路，系统保存恢复点，回到来源页一键恢复。
3. **运行记录（任务中心）只读**：查看进度、错误、恢复位置，但恢复/重试操作必须回到对应工作页执行（docs/wiki/product/task-center-role.md）。
4. 每章产出后可暂停检查；默认质量债不阻塞全书（继续写后面的章），只有选择质量优先策略且问题标记为「需人工」时才在章节边界暂停。

### 阶段 4：长跑管理（50 万字以后）

1. 每写完一卷，回到卷规划细化下一卷（soft → hard），或直接让自动导演在恢复点继续生成下一个 beat。
2. 关注账本健康：角色状态、伏笔兑现、时间线由系统自动追踪；发现连续性问题时用角色连续性修复入口处理。
3. 大范围修改（如改人设）后，系统按「未写范围最小扰动」处理：已有正文的章节锁定不动，未写的后续 beat 自动接入新设定（volume-planning.md:149-157）。

### 阶段 5：从 100 万字扩到几百万字

1. 100 万字（约 500-600 章）接近卷规划第一梯队上限时，回到**卷战略**追加卷：系统在 24 卷上限内支持到约 3600 章（约 700 万字）。
2. 追加卷时保持「全书绝对章序」即可，系统自动累加章节预算，终局判断不会错位。
3. 超过 24 卷需求（极少见）需要开发者调整 `allowedVolumeCountRange` 上限（shared/types/volumePlanning.ts）。
4. 多卷并行写作：每卷独立节奏板与执行窗口，可交替推进；终章合同由全书绝对章序触发（`endingRequiredBy`），避免过早收尾。

---

## 第三部分：漫画工作台生图链路逻辑审查

### 3.1 审查范围

「智能分镜 → 描述词 → 画面生成」全链路状态一致性：generationQueue.ts（任务状态机）、imageClient.ts（主程序任务链对接）、syncService.ts（stale 版本链）、promptEngine.ts（描述词组装）。

### 3.2 逻辑矛盾（会导致错误结果或重复消耗，共 2 处）

#### 矛盾 A：「台词绘制到画面」开关切换后语义失效

- **位置**：GenerateStepPanel.tsx:273-282（开关只改 `chapter.letteringEmbed`，不推进任何版本号）；generationQueue.ts:273-285（仅当 `panel.prompt.final` 为空才现场重组描述词）；promptEngine.ts:87-100（`embedDialogue` 决定台词是否写进描述词）。
- **矛盾过程**：用户开启台词绘制 → 提示语承诺「重新生成画面后台词会直接绘入图中」→ 但已有成品图的 `imageBasis` 与章节版本比对不变（不标「待更新」）；即便用户手动单镜重绘，`panel.prompt.final` 仍是关闭状态组装的旧描述词（不含台词文字），重绘结果**依然没有台词**。只有回描述词步骤重新批量生成（推进 `versions.prompt`）再重绘才生效。
- **影响**：承诺与实际行为相反；新手几乎必然踩中。

#### 矛盾 B：本地「取消/关页/超时」无法终止主程序生图任务 → 重复消耗生图额度

- **位置**：imageClient.ts:91-120（提交 `/images/generate` 后只拿 taskId 轮询，无取消调用）；imageClient.ts:79-81（轮询超时抛错）；generationQueue.ts:346-365（本地失败自动重试会**重新提交新任务**）；generationQueue.ts:352-365（用户取消仅把本地任务还原 pending）。
- **矛盾过程**：主程序任务提交后在服务端异步执行。用户中途取消、关闭页面或轮询超时，本地任务回 pending/重试，但主程序侧旧任务继续跑完并产出资产。用户「继续生成」→ 再次提交新任务 → 同一分镜产生两个远端任务、两次生图消耗，服务端残留孤儿资产。主程序任务状态机本身支持 `cancelled`（shared/types/image.ts），但漫画客户端从未对接取消端点。
- **影响**：批量生成数百镜时，一次超时风暴可能成倍放大生图费用。

### 3.3 潜在风险（边界情况，不致错，共 4 处）

1. **多标签页并发**：`ensureChapterTasks` 允许改写 active 任务的 mode（generationQueue.ts:119-131），单标签下有 busy 防护，但两个浏览器标签同时操作同一章节时，可能出现「运行中的草稿任务被改档为高清，草稿像素的图被标记为高清成品」。
2. **覆盖偏好的模型失效显示**：生图覆盖偏好指定的模型被主程序删除后，GenerateStepPanel 下拉当前值不在选项列表中（显示空白），实际提交仍用旧模型 id，由服务端报错兜底。
3. **状态查询放大**：每个分镜生成都调 `resolveImageChoice` → `fetchMainAiStatus`（每镜 2 个 GET 请求），批量 100 镜约 200 次状态查询（aiConfigService.ts:66-92）；本机服务影响有限。
4. **双重重试叠加**：本地重试（maxRetries，指数退避）× 服务端任务重试（提交时写死 `maxRetries: 2`），最坏情况单镜 9 次生图提交。

### 3.4 无矛盾项（已核查通过）

- 断点恢复状态机（running/queued → pending）闭环完整；
- stale 盖章链（dialogueBasis/promptBasis/imageBasis 三级版本比对）覆盖分镜/角色/台词/画风/元数据全部上游；
- 队列成功后不推进 presentation 版本（避免刚生成即判 stale）的设计正确；
- 描述词兜底组装后立即盖章，与版本链一致；
- 手动描述词保护 + 全章版本推进的保守标记行为符合规则第 7 条。

---

## 第四部分：矛盾处理记录（已确认并实施）

用户已确认修复方案并实施完成（2026-09-16）：

### 矛盾 A：已按方案 A1（版本联动）修复

- `GenerateStepPanel.toggleLetteringEmbed`：切换「台词绘制到画面」开关时推进 `chapter.versions.presentation`，所有已有成品图自动标记「待更新」。
- `generationQueue.runSingleTask`：生成前检测 `promptBasis.presentation` 与当前表现层版本不一致时自动重组描述词（手动描述词 `manualOverride` 不覆盖），重绘结果与开关状态一致。
- 行为闭环：开关切换 → 横幅提示待更新 → 重绘/重新生成待更新画面 → 描述词自动带新台词设置 → 画面带台词。

### 矛盾 B：已按方案 B1（对接任务取消）修复

- 服务端新增 `POST /api/images/tasks/:taskId/cancel` 路由（复用已有 `ImageGenerationService.cancelTask`，取消请求由执行器 `ensureNotCancelled` 轮询生效）。
- 客户端 `api/images.ts` 新增 `cancelImageTask`（`silentErrorStatuses` 静默已终态任务的 400/404 拒绝）。
- `imageClient.generateImage` 轮询循环退出路径（本地取消/超时/网络中断）且任务未到终态时，best-effort 调用远端取消，杜绝「继续生成」重复提交与重复消耗。
- 已知限制：浏览器直接关闭页面时无机会发出取消请求，远端任务仍会跑完（与方案 B2 的残留一致，可接受）。

---

## 附：关键证据索引

| 主题 | 位置 |
| --- | --- |
| 卷数据模型 | server/src/prisma/schema.prisma:2082-2150 |
| 卷数区间规则 | docs/wiki/workflows/volume-planning.md:26-37 |
| 自动执行窗口 | server/src/services/novel/director/automation/novelDirectorAutoExecution.ts:186-205 |
| 角色动态批量上限 | server/src/services/novel/dynamics/characterDynamicsLlm.ts:9 |
| 自动导演创建页 | client/src/pages/novels/autoDirector/AutoDirectorCreatePage.tsx:99-145 |
| 生图任务链客户端 | client/src/modules/ComicWorkbench/services/ai/imageClient.ts:50-89 |
| 生成队列状态机 | client/src/modules/ComicWorkbench/services/generationQueue.ts:261-398 |
| stale 版本链 | client/src/modules/ComicWorkbench/services/syncService.ts:33-61 |
| 台词嵌入描述词 | client/src/modules/ComicWorkbench/services/promptEngine.ts:86-100 |
