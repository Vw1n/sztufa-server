import { ArgumentsHost, Catch, ExceptionFilter, HttpStatus } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { Response } from 'express';

@Catch(Prisma.PrismaClientKnownRequestError)
export class PrismaClientExceptionFilter implements ExceptionFilter {
  catch(exception: Prisma.PrismaClientKnownRequestError, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();

    switch (exception.code) {
      case 'P2002': {
        const status = HttpStatus.CONFLICT;
        const targets = (exception.meta?.target as string[]) || [];
        const targetNames = targets
          .map((t) => {
            if (t === 'teamName') return '球队名称';
            if (t === 'studentId') return '学号';
            if (t === 'jerseyNumber') return '球衣号码';
            if (t === 'username') return '用户名';
            return t;
          })
          .join(', ');

        response.status(status).json({
          statusCode: status,
          message: `数据冲突：${targetNames || '字段'} 已存在，请更换后重试`,
          error: 'Conflict',
        });
        break;
      }
      default: {
        const status = HttpStatus.INTERNAL_SERVER_ERROR;
        response.status(status).json({
          statusCode: status,
          message: `服务器内部错误: [Prisma 错误 ${exception.code}] ${exception.message.split('\n')[0]}`,
          error: 'Internal Server Error',
        });
        break;
      }
    }
  }
}
