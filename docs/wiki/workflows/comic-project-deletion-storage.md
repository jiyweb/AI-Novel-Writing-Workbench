# 漫画项目删除与图片存储清理

## Background

漫画项目的数据库记录（项目、话数、角色、素材、场景、分格、导出任务）和磁盘图片文件是两套数据。只删数据库会让用户的生成图目录持续积累孤儿文件；只删文件则会破坏数据库引用。删除入口还必须让新手明确知道：这是不可恢复操作，影响范围是整个项目而不是单张图片。

## Current Rule

### 删除入口

- 删除入口在漫画工作台的项目卡片上（创作来源页），不进入任务中心；任务中心只允许查看和跳转，不承载任何工作流变更动作。
- 点击「删除项目」必须先弹确认框，明确列出影响范围：全部话数、角色、场景、分格和已生成图片都会被永久删除。

### 数据库删除

- 服务入口是 `ComicProjectService.deleteProject`，路由 `DELETE /comic/projects/:id`。
- 删除前先 `findUnique` 并 select 出全部关联记录（characters、characterAssets、scenes、episodes.panels、exportJobs、uploadAssets），项目不存在时返回 null，由路由层表达 404。
- 数据库行通过 `prisma.comicProject.delete` 一次性删除，schema 中漫画相关关联全部配置 `onDelete: Cascade`，不要在应用层逐条删子记录。

### 磁盘清理

- 漫画图片存储布局唯一归属 `server/src/services/comic/storage/comicStoragePaths.ts`：角色、角色素材、场景、分格、加字分格、导出任务各自有固定子目录，根目录统一来自 `resolveGeneratedImagesRoot()`。
- 任何漫画图片服务都必须从该模块取路径，不允许在服务文件里再定义 `path.join(generatedImagesRoot, ...)` 之类的本地常量，避免新增图片类型时删除清理漏掉目录。
- 删除项目时由 `removeComicProjectStorage(refs)` 执行 best-effort 磁盘清理：
  - 用 Set 对所有目录去重，递归删除项目涉及的角色/素材/场景/分格/导出目录。
  - 用户上传文件路径必须先通过目录包含校验（限制在生成图根目录内）再删除，防止数据库异常路径导致目录穿越删除。
  - 磁盘清理失败只记录 warning，不阻断数据库删除：数据库已经是事实来源，孤儿文件不能让删除接口报错并留下半删状态。
- 清理在数据库事务删除完成之后执行，避免先删文件、后删库失败时出现缺图记录。

## Failure Modes

- 如果在应用层手写逐条级联删除，新增一种子资源时很容易漏删，留下孤儿数据；应依赖 schema 的 cascade，只在删除前收集文件引用。
- 如果把图片路径散落在各服务中，项目删除会漏清目录，长期运行后磁盘被孤儿图片占满。
- 如果磁盘文件删除失败就回滚或报错，用户会看到「删除失败」但数据库可能已部分变化，反而更难恢复；正确做法是数据库删除为准、文件失败只告警。
- 如果把删除动作放进任务中心，用户看不到项目内容和影响范围，容易误删；动作必须留在漫画工作台项目卡片上。

## Related Modules

- `server/src/services/comic/storage/comicStoragePaths.ts`：全部漫画图片目录布局的唯一来源
- `server/src/services/comic/storage/projectStorageCleanup.ts`：项目级 best-effort 磁盘清理
- `server/src/services/comic/ComicProjectService.ts`：`deleteProject` 收集引用 + 级联删除
- `server/src/modules/comic/http/comicRoutes.ts`：`DELETE /projects/:id`
- `client/src/pages/comic/ComicWorkspacePage.tsx`：项目卡片删除入口与确认
