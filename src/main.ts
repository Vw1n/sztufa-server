import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import { ExpressAdapter } from '@nestjs/platform-express';
import { AppModule } from './app.module';
import { PrismaClientExceptionFilter } from './prisma/prisma-client-exception.filter';
import express from 'express';

const server = express();
let appInstance = null;

async function createApp() {
  if (appInstance) {
    return appInstance;
  }

  const app = await NestFactory.create(AppModule, new ExpressAdapter(server), {
    logger: ['error', 'warn', 'log'],
  });

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

  await app.init();
  appInstance = app;
  return app;
}

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
