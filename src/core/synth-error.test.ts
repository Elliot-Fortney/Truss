import { describe, expect, it } from 'vitest';
import { locateError } from './synth-error.ts';

const APP = '/work/app';

describe('locateError', () => {
  it('attributes a thrown error to the first frame inside the app', () => {
    const output = [
      'Error: bad bucket name',
      '    at new Bucket (/work/app/node_modules/aws-cdk-lib/aws-s3/lib/bucket.js:10:5)',
      '    at new ShopStack (/work/app/lib/shop-stack.ts:12:9)',
      '    at Object.<anonymous> (/work/app/bin/app.ts:4:1)',
    ].join('\n');
    expect(locateError({ message: 'x', output }, APP)).toEqual({ file: 'lib/shop-stack.ts', line: 12, col: 9 });
  });

  it('reads a frame with no function name', () => {
    expect(locateError({ message: 'x', output: '    at /work/app/bin/app.ts:3:7' }, APP)).toEqual({
      file: 'bin/app.ts',
      line: 3,
      col: 7,
    });
  });

  it('reads a type-check error written as file(line,col)', () => {
    const output = "bin/app.ts(5,12): error TS2322: Type 'string' is not assignable to type 'number'.";
    expect(locateError({ message: 'x', output }, APP)).toEqual({ file: 'bin/app.ts', line: 5, col: 12 });
  });

  it('reads a file:// URL frame', () => {
    expect(locateError({ message: 'x', output: 'at file:///work/app/lib/a.ts:2:3' }, APP)).toEqual({
      file: 'lib/a.ts',
      line: 2,
      col: 3,
    });
  });

  it('looks in the message when the output has nothing', () => {
    expect(locateError({ message: 'failed at /work/app/lib/a.ts:8:2' }, APP)).toEqual({ file: 'lib/a.ts', line: 8, col: 2 });
  });

  it('ignores frames outside the app and frames inside its dependencies', () => {
    const output = [
      'at /elsewhere/lib/a.ts:1:1',
      'at /work/app/node_modules/dep/index.ts:2:2',
      'at /work/application/lib/a.ts:3:3',
    ].join('\n');
    expect(locateError({ message: 'x', output }, APP)).toBeUndefined();
  });

  it('gives up when the trace names no TypeScript file', () => {
    expect(locateError({ message: 'boom', output: 'at /work/app/lib/a.js:1:1' }, APP)).toBeUndefined();
  });

  it('does not let a relative path climb out of the app', () => {
    expect(locateError({ message: 'x', output: '../other/a.ts(1,1): error' }, APP)).toBeUndefined();
  });
});
