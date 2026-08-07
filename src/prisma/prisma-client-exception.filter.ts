import { ArgumentsHost, Catch, ExceptionFilter, HttpStatus, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { Response } from 'express';

@Catch(Prisma.PrismaClientKnownRequestError)
export class PrismaClientExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(PrismaClientExceptionFilter.name);

  catch(exception: Prisma.PrismaClientKnownRequestError, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();

    this.logger.error(`Prisma Known Request Error [${exception.code}]: ${exception.message}`, exception.stack);

    switch (exception.code) {
      case 'P2002': {
        const status = HttpStatus.CONFLICT;
        const targets = (exception.meta?.target as string[]) || [];
        const targetNames = targets
          .map((t) => {
            if (t === 'username') return '用户名';
            if (t === 'name') return '名称';
            return t;
          })
          .join(', ');

        response.status(status).json({
          statusCode: status,
          message: `数据冲突：${targetNames || '存在重复唯一键'}，请检查后重试`,
          error: 'Conflict',
        });
        break;
      }
      case 'P2003': {
        const status = HttpStatus.BAD_REQUEST;
        response.status(status).json({
          statusCode: status,
          message: '关联数据不存在或所选资源在当前赛季无效，请刷新后重试',
          error: 'Bad Request',
        });
        break;
      }
      case 'P2011': {
        const status = HttpStatus.BAD_REQUEST;
        response.status(status).json({
          statusCode: status,
          message: '数据必填项缺失，请补充完整后再试',
          error: 'Bad Request',
        });
        break;
      }
      case 'P2025': {
        const status = HttpStatus.NOT_FOUND;
        response.status(status).json({
          statusCode: status,
          message: '目标记录不存在或已被删除',
          error: 'Not Found',
        });
        break;
      }
      case 'P2022': {
        const status = HttpStatus.INTERNAL_SERVER_ERROR;
        response.status(status).json({
          statusCode: status,
          message: '数据库表结构版本尚未同步，系统正在自动部署更新，请稍后重新提交',
          error: 'Internal Server Error',
        });
        break;
      }
      default: {
        const status = HttpStatus.INTERNAL_SERVER_ERROR;
        response.status(status).json({
          statusCode: status,
          message: '数据保存过程发生内部异常，请检查填写内容或联系管理员',
          error: 'Internal Server Error',
        });
        break;
      }
    }
  }
}

