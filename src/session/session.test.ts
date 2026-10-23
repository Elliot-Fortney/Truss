import { describe, expect, it } from 'vitest';
import type { SynthResult } from '../core/assembly.ts';
import type { Files, Synth } from '../core/ports.ts';
import type { Migration } from '../core/sidecar.ts';
import { TsSource } from '../adapters/source/ts-source.ts';
import { readFixtureAssembly, readFixtureFiles } from '../../test/support/fixture.ts';
import { memoryFiles, type MemoryFiles } from '../../test/support/memory-files.ts';
import { Session } from './session.ts';

const inMemoryFiles = (files: Map<string, string>): Files => memoryFiles(files);
const fakeSynth = (result: SynthResult): Synth => ({ synth: async () => result });

const straightLine = (files: Files = inMemoryFiles(readFixtureFiles('straight-line'))) => ({
  files,
  synth: fakeSynth({ ok: true, assembly: readFixtureAssembly('straight-line') }),
});

const started = async (files: MemoryFiles) => {
  const session = new Session({ appDir: '/app', ...straightLine(files), source: new TsSource() });
  await session.start();
  return session;
};

const fixtureFiles = (texts: Record<string, string> = {}) => memoryFiles(readFixtureFiles('straight-line'), texts);

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
      files: { ...memoryFiles(), read: async () => Promise.reject(new Error('EACCES: permission denied')) },
      source: new TsSource(),
    });
    await session.start();
    expect(session.view()).toMatchObject({ synthing: false, error: { message: expect.stringContaining('EACCES') } });
  });
});

describe('Session Sidecar', () => {
  it('writes a dragged Node position to truss.json keyed by construct path, and shows it in the View', async () => {
    const files = fixtureFiles();
    const session = await started(files);

    const reply = await session.handle({ type: 'move', requestId: 'r1', id: 'ShopStack/Orders', x: 120.4, y: 80 });

    expect(reply).toEqual({ type: 'ack', requestId: 'r1' });
    expect(files.texts.get('truss.json')).toBe(
      '{\n  "formatVersion": 1,\n  "nodes": {\n    "ShopStack/Orders": {\n      "position": {\n        "x": 120,\n        "y": 80\n      }\n    }\n  }\n}\n',
    );
    expect(session.view().nodes.find((n) => n.id === 'ShopStack/Orders')?.position).toEqual({ x: 120, y: 80 });
    expect(session.view().nodes.find((n) => n.id === 'ShopStack/Uploads')?.position).toBeUndefined();
  });

  it('stores a Node note beside its position, and clearing it leaves the position', async () => {
    const files = fixtureFiles();
    const session = await started(files);
    const note = (text: string) => session.handle({ type: 'note', requestId: 'n', id: 'ShopStack/Orders', note: text });
    const stored = () => JSON.parse(files.texts.get('truss.json')!).nodes['ShopStack/Orders'];

    await session.handle({ type: 'move', requestId: 'm', id: 'ShopStack/Orders', x: 1, y: 2 });
    expect(await note('Retries 3x, then DLQ')).toEqual({ type: 'ack', requestId: 'n' });
    expect(stored()).toEqual({ note: 'Retries 3x, then DLQ', position: { x: 1, y: 2 } });
    expect(session.view().nodes.find((n) => n.id === 'ShopStack/Orders')?.note).toBe('Retries 3x, then DLQ');

    await note('Retries 5x');
    expect(stored().note).toBe('Retries 5x');

    await note('');
    expect(stored()).toEqual({ position: { x: 1, y: 2 } });
    expect(session.view().nodes.find((n) => n.id === 'ShopStack/Orders')?.note).toBeUndefined();
  });

  it('drops an entry that has neither a position nor a note left', async () => {
    const files = fixtureFiles();
    const session = await started(files);
    await session.handle({ type: 'note', requestId: 'a', id: 'ShopStack/Orders', note: 'x' });
    await session.handle({ type: 'note', requestId: 'b', id: 'ShopStack/Orders', note: '' });
    expect(JSON.parse(files.texts.get('truss.json')!).nodes).toEqual({});
  });

  it('refuses a request for a path that is not a Node in the Design, and writes nothing', async () => {
    const files = fixtureFiles();
    const session = await started(files);
    const reply = await session.handle({ type: 'move', requestId: 'r', id: 'ShopStack/Nope', x: 1, y: 1 });
    expect(reply).toEqual({ type: 'refused', requestId: 'r', reason: expect.stringContaining('ShopStack/Nope') });
    expect(files.writes).toEqual([]);
  });

  const saved = (nodes: object, formatVersion = 1) => JSON.stringify({ formatVersion, nodes });

  it('shows the positions and notes an existing truss.json holds (round-trip)', async () => {
    const files = fixtureFiles({
      'truss.json': saved({ 'ShopStack/Uploads': { position: { x: 10, y: 20 }, note: 'Public uploads' } }),
    });
    const session = await started(files);
    const uploads = session.view().nodes.find((n) => n.id === 'ShopStack/Uploads');
    expect(uploads).toMatchObject({ position: { x: 10, y: 20 }, note: 'Public uploads' });
    expect(files.writes).toEqual([]);
  });

  it('keeps entries for paths missing from the current code, and writes keys in sorted order', async () => {
    const files = fixtureFiles({
      'truss.json': saved({
        'ShopStack/Zeta': { note: 'Removed on another branch' },
        'ShopStack/Uploads': { position: { y: 20, x: 10 } },
      }),
    });
    const session = await started(files);
    expect(session.view().nodes.map((n) => n.id)).not.toContain('ShopStack/Zeta');

    await session.handle({ type: 'move', requestId: 'r', id: 'ShopStack/Orders', x: 5, y: 6 });

    const written = JSON.parse(files.texts.get('truss.json')!);
    expect(Object.keys(written.nodes)).toEqual(['ShopStack/Orders', 'ShopStack/Uploads', 'ShopStack/Zeta']);
    expect(written.nodes['ShopStack/Zeta']).toEqual({ note: 'Removed on another branch' });
    expect(Object.keys(written.nodes['ShopStack/Uploads'].position)).toEqual(['x', 'y']);
  });

  it('refuses a Sidecar from a newer Truss with a clear message, and leaves the file alone', async () => {
    const newer = saved({ 'ShopStack/Uploads': { position: { x: 1, y: 2 } } }, 7);
    const files = fixtureFiles({ 'truss.json': newer });
    const session = await started(files);

    expect(session.view()).toMatchObject({
      synthing: false,
      nodes: [],
      error: { kind: 'sidecar', message: expect.stringMatching(/truss\.json.*format 7.*newer.*upgrade Truss/i) },
    });
    const reply = await session.handle({ type: 'move', requestId: 'r', id: 'ShopStack/Uploads', x: 5, y: 5 });
    expect(reply.type).toBe('refused');
    expect(files.texts.get('truss.json')).toBe(newer);
    expect(files.writes).toEqual([]);
  });

  it.each([
    ['is not JSON', '<<<<<<< HEAD'],
    ['has no formatVersion', JSON.stringify({ nodes: {} })],
    ['has a position without numbers', saved({ 'ShopStack/Orders': { position: { x: 'left', y: 1 } } })],
  ])('refuses a truss.json that %s, and leaves the file alone', async (_why, text) => {
    const files = fixtureFiles({ 'truss.json': text });
    const session = await started(files);
    expect(session.view()).toMatchObject({ nodes: [], error: { kind: 'sidecar', message: expect.stringContaining('truss.json') } });
    expect(files.texts.get('truss.json')).toBe(text);
  });

  it('keeps every change when requests arrive before the previous write has finished', async () => {
    const files = fixtureFiles();
    const slow: MemoryFiles = {
      ...files,
      writeText: async (name, text) => {
        await new Promise((r) => setTimeout(r, 5));
        await files.writeText(name, text);
      },
    };
    const session = await started(slow);

    await Promise.all([
      session.handle({ type: 'move', requestId: 'a', id: 'ShopStack/Orders', x: 1, y: 1 }),
      session.handle({ type: 'note', requestId: 'b', id: 'ShopStack/Uploads', note: 'hi' }),
      session.handle({ type: 'move', requestId: 'c', id: 'ShopStack/Orders', x: 2, y: 2 }),
    ]);

    expect(JSON.parse(files.texts.get('truss.json')!).nodes).toEqual({
      'ShopStack/Orders': { position: { x: 2, y: 2 } },
      'ShopStack/Uploads': { note: 'hi' },
    });
  });

  it('refuses, and keeps its state, when the Sidecar cannot be written', async () => {
    const files = fixtureFiles();
    const session = await started({ ...files, writeText: async () => Promise.reject(new Error('EACCES: permission denied')) });
    const reply = await session.handle({ type: 'move', requestId: 'r', id: 'ShopStack/Orders', x: 1, y: 1 });
    expect(reply).toEqual({ type: 'refused', requestId: 'r', reason: expect.stringContaining('EACCES') });
    expect(session.view().nodes.find((n) => n.id === 'ShopStack/Orders')?.position).toBeUndefined();
  });

  describe('migration', () => {
    // Two made-up format changes: v1 -> v2 renamed `layout` to `nodes`; v2 -> v3 nested x and y under `position`.
    const migrations: readonly Migration[] = [
      ({ layout, ...rest }) => ({ ...rest, nodes: layout }),
      ({ nodes, ...rest }) => ({
        ...rest,
        nodes: Object.fromEntries(
          Object.entries(nodes as Record<string, { x: number; y: number }>).map(([path, { x, y }]) => [path, { position: { x, y } }]),
        ),
      }),
    ];
    const withMigrations = async (files: MemoryFiles) => {
      const session = new Session({ appDir: '/app', ...straightLine(files), source: new TsSource(), migrations });
      await session.start();
      return session;
    };

    it('runs every step from the file\'s version to the current one, and writes the current version on the next change', async () => {
      const files = fixtureFiles({
        'truss.json': JSON.stringify({ formatVersion: 1, layout: { 'ShopStack/Uploads': { x: 3, y: 4 } } }),
      });
      const session = await withMigrations(files);

      expect(session.view().nodes.find((n) => n.id === 'ShopStack/Uploads')?.position).toEqual({ x: 3, y: 4 });
      expect(files.writes).toEqual([]);

      await session.handle({ type: 'move', requestId: 'r', id: 'ShopStack/Orders', x: 9, y: 9 });
      expect(JSON.parse(files.texts.get('truss.json')!)).toEqual({
        formatVersion: 3,
        nodes: { 'ShopStack/Orders': { position: { x: 9, y: 9 } }, 'ShopStack/Uploads': { position: { x: 3, y: 4 } } },
      });
    });

    it('starts at the step after the file\'s version', async () => {
      const files = fixtureFiles({
        'truss.json': JSON.stringify({ formatVersion: 2, nodes: { 'ShopStack/Uploads': { x: 3, y: 4 } } }),
      });
      const session = await withMigrations(files);
      expect(session.view().nodes.find((n) => n.id === 'ShopStack/Uploads')?.position).toEqual({ x: 3, y: 4 });
    });

    it('refuses a format newer than the chain\'s end', async () => {
      const files = fixtureFiles({ 'truss.json': JSON.stringify({ formatVersion: 4, nodes: {} }) });
      const session = await withMigrations(files);
      expect(session.view().error).toMatchObject({ kind: 'sidecar', message: expect.stringContaining('format 4') });
    });
  });
});
