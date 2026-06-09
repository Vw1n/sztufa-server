import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import { ExpressAdapter } from '@nestjs/platform-express';
import { AppModule } from './app.module';
import express from 'express';

const server = express();

async function createApp() {
  const app = await NestFactory.create(
    AppModule,
    new ExpressAdapter(server),
    { logger: ['error', 'warn', 'log'] }
  );

  app.useGlobalPipes(new ValidationPipe({
    whitelist: true,
    transform: true,
    forbidNonWhitelisted: true,
  }));

  app.enableCors();

  const config = new DocumentBuilder()
    .setTitle('校园足球信息管理平台 API')
    .setDescription('校园足球信息管理平台后端服务接口文档')
    .setVersion('1.0')
    .addBearerAuth()
    .build();

  const document = SwaggerModule.createDocument(app, config);
  SwaggerModule.setup('api/docs', app, document);

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
  const app = await createApp();
  await app.init();
  server(req, res);
}