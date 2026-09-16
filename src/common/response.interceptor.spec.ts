import { ResponseInterceptor } from './response.interceptor';
import { of } from 'rxjs';

describe('ResponseInterceptor', () => {
  let interceptor: ResponseInterceptor;

  beforeEach(() => {
    interceptor = new ResponseInterceptor();
  });

  function createMockCallHandler(data: any) {
    return {
      handle: () => of(data),
    };
  }

  it('应该对裸数据进行包裹', (done) => {
    interceptor.intercept({} as any, createMockCallHandler({ id: '1' })).subscribe((res) => {
      expect(res).toEqual({ success: true, data: { id: '1' } });
      done();
    });
  });

  it('应该对已经是包裹格式的数据进行透传', (done) => {
    interceptor
      .intercept({} as any, createMockCallHandler({ success: true, data: { id: '1' } }))
      .subscribe((res) => {
        expect(res).toEqual({ success: true, data: { id: '1' } });
        done();
      });
  });

  it('应该处理 null', (done) => {
    interceptor.intercept({} as any, createMockCallHandler(null)).subscribe((res) => {
      expect(res).toEqual({ success: true, data: null });
      done();
    });
  });

  it('应该处理数组', (done) => {
    interceptor.intercept({} as any, createMockCallHandler([1, 2, 3])).subscribe((res) => {
      expect(res).toEqual({ success: true, data: [1, 2, 3] });
      done();
    });
  });
});
