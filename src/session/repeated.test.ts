import { describe, expect, it } from 'vitest';
import { TsSource } from '../adapters/source/ts-source.ts';
import type { Files } from '../core/ports.ts';
import { parseSidecar } from '../core/sidecar.ts';
import { readFixtureAssembly, readFixtureFiles } from '../../test/support/fixture.ts';
import { Session } from './session.ts';

/** ADR 0008 on the shapes fixture: `RepeatedStack` is created as Dev and Prod, and `AppStage` as StageDev and StageProd. */
function started() {
  const texts = new Map<string, string>();
  const files: Files = {
    read: async () => readFixtureFiles('shapes'),
    readText: async (name) => texts.get(name),
    writeText: async (name, text) => void texts.set(name, text),
    watch: () => () => undefined,
  };
  const session = new Session({
    appDir: '/app',
    source: new TsSource(),
    files,
    synth: { synth: async () => ({ ok: true, assembly: readFixtureAssembly('shapes') }) },
  });
  const sidecar = () => parseSidecar(texts.get('truss.json') ?? '{"formatVersion":1,"nodes":{}}');
  return { session, sidecar };
}

describe('Session with a Stack or Stage class created more than once', () => {
  it('leaves their Nodes editable', async () => {
    const { session } = started();
    await session.start();
    const nodes = session.view().nodes;
    for (const id of ['Dev/Alerts', 'Prod/Alerts', 'StageDev/Core/Events', 'StageProd/Core/Events'])
      expect(nodes.find((n) => n.id === id)?.lock).toBeUndefined();
  });

  it('writes a drag to the position of every instance', async () => {
    const { session, sidecar } = started();
    await session.start();
    expect(await session.handle({ type: 'move', requestId: 'r', id: 'Dev/Alerts', x: 7, y: 9 })).toEqual({
      type: 'ack',
      requestId: 'r',
    });
    const nodes = session.view().nodes;
    expect(nodes.find((n) => n.id === 'Dev/Alerts')?.position).toEqual({ x: 7, y: 9 });
    expect(nodes.find((n) => n.id === 'Prod/Alerts')?.position).toEqual({ x: 7, y: 9 });
    expect(nodes.find((n) => n.id === 'Shapes/Outer')?.position).toBeUndefined();
    const parsed = sidecar();
    expect(parsed.ok && Object.keys(parsed.sidecar.nodes).sort()).toEqual(['Dev/Alerts', 'Prod/Alerts']);
  });

  it('writes a drag of a Node in a Stage created twice to both Stages', async () => {
    const { session } = started();
    await session.start();
    await session.handle({ type: 'move', requestId: 'r', id: 'StageProd/Core/Events', x: 1, y: 2 });
    const nodes = session.view().nodes;
    expect(nodes.find((n) => n.id === 'StageDev/Core/Events')?.position).toEqual({ x: 1, y: 2 });
  });

  it('refuses a Node dropped in another Stack, with the code to open', async () => {
    const { session } = started();
    await session.start();
    const reply = await session.handle({ type: 'move', requestId: 'r', id: 'Dev/Alerts', x: 7, y: 9, into: 'Shapes' });
    expect(reply).toMatchObject({
      type: 'refused',
      reason: expect.stringContaining('between Stacks'),
      at: { file: 'lib/repeated-stack.ts' },
    });
    expect(session.view().nodes.find((n) => n.id === 'Dev/Alerts')?.position).toBeUndefined();
  });

  it('takes a drop in the Node’s own Stack as an ordinary move', async () => {
    const { session } = started();
    await session.start();
    const reply = await session.handle({ type: 'move', requestId: 'r', id: 'Dev/Alerts', x: 1, y: 1, into: 'Dev' });
    expect(reply).toEqual({ type: 'ack', requestId: 'r' });
  });

  it('refuses to delete a Stack, with the code to open', async () => {
    const { session } = started();
    await session.start();
    const reply = await session.handle({ type: 'removeNode', requestId: 'r', id: 'Dev' });
    expect(reply).toMatchObject({
      type: 'refused',
      reason: expect.stringContaining('Stack'),
      at: { file: 'bin/app.ts' },
    });
  });

  it('refuses to add a Stack, with no code to point at', async () => {
    const { session } = started();
    await session.start();
    const reply = await session.handle({
      type: 'addNode',
      requestId: 'r',
      scope: 'Dev',
      fqn: 'aws-cdk-lib.Stack',
    });
    expect(reply).toMatchObject({ type: 'refused', reason: expect.stringContaining('Stack') });
  });
});
