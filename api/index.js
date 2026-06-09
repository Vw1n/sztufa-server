require('dotenv').config();

const express = require('express');
const { NestFactory } = require('@nestjs/core');
const { ExpressAdapter } = require('@nestjs/platform-express');
const { ValidationPipe } = require('@nestjs/common');
const { SwaggerModule, DocumentBuilder } = require('@nestjs/swagger');
const { AppModule } = require('../dist/app.module');

const server = express();

let appInstance = null;

async function getApp() {
  if (!appInstance) {
    appInstance = await NestFactory.create(
      AppModule,
      new ExpressAdapter(server),
      { logger: ['error', 'warn', 'log'] }
    );

    appInstance.useGlobalPipes(new ValidationPipe({
      whitelist: true,
      transform: true,
      forbidNonWhitelisted: true,
    }));

    appInstance.enableCors();

    const config = new DocumentBuilder()
      .setTitle('校园足球信息管理平台 API')
      .setDescription('校园足球信息管理平台后端服务接口文档')
      .setVersion('1.0')
      .addBearerAuth()
      .build();

    const document = SwaggerModule.createDocument(appInstance, config);
    SwaggerModule.setup('api/docs', appInstance, document);

    await appInstance.init();
  }
  return appInstance;
}

module.exports = async (req, res) => {
  await getApp();
  server(req, res);
};