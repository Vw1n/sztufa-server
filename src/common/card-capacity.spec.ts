import { reserveCardCapacity } from './card-capacity';

describe('容量预占事务重试', () => {
  it('只对序列化冲突重试，重试耗尽统一 503', async () => {
    const reserve = jest.fn().mockRejectedValue({ code: 'P2034' });
    await expect(reserveCardCapacity(reserve)).rejects.toMatchObject({ status: 503 });
    expect(reserve).toHaveBeenCalledTimes(3);
  });
  it('重试成功返回结果，其他异常保持原样', async () => {
    const reserve = jest.fn().mockRejectedValueOnce({ code: 'P2034' }).mockResolvedValue('asset');
    await expect(reserveCardCapacity(reserve)).resolves.toBe('asset');
    const failure = jest.fn().mockRejectedValue(new Error('unavailable'));
    await expect(reserveCardCapacity(failure)).rejects.toThrow('unavailable');
    expect(failure).toHaveBeenCalledTimes(1);
  });
});
