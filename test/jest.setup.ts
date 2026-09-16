import { Logger } from '@nestjs/common';
import { getTestLogger } from './silent-logger';

// 全局覆盖 NestJS Logger，所有 new Logger() 都走静默 Logger
Logger.overrideLogger(getTestLogger());
