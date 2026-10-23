import { describe, expect, it } from 'vitest';
import type { SynthResult } from '../core/assembly.ts';
import type { Files, Synth } from '../core/ports.ts';
import { TsSource } from '../adapters/source/ts-source.ts';
import { readFixtureAssembly, readFixtureFiles } from '../../test/support/fixture.ts';
import { Session } from './session.ts';

const inMemoryFiles = (files: Map<string, string>): Files => ({ read: async () => files });
const fakeSynth = (result: SynthResult): Synth => ({ synth: async () => result });

const straightLine = () => ({
  files: inMemoryFiles(readFixtureFiles('straight-line')),
  synth: fakeSynth({ ok: true, assembly: readFixtureAssembly('straight-line') }),
});

describe('Session', () => {
  it('starts with an empty view that is still synthing', () => {
    const session = new Session({ appDir: '/app', ...straightLine(), source: new TsSource() });
    expect(session.view()).toMatchObject({ version: 0, synthing: true, nodes: [], stacks: [] });
  });

  it('derives the Design from the fake synth, the in-memory files and the real Source', async () => {
    const session = new Session({ appDir: '/app', ...straightLine(), source: new TsSource() });
    await session.start();
    const view = session.view();
    expect(view.synthing).toBe(false);
    expect(view.stacks).toEqual([{ id: 'ShopStack', label: 'ShopStack', env: 'us-east-1 · 123456789012' }]);
    expect(view.nodes.map((n) => [n.id, n.stackId, n.subtitle])).toEqual([
      ['ShopStack/Uploads', 'ShopStack', 'Bucket'],
      ['ShopStack/Orders', 'ShopStack', 'Queue'],
      ['ShopStack/Catalog', 'ShopStack', 'Table'],
    ]);
  });

  it('pushes every state change with a version that only goes up', async () => {
    const session = new Session({ appDir: '/app', ...straightLine(), source: new TsSource() });
    const pushed: number[] = [];
    session.subscribe((v) => pushed.push(v.version));
    await session.start();
    expect(pushed.length).toBeGreaterThanOrEqual(2);
    expect(pushed).toEqual([...pushed].sort((a, b) => a - b));
    expect(new Set(pushed).size).toBe(pushed.length);
  });

  it('shows the synth error, with no Design, when the first synth fails', async () => {
    const session = new Session({
      appDir: '/app',
      files: inMemoryFiles(new Map()),
      synth: fakeSynth({ ok: false, error: { message: 'boom', output: 'stack trace' } }),
      source: new TsSource(),
    });
    await session.start();
    expect(session.view()).toMatchObject({
      synthing: false,
      error: { message: 'boom', output: 'stack trace' },
      nodes: [],
    });
  });

  it('stops sending pushes to a listener that unsubscribed', async () => {
    const session = new Session({ appDir: '/app', ...straightLine(), source: new TsSource() });
    const pushed: number[] = [];
    const off = session.subscribe((v) => pushed.push(v.version));
    off();
    await session.start();
    expect(pushed).toEqual([]);
  });

  it('shows an error instead of staying on "synthing…" when reading the files fails', async () => {
    const session = new Session({
      appDir: '/app',
      synth: straightLine().synth,
      files: { read: async () => Promise.reject(new Error('EACCES: permission denied')) },
      source: new TsSource(),
    });
    await session.start();
    expect(session.view()).toMatchObject({ synthing: false, error: { message: expect.stringContaining('EACCES') } });
  });
});
