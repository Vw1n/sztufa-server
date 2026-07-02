# 校园足球信息管理平台后端服务

## 项目简介

本项目是一个基于 **NestJS + TypeScript + PostgreSQL** 的校园足球信息管理平台后端服务，为校园足球赛事提供完整的数字化管理解决方案。

主要功能模块：
- **用户认证** - JWT 令牌认证，配置支持 ConfigService 异步验签与过期时间
- **图片上传** - 接入 Cloudflare R2，使用 sharp 库对图片进行 WebP 格式压缩并上传
- **球队管理** - 球队信息的增删改查及 Logo 地址关联
- **球员管理** - 球员信息管理，支持关联球队
- **比赛管理** - 比赛日程、结果记录和统计
- **数据导入** - 支持从 JSON 文件批量导入数据
- **赛事关键事件流** - 支持进球（普通/点球/乌龙）、换人（双下拉列表）、红黄牌等事件的时序数据存取

## 技术栈

| 分类 | 技术 | 版本 |
|------|------|------|
| 框架 | NestJS | ^10.0.0 |
| 语言 | TypeScript | ^5.3.2 |
| 数据库 | PostgreSQL | ^16.x |
| ORM | Prisma | ^5.7.0 |
| 认证 | JWT | ^10.2.0 |
| API 文档 | Swagger | ^7.1.17 |

## 快速开始

### 环境要求

- Node.js >= 20.x
- PostgreSQL >= 16.x
- Docker (可选，推荐用于快速部署)

### 安装依赖

```bash
npm install
```

### 数据库配置

1. 创建 PostgreSQL 数据库 `sztu_fa`
2. 修改 `.env` 文件配置数据库连接：

```env
DATABASE_URL="postgresql://username:password@localhost:5432/sztu_fa?schema=public"
JWT_SECRET="your-secret-key-here"
PORT=3001
```

### 运行数据库迁移

```bash
npx prisma migrate dev
```

### 启动开发服务器

```bash
npm run start:dev
```

服务将在 `http://localhost:3001` 启动。

### 使用 Docker Compose (推荐)

```bash
docker-compose up -d
```

Docker Compose 将自动创建数据库容器和应用容器，无需手动配置数据库。

## API 文档

启动服务后访问 Swagger 文档：
- **地址**: http://localhost:3001/api/docs
- **格式**: OpenAPI 3.0

## 项目结构

```
src/
├── auth/           # 认证模块（注册、登录、JWT守卫）
│   ├── dto/        # 数据传输对象
│   ├── auth.controller.ts
│   ├── auth.service.ts
│   ├── auth.module.ts
│   ├── jwt-auth.guard.ts
│   └── jwt.strategy.ts
├── team/           # 球队模块
│   ├── dto/
│   ├── team.controller.ts
│   ├── team.service.ts
│   └── team.module.ts
├── player/         # 球员模块
│   ├── dto/
│   ├── player.controller.ts
│   ├── player.service.ts
│   └── player.module.ts
├── match/          # 比赛模块
│   ├── dto/
│   ├── match.controller.ts
│   ├── match.service.ts
│   └── match.module.ts
├── import/         # 数据导入模块
│   ├── import.controller.ts
│   ├── import.service.ts
│   └── import.module.ts
├── prisma/         # Prisma 服务配置
│   └── prisma.service.ts
├── app.module.ts   # 主模块
└── main.ts         # 应用入口
```

## API 端点

### 认证接口

| 方法 | 路径 | 描述 |
|------|------|------|
| POST | `/api/v1/auth/register` | 用户注册 |
| POST | `/api/v1/auth/login` | 用户登录 |

### 球队接口

| 方法 | 路径 | 描述 |
|------|------|------|
| GET | `/api/v1/teams` | 获取球队列表 |
| POST | `/api/v1/teams` | 创建球队 |
| GET | `/api/v1/teams/:id` | 获取单个球队详情 |
| PATCH | `/api/v1/teams/:id` | 更新球队信息 |
| DELETE | `/api/v1/teams/:id` | 删除球队 |

### 球员接口

| 方法 | 路径 | 描述 |
|------|------|------|
| GET | `/api/v1/players` | 获取球员列表 |
| POST | `/api/v1/players` | 创建球员 |
| GET | `/api/v1/players/:id` | 获取单个球员详情 |
| PATCH | `/api/v1/players/:id` | 更新球员信息 |
| DELETE | `/api/v1/players/:id` | 删除球员 |

### 比赛接口

| 方法 | 路径 | 描述 |
|------|------|------|
| GET | `/api/v1/matches` | 获取比赛列表 |
| POST | `/api/v1/matches` | 创建比赛 |
| GET | `/api/v1/matches/:id` | 获取单个比赛详情 |
| PATCH | `/api/v1/matches/:id` | 更新比赛信息 |
| DELETE | `/api/v1/matches/:id` | 删除比赛 |

### 数据导入接口

| 方法 | 路径 | 描述 |
|------|------|------|
| POST | `/api/v1/import/json` | 从 JSON 文件导入球队和球员数据 |

## 脚本命令

```bash
# 启动开发服务器
npm run start:dev

# 构建生产版本
npm run build

# 启动生产服务器
npm run start:prod

# 运行测试
npm test

# 运行测试（带覆盖率）
npm run test:cov

# 代码检查
npm run lint

# 代码格式化
npm run format

# Prisma 迁移
npm run prisma:migrate

# Prisma 生成客户端
npm run prisma:generate
```

## 数据库模型

### 核心实体

- **User** - 用户信息（认证用）
- **Team** - 球队信息
- **Player** - 球员信息（关联球队）
- **Match** - 比赛信息（关联两支球队）

### 关联关系

- Player → Team（多对一）
- Match → Team（主客队各一个）

## 部署说明

### 生产环境部署

1. 设置环境变量
2. 运行数据库迁移：`npm run prisma:deploy`
3. 构建项目：`npm run build`
4. 启动服务：`npm run start:prod`

### Docker 部署

```bash
# 构建镜像
docker build -t sztu-fa-backend .

# 运行容器
docker run -p 3001:3001 --env-file .env sztu-fa-backend
```

## 安全说明

- 使用 bcryptjs 加密用户密码
- JWT 令牌有效期配置
- 使用 Passport 进行身份验证
- API 端点使用 JWT Guard 保护

## 许可证

MIT License
