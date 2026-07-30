import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import { ExpressAdapter } from '@nestjs/platform-express';
import helmet from 'helmet';
import { AppModule } from './app.module';
import { PrismaClientExceptionFilter } from './prisma/prisma-client-exception.filter';
import { createSingleFlightInitializer } from './serverless/single-flight-initializer';
import express from 'express';

function validateStartupConfig() {
  const requiredEnvVars = [
    'DATABASE_URL',
    'JWT_SECRET',
    'R2_ENDPOINT',
    'R2_ACCESS_KEY_ID',
    'R2_SECRET_ACCESS_KEY',
    'R2_BUCKET_NAME',
  ];

  const missing = requiredEnvVars.filter((key) => !process.env[key]);
  const isProduction = process.env.NODE_ENV === 'production';

  if (isProduction && missing.length > 0) {
    throw new Error(`[FATAL CONFIG ERROR] 生产环境缺少必要环境变量: ${missing.join(', ')}`);
  }

  const insecureSecrets = ['super-secret-key', 'dev-secret', 'default-jwt-secret', 'change-me'];
  if (
    isProduction &&
    (!process.env.JWT_SECRET || insecureSecrets.includes(process.env.JWT_SECRET))
  ) {
    throw new Error(
      '[FATAL CONFIG ERROR] 生产环境拒绝使用默认或不安全的 JWT_SECRET，请设置安全的随机密钥',
    );
  }
}

const server = express();

async function initializeApp() {
  validateStartupConfig();

  const app = await NestFactory.create(AppModule, new ExpressAdapter(server), {
    logger: ['error', 'warn', 'log'],
  });

  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'", "'unsafe-inline'", "'unsafe-eval'"],
          styleSrc: ["'self'", "'unsafe-inline'"],
          imgSrc: ["'self'", 'data:', 'blob:', 'https:'],
          connectSrc: ["'self'", 'https:'],
        },
      },
      crossOriginEmbedderPolicy: false,
      referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
      hsts: process.env.NODE_ENV === 'production',
    }),
  );

  app.useGlobalFilters(new PrismaClientExceptionFilter());

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      forbidNonWhitelisted: true,
    }),
  );

  // API responses must not be reused across origins. A cached 304 response can
  // otherwise retain an old Access-Control-Allow-Origin value in the browser.
  app.use('/api', (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });

  const allowedOrigins = new Set([
    'https://sztufa.xyz',
    'https://www.sztufa.xyz',
    'https://admin.sztufa.xyz',
    'https://api.sztufa.xyz',
    'https://dev.sztufa.xyz',
    'https://admin-dev.sztufa.xyz',
    'https://api-dev.sztufa.xyz',
    'https://sztufa-server.vercel.app',
    'http://localhost:3000',
    'http://127.0.0.1:3000',
    'http://localhost:3002',
    'http://127.0.0.1:3002',
    'http://localhost:5173',
    'http://127.0.0.1:5173',
    'http://localhost:8080',
  ]);

  app.enableCors({
    origin: (origin, callback) => {
      if (!origin || allowedOrigins.has(origin)) {
        callback(null, true);
        return;
      }

      callback(new Error(`Origin ${origin} is not allowed by CORS`), false);
    },
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH'],
    credentials: true,
  });

  if (process.env.NODE_ENV !== 'production' || process.env.ENABLE_SWAGGER === 'true') {
    const config = new DocumentBuilder()
      .setTitle('校园足球信息管理平台 API')
      .setDescription('校园足球信息管理平台后端服务接口文档')
      .setVersion('1.0')
      .addBearerAuth()
      .build();

    const document = SwaggerModule.createDocument(app, config);

    const expressApp = app.getHttpAdapter().getInstance();
    expressApp.use('/api/docs', express.static(__dirname + '/swagger-ui'));
    expressApp.get('/api/docs/swagger.json', (req, res) => {
      res.setHeader('Content-Type', 'application/json');
      res.send(document);
    });
  }

  await app.init();
  return app;
}

// Vercel 冷启动时图片请求会并发进入同一个函数实例。所有请求必须等待
// 同一次 Nest 初始化完成，否则多个应用会同时向 Express 注册路由，
// ThrottlerGuard 等生命周期组件可能在 onModuleInit 前被调用。
const createApp = createSingleFlightInitializer(initializeApp);

async function bootstrap() {
  const app = await createApp();
  await app.listen(process.env.PORT || 3000);
}

if (require.main === module) {
  bootstrap();
}

export default async function handler(req, res) {
  await createApp();
  server(req, res);
}
