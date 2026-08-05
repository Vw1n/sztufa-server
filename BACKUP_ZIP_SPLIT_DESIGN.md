# 可导入 JSON 分包压缩导出方案

## 1. 结论

导出的 JSON 必须直接符合系统现有历史数据导入器的格式，不能按 Prisma 数据表简单导出为 `User.json`、`Match.json` 等数组。

新功能定位为“可移植业务数据导出”：

- 按赛季生成多个可直接导入的 JSON；
- 将这些 JSON 和清单文件放入一个 ZIP；
- ZIP 解压后的赛季 JSON 可直接提交给现有预检、导入接口；
- ZIP 导入功能上线后，也可直接上传整个压缩包；
- 导出完成前，服务端必须用与导入接口相同的解析器预检生成结果。

全量数据库灾备与可移植导出必须分开：

- 全量灾备继续覆盖 17 张表，用于数据库原样恢复；
- 可移植导出只包含现有导入器支持的赛季、球队、球员、比赛和事件；
- 用户、权限、预测、新闻、审计日志、审批记录等数据不能伪装成可导入 JSON。

如果要求 ZIP 同时能够无损恢复全部 17 张表，应另行扩展导入协议；在现有导入器能力下无法实现。

## 2. 现有导入器实际支持的格式

当前 `ImportService` 支持三类 JSON。

### 2.1 赛季文件

顶层必须是 JSON 对象，并至少包含：

```json
{
  "schemaVersion": 2,
  "season": {
    "name": "2025 校长杯"
  },
  "teams": [],
  "matches": []
}
```

导入器以 `season.name` 识别赛季，以 `teams` 读取球队和球员，以 `matches` 读取比赛及事件。

### 2.2 补充球员文件

现有导入器通过以下字段识别未归属历史赛季的补充文件：

```json
{
  "assignmentStatus": "not_assigned_to_historical_season",
  "teams": []
}
```

只有确实无法关联赛季的球员才应放入此文件。

### 2.3 清单文件

现有导入器通过 `rawFiles` 和 `seasons` 两个数组识别清单：

```json
{
  "schemaVersion": 2,
  "rawFiles": [],
  "seasons": []
}
```

清单只用于核对，不写入数据库。

## 3. ZIP 目录结构

推荐结构：

```text
portable_export_1785460000000.zip
├── manifest.json
├── seasons/
│   ├── 2023_校长杯.json
│   ├── 2024_校长杯.json
│   └── 2025_校长杯.json
└── supplemental/
    └── unassigned_players.json
```

其中：

- `seasons/*.json`：每个文件对应一个赛季，必须可独立导入；
- `supplemental/unassigned_players.json`：可选；
- `manifest.json`：必须符合现有清单识别规则，同时增加摘要字段；
- ZIP 内不得出现数据库表原始数组文件。

文件名需要清理 Windows 和 ZIP 不安全字符，并在重名时增加稳定短摘要。赛季身份仍以 JSON 内的 `season.name` 为准，不能依赖文件名。

## 4. 赛季 JSON 标准

### 4.1 完整示例

```json
{
  "schemaVersion": 2,
  "season": {
    "name": "2025 校长杯"
  },
  "teams": [
    {
      "name": "计算机学院",
      "players": [
        {
          "name": "张三",
          "jerseyNumbers": ["9"]
        }
      ]
    }
  ],
  "matches": [
    {
      "gameId": "match-001",
      "date": "2025-04-10",
      "time": "18:30",
      "round": "小组赛第 1 轮",
      "group": "A",
      "homeTeam": "计算机学院",
      "awayTeam": "管理学院",
      "homeScore": 2,
      "awayScore": 1,
      "penaltyShootout": {
        "homeScore": null,
        "awayScore": null,
        "kicks": []
      },
      "events": [
        {
          "eventId": "event-001",
          "time": "12",
          "eventType": "goal",
          "teamType": "home",
          "teamName": "计算机学院",
          "playerName": "张三",
          "jerseyNumber": "9"
        }
      ]
    }
  ]
}
```

### 4.2 球队和球员

每个赛季文件的 `teams` 应包含：

- 该赛季实际参赛球队；
- 该赛季球队名单中的球员；
- 球员名称；
- 该赛季对应的球衣号码。

映射来源优先使用：

```text
SeasonTeamProfile
SeasonTeamPlayer
Team
Player
```

不能只读取 `Player.teamId`，否则球员转队后会破坏历史赛季名单。

球员输出格式：

```json
{
  "name": "张三",
  "jerseyNumbers": ["9"]
}
```

现有导入器只使用第一个有效号码，因此导出时应把该赛季的正式号码放在数组第一项。

### 4.3 比赛

比赛按 `Match.seasonId` 归入对应赛季文件。

建议映射：

| 导出字段 | 数据来源 |
| --- | --- |
| `gameId` | 优先 `legacyGameId`，否则使用稳定的比赛 ID |
| `date` | `matchDate`，统一输出 `YYYY-MM-DD` |
| `time` | 从 `matchDate` 或比赛时间字段格式化 |
| `round` | 轮次/阶段展示值 |
| `group` | `groupName` |
| `homeTeam` | 主队名称 |
| `awayTeam` | 客队名称 |
| `homeScore` | 主队比分 |
| `awayScore` | 客队比分 |
| `penaltyShootout.homeScore` | 主队点球大战比分 |
| `penaltyShootout.awayScore` | 客队点球大战比分 |

`gameId` 在同一赛季内必须唯一。若 `legacyGameId` 可能重复或为空，应采用稳定规则生成，而不是使用数组序号。

### 4.4 常规事件

常规事件写入 `matches[].events`：

```json
{
  "eventId": "event-001",
  "time": "35",
  "eventType": "yellow_card",
  "teamType": "away",
  "teamName": "管理学院",
  "playerName": "李四",
  "jerseyNumber": "6"
}
```

`eventType` 必须使用当前导入器可识别值：

```text
goal
penalty
own_goal
yellow_card
red_card
penalty_miss
penalty_shootout_goal
penalty_shootout_miss
```

无法识别的事件类型不能静默写入，应让导出任务失败或记录为明确的阻断错误，否则重新导入时会被跳过。

### 4.5 点球大战

点球大战事件写入 `penaltyShootout.kicks`：

```json
{
  "eventId": "shootout-001",
  "teamType": "home",
  "teamName": "计算机学院",
  "playerName": "张三",
  "jerseyNumber": "9",
  "scored": true,
  "round": 1,
  "order": 1
}
```

导入器同时支持 `round`/`order` 和 `shootoutRound`/`shootoutOrder`，导出端固定使用前者，保持格式简洁。

## 5. Manifest 格式

Manifest 既要满足现有导入器的清单识别条件，也要提供压缩包完整性校验：

```json
{
  "schemaVersion": 2,
  "packageVersion": "1.0",
  "packageType": "portable-history-export",
  "createdAt": "2026-07-31T10:00:00.000Z",
  "rawFiles": [
    {
      "file": "seasons/2025_校长杯.json",
      "type": "season",
      "season": "2025 校长杯",
      "size": 18240,
      "checksum": "<sha256>"
    }
  ],
  "seasons": [
    {
      "name": "2025 校长杯",
      "file": "seasons/2025_校长杯.json"
    }
  ],
  "checksumAlgorithm": "sha256",
  "checksum": "<根据所有 JSON 文件摘要计算的总摘要>",
  "counts": {
    "seasons": 1,
    "teams": 20,
    "players": 320,
    "matches": 48,
    "events": 210
  },
  "excludedDataTypes": [
    "users",
    "predictions",
    "news",
    "auditLogs",
    "approvals",
    "importBatches"
  ]
}
```

`excludedDataTypes` 必须明确说明该包不是全量数据库灾备。

## 6. 导出流程

1. 在 `RepeatableRead` 事务中读取赛季及相关业务数据；
2. 按赛季构建导入器支持的业务对象；
3. 使用稳定顺序排列球队、球员、比赛和事件；
4. 逐个生成 UTF-8 JSON；
5. 对每个 JSON 计算字节数和 SHA-256；
6. 调用共享导入解析器预检每个赛季 JSON；
7. 汇总生成兼容清单格式的 `manifest.json`；
8. 将 JSON 写入 ZIP；
9. 对 ZIP 做一次解压和完整性自检；
10. 自检通过后上传 R2；
11. 写入审计日志。

推荐 R2 Key：

```text
private-backups/portable-exports/portable_export_<timestamp>.zip
```

不要与可覆盖数据库的灾备文件放在同一个恢复目录，避免用户误把可移植包当作全量备份。

## 7. 导入流程改造

### 7.1 保留现有 JSON 导入

现有多 JSON 上传、预检、摘要确认和事务导入流程继续保留。

ZIP 解压后的 `seasons/*.json` 应可直接走该流程。

### 7.2 增加 ZIP 导入

建议新增：

```text
POST /api/v1/import/history/zip/preview
POST /api/v1/import/history/zip
```

ZIP 导入步骤：

1. 校验扩展名和 ZIP 签名；
2. 校验文件数、路径、单文件大小和解压总大小；
3. 读取并校验 `manifest.json`；
4. 核对所有文件的大小和 SHA-256；
5. 把赛季 JSON 转换成内存中的 `Express.Multer.File[]`；
6. 调用与现有 JSON 上传相同的 `normalizeFiles()`；
7. 返回预检摘要；
8. 用户确认摘要后调用相同的事务导入逻辑。

不要为 ZIP 复制一套字段解析和数据库写入逻辑。

### 7.3 当前限制需要调整

现有导入器限制：

```text
一次最多 10 个 JSON
单个 JSON 最大 2 MB
```

按赛季导出后可能超过 10 个文件，单个赛季也可能超过 2 MB。应改为可配置项：

```text
HISTORY_IMPORT_MAX_FILES
HISTORY_IMPORT_MAX_FILE_BYTES
HISTORY_IMPORT_MAX_TOTAL_BYTES
HISTORY_IMPORT_MAX_ZIP_BYTES
```

建议初始值：

| 限制 | 建议值 |
| --- | ---: |
| JSON 文件数 | 100 |
| 单个 JSON | 20 MB |
| 解压后总量 | 200 MB |
| ZIP 文件 | 50 MB |
| ZIP 压缩比 | 不高于 100:1 |

最终值应根据部署环境的内存和超时时间压测确定。

## 8. 与全量灾备的关系

两种功能不能合并为同一个“恢复”按钮：

| 能力 | 可移植导出 ZIP | 全量数据库灾备 |
| --- | --- | --- |
| JSON 可提交现有导入器 | 是 | 否 |
| 可迁移赛季业务数据 | 是 | 可恢复但不适合合并导入 |
| 用户和权限 | 不包含 | 包含 |
| 预测、新闻、日志 | 不包含 | 包含 |
| 保留原始数据库 ID | 不保证 | 保证 |
| 恢复方式 | 预检后增量创建/更新 | 全库覆盖恢复 |
| 使用目录 | `portable-exports/` | `database/` |

管理端文案应分别使用：

- “导出可导入数据包”
- “创建全量灾备”

避免统一叫“备份”造成恢复能力误解。

## 9. 共享解析器改造

当前 `normalizeFiles()` 是 `ImportService` 私有方法。为保证“导出即能导入”，建议抽取：

```text
src/import/history-json-parser.ts
src/import/history-json-parser.spec.ts
```

职责：

- 识别赛季、补充和清单 JSON；
- 验证顶层结构；
- 解析球队、球员、比赛和事件；
- 生成规范化结果和错误；
- 计算批次摘要。

导入服务和导出服务必须调用同一个解析器。禁止导出端另写一套相似但不完全相同的校验规则。

## 10. 后端改造范围

建议新增：

```text
src/export/portable-export.module.ts
src/export/portable-export.controller.ts
src/export/portable-export.service.ts
src/export/portable-export-archive.ts
src/export/portable-export.service.spec.ts
src/import/history-json-parser.ts
src/import/history-zip-parser.ts
```

建议修改：

```text
src/import/import.service.ts
src/import/import.controller.ts
src/import/import.service.spec.ts
src/import/import.controller.spec.ts
```

全量灾备模块无需改成赛季 JSON；如果仍希望压缩灾备文件，应作为独立需求实施。

## 11. 管理端改造

系统管理页增加两个明确分开的入口。

### 11.1 导出可导入数据包

说明：

```text
按赛季导出球队、球员、比赛和事件，并打包为 ZIP。
解压后的 JSON 可直接在“历史数据导入”中使用。
此数据包不包含用户、权限、预测、新闻和审计日志。
```

### 11.2 导入 ZIP

- 文件选择支持 `.zip`；
- 先展示赛季、球队、球员、比赛和事件数量；
- 展示新增数、更新数、警告和错误；
- 必须经过摘要确认后才能导入；
- 显示清单中声明的排除数据类型。

## 12. 测试方案

### 12.1 格式闭环测试

这是本方案最重要的验收测试：

1. 在数据库写入多赛季数据；
2. 调用真实导出服务；
3. 解压 ZIP；
4. 将其中全部赛季 JSON 原样传给 `ImportService.previewFiles()`；
5. 断言 `canImport === true`；
6. 断言赛季、球队、球员、比赛和事件数量与 Manifest 一致；
7. 在空数据库调用真实 `importFiles()`；
8. 比较导出前和重新导入后的可移植业务数据。

任何导出的赛季 JSON 被现有预检器拒绝，都必须视为导出失败。

### 12.2 数据映射测试

至少覆盖：

- 同名球队跨多个赛季；
- 球员跨赛季转队和更换号码；
- 无 `legacyGameId` 的比赛；
- 小组赛和淘汰赛；
- 普通进球、点球、乌龙、红黄牌和罚失；
- 点球大战顺序和轮次；
- 无球员关联的球队事件；
- 空赛季、空名单和空比赛；
- 中文、空格及文件名非法字符；
- 软删除球队、球员和比赛是否排除；
- 未归属赛季球员的补充文件。

### 12.3 ZIP 安全测试

至少覆盖：

- 路径穿越；
- 绝对路径；
- 重复文件名；
- 未在 Manifest 声明的文件；
- Manifest 缺失或重复；
- SHA-256 不一致；
- ZIP 炸弹；
- 单文件或总解压大小超限；
- 文件数超限；
- 非 UTF-8 JSON；
- JSON 顶层不是对象。

### 12.4 信息损失测试

明确断言可移植包不会声称包含以下数据：

```text
User
Prediction
News
AuditLog
SeasonDeletionApproval
HistoryImportBatch
PdfImportBatch
```

Manifest 和管理端均应展示排除项。

## 13. 发布步骤

1. 抽取共享历史 JSON 解析器，保证现有导入行为不变；
2. 为共享解析器补齐现有格式测试；
3. 实现数据库到赛季 JSON 的映射；
4. 增加“导出后立即调用导入预检器”的闭环校验；
5. 实现 ZIP、Manifest 和摘要；
6. 增加 ZIP 预检和导入接口；
7. 调整文件数和大小限制为环境变量；
8. 更新管理端导出、预览和导入交互；
9. 在空数据库完成真实导出—清空—导入测试；
10. 与全量灾备分别发布和展示。

## 14. 验收标准

- ZIP 内每个赛季 JSON 都符合现有 `ImportService` 支持的格式；
- 解压后的 JSON 无需人工修改即可通过预检并导入；
- 直接上传 ZIP 与上传解压后的多个 JSON 得到相同预检摘要；
- 导出服务复用导入服务的共享解析器进行自检；
- 每个赛季一个 JSON，不按数据库表拆分；
- Manifest 可被现有导入器识别为只读清单；
- 多赛季、转队、换号码和点球大战均能正确往返；
- 不支持导入的数据被明确排除并展示；
- 可移植导出与全量灾备使用不同目录、接口和管理端入口；
- 任何格式、摘要或 ZIP 安全检查失败时均不得进入导入事务。

## 15. 备份数据删除与三超管确认

全量灾备和可移植导出均允许申请删除，但不得提供单人直接删除接口。

删除流程：

1. 一名当前有效的 `super_admin` 对指定 R2 Key 发起删除申请；
2. 系统记录对象 Key、类型、大小和 ETag/版本指纹，申请默认 24 小时过期；
3. 三名不同且在执行时仍为 `super_admin` 的用户分别确认；
4. 同一用户重复确认只计一次，申请人最多计一次；
5. 第三次有效确认通过原子状态抢占触发删除，避免并发重复执行；
6. 删除前再次读取对象元数据并核对 ETag/版本，防止同 Key 对象被替换；
7. 调用 R2 `DeleteObjectCommand` 后确认对象已不存在；
8. 保留删除申请、三人确认及审计日志，不随对象一同删除。

若系统不足三名有效超管，删除功能保持不可用，不得自动降低门槛。

建议新增数据模型：

```text
BackupDeletionRequest
BackupDeletionApproval
```

必须通过唯一约束保证同一审批人在同一申请中只能确认一次：

```text
@@unique([requestId, approverId])
```

建议接口：

```text
POST /api/v1/backups/deletion-requests
GET  /api/v1/backups/deletion-requests
POST /api/v1/backups/deletion-requests/:id/approve
POST /api/v1/backups/deletion-requests/:id/cancel
```

可删除范围只允许精确对象：

```text
private-backups/database/*.json
private-backups/database/*.zip
private-backups/portable-exports/*.zip
```

拒绝目录、前缀、路径穿越、未知扩展名及不在允许目录内的对象。

管理端使用“申请删除”按钮，展示 `1/3`、`2/3`、`3/3`、审批人、过期时间、执行状态和失败原因。发起申请前要求输入完整文件名，第三人确认前再次显示不可恢复警告。

删除功能验收标准：

- 一人或两人确认时 R2 对象仍存在；
- 三名不同的有效超管确认后只执行一次删除；
- 已降权或已删除用户的历史确认不计入最终三人；
- 过期、取消、已完成或失败申请不能继续确认；
- ETag/版本变化时拒绝删除；
- R2 失败不得在界面中伪装为删除成功；
- 删除完成后申请、审批记录和审计日志仍可查询。

## 16. MatchEvent 历史建表与 Migration 兼容说明

在历史数据库升级过程中，曾经手动使用 `prisma/baseline.sql` 补齐 `MatchEvent` 表结构。

经排查与对齐，当前系统的 Prisma 迁移链已通过以下步骤完整覆盖：
1. `prisma/schema.prisma` (L164) 包含了完整的 `MatchEvent` 数据模型定义；
2. 历史迁移 `20260723090000_add_penalty_shootout_fields/migration.sql` 中包含了 `CREATE TABLE IF NOT EXISTS "MatchEvent"` 语句；
3. Drift 校验迁移 `20260729180000_fix_schema_migration_drift/migration.sql` 完成了数据表索引与外键一致性补全。

因此独立的 `prisma/baseline.sql` 脚本已被移除，后续空库初始化及数据库迁移统一由 `npx prisma migrate deploy` 驱动管理。

