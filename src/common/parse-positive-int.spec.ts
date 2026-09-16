import { parsePositiveInt } from './parse-positive-int';

describe('parsePositiveInt', () => {
  it('undefined 回退', () => expect(parsePositiveInt(undefined, 60)).toBe(60));
  it('空串回退', () => expect(parsePositiveInt('', 60)).toBe(60));
  it('空白回退', () => expect(parsePositiveInt('   ', 60)).toBe(60));
  it('非数字回退', () => expect(parsePositiveInt('abc', 60)).toBe(60));
  it('零值拒绝', () => expect(parsePositiveInt('0', 60)).toBe(60));
  it('负数拒绝', () => expect(parsePositiveInt('-1', 60)).toBe(60));
  it('小数拒绝', () => expect(parsePositiveInt('12.5', 60)).toBe(60));
  it('科学计数法拒绝', () => expect(parsePositiveInt('1e3', 60)).toBe(60));
  it('带正号拒绝', () => expect(parsePositiveInt('+60', 60)).toBe(60));
  it('前导零拒绝', () => expect(parsePositiveInt('060', 60)).toBe(60));
  it('超大数范围回退', () => expect(parsePositiveInt('99999999999999999999', 60)).toBe(60));
  it('合法值正常解析', () => expect(parsePositiveInt('120', 60)).toBe(120));
  it('合法值 1 正常解析', () => expect(parsePositiveInt('1', 60)).toBe(1));
  it('合法值大 正常解析', () => expect(parsePositiveInt('1000000', 60)).toBe(1000000));
});
