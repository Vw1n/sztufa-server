# Backup 模块拆分与重构方案

## 1. 结论

`src/backup/` 可以按职责拆分，现有代码已经具备较清晰的功能边界，整体不存在明显的循环依赖障碍。

建议分两阶段实施：

1. 优先拆分 `BackupService`，保留其作为兼容门面。
2. 再拆分 serializer，将生成器与解析器分离，并保留原文件作为兼容出口。

预期可将 `backup.service.ts` 从约 1019 行缩减到约 120 行。生产调用方与控制器可以保持不变，但 Service 单元测试和恢复集成测试需要适配新的依赖注入结构，不能承诺所有测试文件零改动。

## 2. 当前模块结构

`src/backup/` 当前共约 5353 行：

| 文件 | 行数 | 职责评价 |
|---|---:|---|
| `backup.service.ts` | 1019 | God Service：导出、列表、校验、恢复、直传、删除和保留清理混合在一个类中 |
| `backup-serializer.ts` | 933 | 同时包含流式生成和流式解析状态机 |
| `backup-validator.ts` | 467 | 职责较单一，但体积偏大 |
| `backup-staging-store.ts` | 234 | SQLite 暂存，职责单一 |
| `backup-table-registry.ts` | 234 | 表元数据注册，职责单一 |
| `backup-retention.service.ts` | 175 | 保留策略，已经拆分合理 |
| `backup-scope.service.ts` | 97 | 备份范围处理，已经拆分合理 |
| `backup.controller.ts` | 188 | 薄控制器，边界合理 |

## 3. BackupService 内部边界

| 区域 | 当前行号 | 约行数 | 职责 |
|---|---:|---:|---|
| 私有工具 | 79–133 | 55 | S3 Client、key 校验、HMAC、TTL |
| `createBackup` | 135–300 | 165 | 分页迭代器、流上传、失败清理 |
| 列表与校验 | 302–452 | 150 | 列表、完整性验证、下载 URL |
| `restoreBackup` | 453–624 | 171 | 恢复前快照、advisory lock、事务重建 |
| 上传链路 | 626–854 | 228 | token 签发和校验、hash 校验、转存 |
| 删除与清理 | 856–1013 | 158 | 防误删和保留策略执行 |

各区域主要只共享 Prisma、审计日志和对象存储能力，适合按职责拆分。

## 4. 建议目录结构

```text
src/backup/
  backup.types.ts                 # 公共类型，消除服务间反向类型依赖
  backup-format.ts                # 备份格式、manifest、解析结果等共享类型
  backup-object-store.service.ts  # R2 基础操作与 key/prefix 安全
  backup-verification.service.ts  # 解析、schema、checksum、外键完整性验证
  backup-export.service.ts        # createBackup
  backup-restore.service.ts       # restoreBackup
  backup-upload.service.ts        # initUpload、completeUpload
  backup-maintenance.service.ts   # deleteBackup、cleanRetention
  backup.service.ts               # 兼容门面，保留原公开方法
  backup-writer.ts                # 流式生成
  backup-parser.ts                # 流式解析状态机
  backup-serializer.ts            # writer/parser 的兼容 re-export
  backup.module.ts                # 注册内部服务，仅按需导出公共服务
```

## 5. 服务职责

### 5.1 BackupObjectStoreService

只负责对象存储基础设施能力：

- 创建和持有 `S3Client`
- 校验 backup key 和 prefix
- put、get、list、head、copy、delete
- presign
- 上传流和取消上传
- 读取对象元数据

不建议把完整性验证放入该服务。完整性验证会依赖 parser、schema validator 和外键规则，属于备份领域逻辑，而不是通用对象存储能力。

### 5.2 BackupVerificationService

负责可复用的备份验证流程：

- 解析压缩或未压缩的备份流
- 校验格式版本和 manifest
- 校验 checksum、文件 SHA-256、表数量
- 校验暂存数据中的外键
- 确保所有路径正确执行 `cleanup()`

该服务供列表完整性验证、恢复和上传完成链路复用。

### 5.3 BackupExportService

负责：

- 解析备份范围
- 按游标分页读取数据
- 构建 V3 备份流
- 上传备份对象
- 响应客户端取消信号
- 上传失败后的补偿清理
- 记录导出审计日志

### 5.4 BackupRestoreService

负责：

- 功能开关和确认文本校验
- 下载并验证备份
- 校验恢复范围
- 创建恢复前快照
- 获取 advisory lock
- 在事务中按既定顺序删除和重建数据
- 失败时清理 staging 资源并记录审计日志

该服务单向依赖 `BackupExportService`，用于创建恢复前快照。

### 5.5 BackupUploadService

负责：

- 生成和验证无状态 HMAC upload token
- 限制 TTL 和文件大小
- 生成临时上传 URL
- 服务端重新计算 SHA-256
- 验证上传内容
- 将临时对象提升为正式备份对象
- 失败和过期场景下清理临时对象

### 5.6 BackupMaintenanceService

负责：

- 强确认删除
- 防止删除受保护备份
- 计算保留策略
- 验证最小可恢复点数量
- 执行物理删除或 dry-run
- 记录维护审计日志

### 5.7 BackupService 门面

保留现有公开方法签名，并委托给对应子服务：

```ts
@Injectable()
export class BackupService {
  constructor(
    private readonly exportService: BackupExportService,
    private readonly restoreService: BackupRestoreService,
    private readonly uploadService: BackupUploadService,
    private readonly maintenanceService: BackupMaintenanceService,
    private readonly objectStore: BackupObjectStoreService,
    private readonly verificationService: BackupVerificationService,
  ) {}

  createBackup(...args: Parameters<BackupExportService['createBackup']>) {
    return this.exportService.createBackup(...args);
  }

  // 其余公开方法采用相同的显式委托方式。
}
```

门面应使用显式方法，不建议通过动态代理或继承拼装接口，以便保留类型提示、可读堆栈和稳定的 Nest 依赖关系。

## 6. 公共类型与依赖方向

当前 `backup-retention.service.ts` 从 `backup.service.ts` 导入 `BackupMetadata`。拆分后如果门面继续依赖 retention，会形成不合理的反向依赖。

建议将以下类型移动到 `backup.types.ts`：

- `BackupMetadata`
- `UploadInitResult`
- `CreateBackupOptions`
- 上传 token payload
- retention 结果和维护操作结果类型

`backup.service.ts` 可以继续 re-export 这些类型，以维持现有外部 import 的兼容性：

```ts
export type {
  BackupMetadata,
  UploadInitResult,
  CreateBackupOptions,
} from './backup.types';
```

## 7. Serializer 拆分策略

serializer 的解析部分是一个大型单循环状态机，不建议为追求小函数而强行拆碎。只进行文件级分离：

- `backup-writer.ts`：`createV3BackupStream`
- `backup-parser.ts`：`parseAndValidateBackupStream`
- `backup-format.ts`：manifest、版本、解析结果等共享类型

现有测试直接或动态加载 `./backup-serializer`，因此必须保留兼容文件：

```ts
export { createV3BackupStream } from './backup-writer';
export {
  parseAndValidateBackupStream,
  type ParseStreamResult,
} from './backup-parser';
```

这样可以在不修改现有 serializer 调用方的情况下完成内部拆分。

## 8. 关键事务与一致性风险

### 8.1 恢复前快照不是恢复事务的一部分

当前语义近似为：

```text
验证目标备份 → 创建恢复前快照 → 开启恢复事务
```

快照完成与恢复事务启动之间仍可能出现业务写入。拆分不会制造这个问题，但实施时应明确保留还是加强该语义。

至少需要保证：

- 恢复前快照失败时恢复操作 fail-closed；
- advisory lock 的获取时机有明确测试；
- 文档说明恢复前快照是否是严格一致性快照；
- 若要求严格一致性，需要额外阻止写入或重新设计锁和快照顺序。

### 8.2 上传完成链路不是原子操作

R2 的提升流程通常是：

```text
验证临时对象 → CopyObject → Head/确认正式对象 → Delete 临时对象
```

需要明确：

- copy 成功但临时对象删除失败时如何补偿；
- 正式 key 已存在时覆盖还是拒绝；
- 客户端重复调用 `completeUpload` 是否幂等；
- audit log 失败是否影响业务成功结果；
- 进程在 copy 和 delete 之间退出时如何清理孤儿对象。

这些编排逻辑应留在 `BackupUploadService`，对象存储服务只提供原子基础操作。

### 8.3 资源释放必须结构化

parser 返回的 staging store 和临时文件必须在所有成功、失败和提前返回路径中释放。建议统一使用 `try/finally`，并补充以下回归测试：

- parser 失败后释放；
- checksum 失败后释放；
- 外键验证失败后释放；
- 恢复事务失败后释放；
- 上传提升失败后释放；
- 客户端取消导出后中止上传。

## 9. Nest 模块边界

建议先将所有子服务注册为 provider，但只导出稳定公共 API：

```ts
@Module({
  providers: [
    BackupService,
    BackupObjectStoreService,
    BackupVerificationService,
    BackupExportService,
    BackupRestoreService,
    BackupUploadService,
    BackupMaintenanceService,
    BackupRetentionService,
    BackupScopeService,
  ],
  controllers: [BackupController],
  exports: [BackupService],
})
export class BackupModule {}
```

只有出现明确的跨模块复用需求时，再导出 object store 或其他内部服务，避免过早扩大公共 API。

## 10. 测试影响

“所有 spec 零改动”不成立，实际影响如下：

| 测试 | 预期影响 |
|---|---|
| `backup.controller.spec.ts` | 可保持不变，仍 mock `BackupService` 门面 |
| `backup.service.spec.ts` | 需要注册新子服务，或改为分别测试各领域服务 |
| `backup.restore.integration.spec.ts` | 当前直接 `new BackupService(...)`，必须改为测试模块或测试工厂 |
| `backup-validator.spec.ts` | serializer 保留兼容出口时可保持不变 |
| `backup-memory.spec.ts` | 动态加载原 serializer 文件，必须保留兼容文件才能保持不变 |

建议建立测试分层：

- 门面契约测试：确认每个公开方法委托到正确服务并原样返回结果；
- 子服务单元测试：按导出、恢复、上传、维护分别测试；
- 对象存储适配器测试：集中 mock AWS SDK；
- 真实 PostgreSQL 恢复集成测试：继续覆盖完整导出和恢复链路；
- serializer 内存与限制测试：继续覆盖压缩炸弹、单记录大小、cleanup 和内存上限。

## 11. 分阶段实施计划

### 阶段一：拆分 Service

1. 新增 `backup.types.ts`，迁移公共类型并由原文件 re-export。
2. 新增 `BackupObjectStoreService`，集中封装 AWS SDK。
3. 新增 `BackupVerificationService`，集中复用解析和校验流程。
4. 拆出 export、restore、upload、maintenance 服务。
5. 将 `BackupService` 改为显式委托门面。
6. 更新 `BackupModule` provider。
7. 调整 Service 单测和恢复集成测试的构造方式。
8. 运行 lint、类型检查、单元测试和恢复集成测试。

### 阶段二：拆分 Serializer

1. 新增 `backup-format.ts`。
2. 将 writer 移入 `backup-writer.ts`。
3. 将 parser 状态机移入 `backup-parser.ts`。
4. 保留 `backup-serializer.ts` 作为兼容 re-export。
5. 运行 validator、memory、service 和 restore integration 测试。

## 12. 验收标准

- `BackupService` 仅承担兼容门面职责，目标不超过约 150 行。
- 每个子服务具有单一、可描述的职责。
- 服务依赖方向单向，无 `forwardRef`。
- R2 SDK 细节不泄漏到 export、restore、maintenance 的业务代码中。
- `BackupMetadata` 等公共类型不再定义于门面服务文件中。
- 控制器公开行为和响应结构保持兼容。
- serializer 原 import 路径保持兼容。
- 所有 staging 和上传资源在异常路径下均被释放或补偿。
- 单元测试、内存测试、类型检查和 lint 全部通过。
- 配置真实测试数据库时，恢复集成测试通过。

## 13. 收益与成本

### 收益

- `BackupService` 预计减重约 85%–90%。
- 导出、恢复、上传和维护链路可以独立审查与测试。
- 安全敏感的上传 token 和完整性验证逻辑得到隔离。
- AWS SDK mock 集中，减少测试重复和脆弱性。
- 后续更换对象存储实现时影响范围更小。

### 成本与风险

- Service 单元测试和恢复集成测试需要适配。
- validator、parser 和 staging store 的类型边界需要谨慎调整。
- 上传提升和恢复前快照的一致性语义需要补充测试与文档。
- 一次性同时拆 Service 和 parser 会增加回归定位成本，因此推荐分阶段提交。

## 14. 最终建议

按上述方案实施，但将原计划调整为：

> 拆分可行。生产调用方与控制器测试可保持不变；Service 单元测试和恢复集成测试需要适配新的依赖注入结构。优先完成 Service 拆分并稳定测试，再进行 serializer 的文件级拆分，同时保留兼容出口。
