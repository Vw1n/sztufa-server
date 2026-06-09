# Vercel 部署指南

本指南将帮助你将校园足球信息管理平台后端服务部署到 Vercel 平台。

## 前置要求

1. Vercel 账号（https://vercel.com）
2. GitHub 账号（用于代码仓库连接）
3. PostgreSQL 数据库（推荐使用 Vercel Postgres）
4. Node.js 18+ 环境

## 部署步骤

### 1. 准备代码仓库

将项目推送到 GitHub 仓库：

```bash
git init
git add .
git commit -m "Initial commit for Vercel deployment"
git branch -M main
git remote add origin https://github.com/your-username/sztu-fa-backend.git
git push -u origin main
```

### 2. 创建 Vercel Postgres 数据库（推荐）

1. 登录 Vercel 控制台
2. 进入你的项目或创建新项目
3. 导航到 Storage 标签
4. 点击 "Create Database"
5. 选择 "Postgres" 并创建数据库
6. 复制生成的 `DATABASE_URL`

### 3. 配置环境变量

在 Vercel 项目设置中配置以下环境变量：

| 变量名 | 说明 | 示例值 |
|--------|------|--------|
| `DATABASE_URL` | PostgreSQL 数据库连接字符串 | `postgresql://user:password@host:port/database?schema=public` |
| `JWT_SECRET` | JWT 密钥（必须修改） | `your-super-secret-jwt-key-change-in-production` |
| `JWT_EXPIRES_IN` | JWT 过期时间 | `3600s` |
| `NODE_ENV` | 运行环境 | `production` |

**重要提示：**
- `JWT_SECRET` 必须设置为强随机字符串
- 不要在代码中硬编码敏感信息
- 生产环境必须使用真实的数据库连接字符串

### 4. 连接 GitHub 仓库

1. 在 Vercel 控制台中点击 "Add New Project"
2. 选择 "Import Git Repository"
3. 选择你的 GitHub 仓库
4. Vercel 会自动检测项目配置

### 5. 配置构建设置

Vercel 会自动识别以下配置：

**构建命令：** `npm run vercel-build`
**输出目录：** `dist`
**安装命令：** `npm install`

如果需要手动配置，在项目设置中：
- Build Command: `npm run vercel-build`
- Output Directory: `dist`

### 6. 执行数据库迁移

部署完成后，需要运行数据库迁移：

1. 在 Vercel 项目中打开终端
2. 运行以下命令：

```bash
npx prisma migrate deploy
```

或者通过 Vercel CLI：

```bash
vercel env pull .env.local
npx prisma migrate deploy
```

### 7. 验证部署

部署完成后，你可以通过以下方式验证：

1. **检查部署状态**
   - 在 Vercel 控制台查看部署日志
   - 确保没有错误信息

2. **测试 API 端点**
   - 访问 `https://your-app.vercel.app/api/docs` 查看 Swagger 文档
   - 测试基本的 API 端点

3. **检查数据库连接**
   - 确认数据库迁移成功执行
   - 验证数据表创建正确

## 项目结构说明

```
sztu-fa-backend/
├── src/
│   ├── vercel.ts          # Vercel Serverless 入口文件
│   ├── main.ts            # 本地开发入口文件
│   ├── app.module.ts      # 应用主模块
│   └── ...                # 其他模块
├── prisma/
│   └── schema.prisma      # 数据库模型定义
├── vercel.json            # Vercel 配置文件
├── package.json           # 项目依赖和脚本
├── .env.example           # 环境变量示例
└── .vercelignore          # Vercel 忽略文件
```

## 关键配置文件

### vercel.json
```json
{
  "version": 2,
  "builds": [
    {
      "src": "dist/vercel.js",
      "use": "@vercel/node"
    }
  ],
  "routes": [
    {
      "src": "/(.*)",
      "dest": "dist/vercel.js"
    }
  ],
  "env": {
    "NODE_ENV": "production"
  }
}
```

### package.json 关键脚本
```json
{
  "scripts": {
    "build": "nest build",
    "vercel-build": "npm run build && prisma generate",
    "start:prod": "node dist/main"
  }
}
```

## 常见问题解决

### 1. 构建失败

**问题：** 依赖安装失败
**解决：** 检查 `package.json` 中的依赖版本，确保兼容性

**问题：** TypeScript 编译错误
**解决：** 本地运行 `npm run build` 检查编译错误

### 2. 数据库连接失败

**问题：** `DATABASE_URL` 配置错误
**解决：** 
- 确认数据库连接字符串格式正确
- 检查数据库是否允许 Vercel IP 访问
- 验证数据库用户权限

### 3. 运行时错误

**问题：** 模块未找到
**解决：** 检查 `tsconfig.json` 中的路径别名配置

**问题：** 环境变量未加载
**解决：** 确认在 Vercel 项目设置中正确配置了所有环境变量

### 4. 性能优化

**建议：**
- 启用 Vercel Edge Functions（如适用）
- 配置适当的缓存策略
- 优化数据库查询
- 使用 CDN 分发静态资源

## 监控和日志

### 访问日志
- 在 Vercel 控制台的 "Logs" 标签查看实时日志
- 使用 `vercel logs` 命令通过 CLI 查看日志

### 性能监控
- Vercel Analytics 提供性能指标
- 配置自定义错误追踪（如 Sentry）

## 本地开发

### 安装依赖
```bash
npm install
```

### 配置本地环境变量
```bash
cp .env.example .env
# 编辑 .env 文件，配置本地数据库连接
```

### 运行数据库迁移
```bash
npx prisma migrate dev
```

### 启动开发服务器
```bash
npm run start:dev
```

### 本地构建测试
```bash
npm run build
npm run start:prod
```

## 部署检查清单

- [ ] 代码已推送到 GitHub 仓库
- [ ] Vercel Postgres 数据库已创建
- [ ] 环境变量已正确配置
- [ ] `DATABASE_URL` 连接字符串有效
- [ ] `JWT_SECRET` 已设置为强随机字符串
- [ ] 数据库迁移已成功执行
- [ ] API 端点可正常访问
- [ ] Swagger 文档可正常查看
- [ ] 错误日志监控已配置

## 更新部署

当代码更新后，只需推送到 GitHub 主分支：

```bash
git add .
git commit -m "Update application"
git push origin main
```

Vercel 会自动触发重新部署。

## 回滚部署

如需回滚到之前的版本：

1. 在 Vercel 控制台导航到 "Deployments"
2. 找到目标部署版本
3. 点击 "..." 菜单
4. 选择 "Promote to Production"

## 技术支持

如遇到部署问题，请检查：

1. Vercel 部署日志
2. GitHub Actions 工作流状态
3. 数据库连接状态
4. 环境变量配置

## 安全建议

1. 定期更新依赖包
2. 使用强密码和密钥
3. 启用 HTTPS
4. 配置适当的 CORS 策略
5. 实施速率限制
6. 定期备份数据库

## 成本估算

Vercel 免费套餐包括：
- 100GB 带宽/月
- 6,000 分钟构建时间/月
- 无限部署

Vercel Postgres 免费套餐：
- 512MB 存储
- 60 小时计算时间/月
- 1 亿行读取/月

超出免费套餐后按使用量计费。

## 总结

按照本指南，你应该能够成功将校园足球信息管理平台后端服务部署到 Vercel。部署后，你的应用将获得：

- 自动 HTTPS
- 全球 CDN 分发
- 自动扩缩容
- 持续集成/持续部署
- 实时日志和监控

如有任何问题，请参考 Vercel 官方文档或联系技术支持。