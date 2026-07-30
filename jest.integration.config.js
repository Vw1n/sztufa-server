module.exports = {
  moduleFileExtensions: ['js', 'json', 'ts'],
  rootDir: 'src',
  testRegex: '.*\\.integration\\.spec\\.ts$',
  transform: {
    '^.+\\.(t|j)s$': 'ts-jest',
  },
  testEnvironment: 'node',
  // 远程 PostgreSQL 会执行 17 表的逐表快照、清库、恢复和回滚验证。
  // 为网络往返保留余量；CI 本地 service container 通常会快得多。
  testTimeout: 180000,
};
