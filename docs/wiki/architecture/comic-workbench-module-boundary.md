# 漫画工作台模块边界与版本链

## 背景

漫画工作台经历了一次从服务端模块到纯客户端模块的重建。旧实现依赖服务端漫画模块与数据库，部署与调试成本高，且与「写作 beginners 在本机完成创作」的产品方向不符。重建后模块被要求：

- 与现有小说业务完全隔离，不改动主项目路由、样式与业务代码；
- 无后端，数据全部落在浏览器 IndexedDB；
- 漫画制作的多个阶段（分镜/台词/描述词/生图）之间存在依赖，上游变化必须可见、可控，不能静默改写下游产物。

历史上最容易出现的问题是「级联失效」：用户改了画风或重排了分镜，系统悄悄重跑下游全部阶段，导致生成额度被无声消耗、手动编辑被覆盖。版本链设计就是为了把这种隐式行为变成显式的「待更新提示 + 用户确认刷新」。

## 决策

### 纯客户端模块边界

- 模块全部代码位于 `client/src/modules/ComicWorkbench/`，通过左侧菜单「漫画工作台」入口挂载，对外只暴露页面组件。
- 禁止生成任何后端代码；AI 调用由前端直接请求用户配置的供应商（火山方舟 / GrsAI 等），API Key 只存本机 IndexedDB。
- 模块不 import 主项目的业务服务；反过来主项目也不感知模块内部。数据层（`db/comicDb.ts`）是唯一允许触碰 `idb-keyval` 的地方。

### 原文零修改与字符索引锚定

- 章节正文（`sourceContent`）导入后只读；分镜、台词只记录 `startIndex/endIndex`。
- 空镜（转场镜）允许零长度区间；删除分镜不回改原文。
- 这样保证原文任何展示（虚拟滚动高亮、条漫台词合成）都能与分镜对齐，也为「重新分镜不丢失原文」提供了基础。

### 版本链 stale 判定（每阶段产出独立盖章）

- `ComicChapter.versions` 是章节级计数器：`content / storyboard / metadata / cast / dialogue / prompt / presentation`。上游阶段完成或结构变更时递增对应计数器。
- 每个阶段产出时在面板上记录当时快照：
  - 台词产出 → `panel.dialogueBasis`（分镜+元数据+角色库+表现层快照）；
  - 描述词产出 → `panel.promptBasis`；
  - 生图成功 → `panel.imageBasis { prompt, presentation }`。
- stale 规则（`services/syncService.ts`）：
  - 台词 stale = `storyboard/metadata/cast` 相对 `dialogueBasis` 有变化；
  - 描述词 stale = `storyboard/metadata/cast/dialogue/presentation` 任一变化；
  - 画面 stale = `prompt/presentation` 相对 `imageBasis` 有变化（仅已成功生图的面板）。
- 缺 basis 字段 = 该阶段尚未生成，不算 stale（向后兼容旧数据）。

为什么选择「产出时盖章」而不是「全局 upstreamVersions 快照」：单一快照会在下一阶段刷新时掩盖中间阶段的失效（例如台词刚标 stale 就被描述词重建冲掉）；每阶段独立盖章让三个阶段可以各自独立判断失效，语义清晰。

章节级计数器意味着一次全章变化（如重排分镜）会把全章下游标记为待更新。这是有意接受的语义：重提台词/重建描述词是确定性算法、代价小；而画面重生成消耗生图额度，所以「一键同步」只重跑文本链（台词 → 描述词），画面刷新留在生成步骤由用户显式触发。

### 表现层版本（presentation）只由形态/画风变更推进

- 形态切换、画风调整会为全部章节递增 `presentation`。
- 生成队列成功后**不**递增 presentation（曾犯过此错误：刚生成的图因 basis 立即被判定 stale）。

### 手动内容保护

- 描述词手动编辑后标记 `manualOverride`；批量重建与一键同步默认跳过手动覆盖的描述词，保持其 stale 标记供用户自行取舍。
- 台词手动编辑在「重新提取」时会被整体覆盖——重新提取是显式确认操作，符合预期。

## 当前规则

- 新增任何「产出物依赖上游版本」的阶段时，必须在产出时盖章 basis，并在 `syncService` 中补齐对应 stale 规则。
- 任何上游变更路径只允许递增版本计数器，禁止直接改写下游面板字段（形态切换清空分镜是唯一经用户确认的例外）。
- 所有配置（形态/画风/密度/公式/叙事模板/平台/敏感词）必须放 `config/*.json` 并经 `configService` 的 zod 校验；禁止在业务代码硬编码模板。
- 运营文案按 `comic:marketing:{chapterId}:{platformId}` 独立键存储，删除项目时由 `purgeOrphanKeys` 全键扫描兜底清理；新增独立键类数据必须加入该兜底名单。
- 长列表（分镜编辑、原文预览、台词列表）必须虚拟滚动；步骤面板的异步操作必须有错误兜底与 toast 提示。

## 示例

- 推荐：分镜重排后，`versions.storyboard += 1`，台词/描述词/画面在各自步骤页显示「N 个分镜待更新」横幅，用户点「一键同步」重跑文本链。
- 禁止：重排分镜时顺手清空台词数组或重置生成状态（静默级联修改）。
- 禁止：在队列成功回调里递增 `presentation`（会让刚生成的图立刻 stale）。

## 失败模式

- **刚生成的图立刻标 stale**：检查是否在生成链路里推进了 `presentation` 或 `prompt` 计数器；表现层版本只应由形态/画风变更推进。
- **旧项目全部面板显示未生成（而非待更新）**：basis 字段缺失按「未生成」处理是有意兼容；若旧数据被误判 stale，检查 `stageBasisSnapshot` 的 `metadata ?? 0` 回落。
- **灵感导入丢失场景段**：同步链路重建描述词时必须把实际场景库传入，不允许传空数组占位。
- **配置 JSON 改坏导致白屏**：`configService` 在模块加载时做 zod 校验并抛出带文件名/位置的错误；新增配置必须登记 schema。

## 相关模块

- `client/src/modules/ComicWorkbench/`（模块根，含 README）
- `client/src/modules/ComicWorkbench/services/syncService.ts`（stale 计算 + 一键同步）
- `client/src/modules/ComicWorkbench/services/configService.ts`（配置校验入口）
- `client/src/modules/ComicWorkbench/db/comicDb.ts`（IndexedDB 键空间与级联清理）
- `client/src/modules/ComicWorkbench/config/*.json`（全部配置）

## 来源文档

- 漫画工作台重建计划：`.trae/documents/comic-workbench-rebuild-plan.md`
- 模块开发强制规则：`.trae/rules/comic-workbench-rule.md`
