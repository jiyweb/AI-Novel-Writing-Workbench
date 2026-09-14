# 桌面端 SQLite 迁移与 Schema 漂移

## 背景

桌面端（Electron）使用内置 SQLite，数据库位于用户数据目录 `data/dev.db`（便携版在 exe 同目录 `AI-Novel-Writing-Assistant-v2-data`）。它的结构不能靠 `prisma db push` 在用户机器上同步，只能通过随包发布的迁移链演进。

开发机常用 `pnpm prisma:push` 直接按 schema 同步本地库，因此 `schema.sqlite.prisma` 可能领先于迁移链：开发环境一切正常，但桌面端新库或老库缺列/缺表，运行时报：

```
Invalid `prisma.xxx.findUnique()` invocation:
The column `main.<Model>.<column>` does not exist in the current database.
```

2026-09-14 漫画模块就发生过一次：`ComicCharacter.gender`、`ComicPanel.sceneRef` 已在 schema 中但没有迁移，`ComicScene`、`ComicCharacterAsset` 两张表也只存在于 schema，桌面端创建漫画项目时 `findUnique` 直接报错。

## 当前规则

### 结构演进契约

1. 桌面端启动时由 `server/src/db/runtimeMigrations.ts` 的 `ensureRuntimeDatabaseReady()` 执行 `server/src/prisma/migrations.sqlite/` 下所有未记录（`_prisma_migrations` 表）的迁移，事务化执行并记录 checksum。
2. 任何 schema 变更都必须同时补两条迁移链，文件夹名保持一致：
   - SQLite：`server/src/prisma/migrations.sqlite/<时间戳>_<名称>/migration.sql`（`TEXT/DATETIME/INTEGER`，内联外键）
   - PostgreSQL：`server/src/prisma/migrations/<同名>/migration.sql`（`TIMESTAMP(3)`、独立 `ALTER TABLE ADD CONSTRAINT`、`_pkey` 约束命名）
3. 列级漂移还要在 `runtimeMigrations.ts` 的 `REQUIRED_COLUMN_BACKFILLS` 登记（带完整列定义和默认值）。这是给只满足旧表结构、迁移记录不可靠的库的兜底，启动迁移循环之后执行；**它只能补列，不能补表**，缺表必须写正式迁移。
4. 迁移按文件名排序顺序执行，命名沿用 `YYYYMMDDHHMMSS_描述`；补丁类迁移命名沿用 `schema_gap_backfill` / `schema_column_backfill` 惯例。
5. 迁移 DDL 不写 `IF NOT EXISTS`（与 Prisma 生成风格一致）；幂等性由 `_prisma_migrations` 记录保证。

### 改 schema 的检查清单

- 两个 schema 文件（`schema.prisma`、`schema.sqlite.prisma`）都改。
- 两条迁移链都加同名迁移；新增列必须 `NOT NULL DEFAULT ...` 或可空，保证老数据可补。
- 纯加列的漂移同时登记 `REQUIRED_COLUMN_BACKFILLS`。
- 本地 `prisma db push` 验证后，不要误以为桌面端也已同步。
- 打包前可用运行时迁移器对一份副本库试跑新迁移。

## 故障修复路径（线上库已报错时）

禁止用 `prisma db push`、`migrate reset` 或重建表来"修复"用户库。安全步骤：

1. 定位用户库（桌面端 `%LOCALAPPDATA%\AI-Novel-Writing-Assistant-v2\data\dev.db`），确认应用已退出（SQLite 文件锁）。
2. **先整文件备份**到 `data/backups/`，校验备份文件大小与原文件一致。
3. 只执行缺失对象的最小增量 DDL：`ALTER TABLE ADD COLUMN` / `CREATE TABLE` / `CREATE INDEX`，参考新迁移文件内容。
4. 用与 `runtimeMigrations.ts` 相同的算法（迁移文件全文 sha256）把迁移名和 checksum 写入 `_prisma_migrations`（`finished_at` 非空、`applied_steps_count=1`），保证后续版本启动时不会重复执行。
5. 用 Electron ABI 的 better-sqlite3（`ELECTRON_RUN_AS_NODE=1` 调 electron.exe）执行 `PRAGMA table_info` 和 `sqlite_master` 验证列/表存在；再启动应用请求报错的原接口确认恢复。

## 失败模式

- 只改 schema 不加迁移：开发机（db push）正常，桌面端报 column/table does not exist。
- 只加 SQLite 迁移漏掉 PostgreSQL 链：自托管 PG 用户迁移失败；两条链必须同名同步。
- 用 node ABI 的 better-sqlite3 在 electron 下加载：`NODE_MODULE_VERSION` 不匹配；验证桌面库时用 electron 自身运行 Node 脚本。
- 手工给老库补了列但不写 `_prisma_migrations` 记录：新版本启动重复 `ADD COLUMN`，迁移事务失败并反复报错。
- 用 reset / 重建表方式修复：属于破坏性操作，无备份且未经批准时禁止。

## 相关模块

- `server/src/db/runtimeMigrations.ts`：桌面端迁移执行器与列补偿清单
- `server/src/prisma/migrations.sqlite/`：SQLite 迁移链（桌面端唯一结构来源）
- `server/src/prisma/migrations/`：PostgreSQL 迁移链
- `server/src/config/database.ts`：schema/迁移路径与数据库运行时配置
- `server/src/modules/comic/`：漫画模块（本次漂移发生处）
