import { EventEmitter } from 'events';
import { apiResponseMetricsMiddleware, getResponseWarningThreshold } from './api-response-metrics';

describe('API response metrics', () => {
  afterEach(() => {
    delete process.env.API_RESPONSE_SIZE_WARNING_BYTES;
    jest.restoreAllMocks();
  });

  it('uses a safe default and accepts zero to disable warnings', () => {
    expect(getResponseWarningThreshold()).toBe(256 * 1024);
    process.env.API_RESPONSE_SIZE_WARNING_BYTES = '0';
    expect(getResponseWarningThreshold()).toBe(0);
  });

  it('logs metadata, not response content, for oversized API responses', () => {
    process.env.API_RESPONSE_SIZE_WARNING_BYTES = '100';
    const req = { method: 'GET', path: '/api/v1/matches' } as any;
    const res = new EventEmitter() as any;
    res.statusCode = 200;
    res.getHeader = jest.fn().mockReturnValue('120');
    const next = jest.fn();
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});

    apiResponseMetricsMiddleware(req, res, next);
    res.emit('finish');

    expect(next).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('"responseBytes":120'));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('"path":"/api/v1/matches"'));
  });
});
