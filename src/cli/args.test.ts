import { describe, expect, it } from 'vitest';
import { parseCliArgs } from './args.ts';

describe('parseCliArgs', () => {
  it('opens the browser and picks a port by default', () => {
    expect(parseCliArgs([])).toEqual({ open: true });
  });
  it('takes --port and --no-open', () => {
    expect(parseCliArgs(['--port', '5000', '--no-open'])).toEqual({ port: 5000, open: false });
  });
  it('rejects a port that is not a number in range', () => {
    expect(() => parseCliArgs(['--port', 'abc'])).toThrow(/--port/);
    expect(() => parseCliArgs(['--port', '70000'])).toThrow(/--port/);
  });
  it('takes --synth-timeout in seconds', () => {
    expect(parseCliArgs(['--synth-timeout', '30'])).toEqual({ open: true, synthTimeout: 30 });
    expect(parseCliArgs(['--synth-timeout', '0.5'])).toEqual({ open: true, synthTimeout: 0.5 });
  });
  it('rejects a synth timeout that is not a positive number', () => {
    for (const bad of ['abc', '0', '-5', 'Infinity', '']) {
      expect(() => parseCliArgs(['--synth-timeout', bad])).toThrow(/--synth-timeout/);
    }
  });
  it('rejects unknown flags', () => {
    expect(() => parseCliArgs(['--nope'])).toThrow();
  });
});
