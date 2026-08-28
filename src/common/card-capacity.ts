import { ServiceUnavailableException } from '@nestjs/common';

/** 只重试容量预占事务，不重试已经产生存储副作用的整个注册流程。 */
export async function reserveCardCapacity<T>(reserve: () => Promise<T>): Promise<T> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await reserve();
    } catch (error: any) {
      if (error?.code !== 'P2034') throw error;
      if (attempt === 2) {
        throw new ServiceUnavailableException('材料容量预占繁忙，请稍后重试');
      }
    }
  }
  throw new ServiceUnavailableException('材料容量预占失败');
}
