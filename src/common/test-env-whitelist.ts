/**
 * 严格校验测试运行的目标环境白名单，强制所有参数显式传入且完全受控，杜绝在生产环境或非测试库误执行
 */
export function assertSafeTestEnvironment(params: {
  apiBase?: string;
  databaseUrl: string;
  storageEndpoint: string;
  bucketName: string;
}) {
  const { apiBase, databaseUrl, storageEndpoint, bucketName } = params;

  if (!databaseUrl) {
    throw new Error('[安全白名单] databaseUrl 必须显式配置，禁止缺失');
  }
  if (!storageEndpoint) {
    throw new Error('[安全白名单] storageEndpoint 必须显式配置，禁止缺失');
  }
  if (!bucketName) {
    throw new Error('[安全白名单] bucketName 必须显式配置，禁止缺失');
  }

  if (apiBase) {
    const apiUrl = new URL(apiBase);
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(apiUrl.hostname)) {
      throw new Error(
        `[安全白名单] API 地址必须为本地测试隔离环境 (127.0.0.1 / localhost)，当前为: ${apiBase}`,
      );
    }
  }

  const dbUrl = new URL(databaseUrl);
  if (!['postgres:', 'postgresql:'].includes(dbUrl.protocol)) {
    throw new Error('[安全白名单] 数据库必须使用 PostgreSQL 协议');
  }
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(dbUrl.hostname)) {
    throw new Error(
      `[安全白名单] 数据库主机必须为本地隔离环境 (127.0.0.1 / localhost)，当前为: ${dbUrl.hostname}`,
    );
  }
  const dbName = dbUrl.pathname.replace(/^\//, '');
  if (!['sztufa_e2e', 'sztufa_member_test', 'sztufa_test'].includes(dbName)) {
    throw new Error(
      `[安全白名单] 数据库名称必须在受控专用测试库内 (sztufa_e2e / sztufa_member_test / sztufa_test)，当前为: ${dbName}`,
    );
  }

  const storageUrl = new URL(storageEndpoint);
  if (
    !['127.0.0.1', 'localhost', '[::1]'].includes(storageUrl.hostname) ||
    storageUrl.port !== '9000' ||
    storageUrl.protocol !== 'http:' ||
    storageUrl.username ||
    storageUrl.password ||
    storageUrl.search ||
    storageUrl.hash ||
    storageUrl.pathname !== '/'
  ) {
    throw new Error(
      `[安全白名单] 存储服务 Endpoint 必须为本地 MinIO 专用端口 (:9000)，当前为: ${storageEndpoint}`,
    );
  }

  if (!['sztufa-e2e-private-cards', 'sztufa-member-test-cards'].includes(bucketName)) {
    throw new Error(
      `[安全白名单] 存储桶名称必须在专用测试桶白名单内 (sztufa-e2e-private-cards / sztufa-member-test-cards)，当前为: ${bucketName}`,
    );
  }
}
