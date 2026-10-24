import { describe, expect, it } from 'vitest';
import type { NodeView, StackBoxView, StageView, View } from '../core/view.ts';
import { chooseStage, rememberStage, rememberedStage, showStage } from './stage.ts';

const stages: StageView[] = [
  { id: 'Dev', label: 'Dev' },
  { id: 'Prod', label: 'Prod' },
];

describe('chooseStage', () => {
  it('opens on the first Stage in the order the app creates them', () => {
    expect(chooseStage(stages, undefined)).toBe('Dev');
  });

  it('opens on the remembered Stage when the app still has it', () => {
    expect(chooseStage(stages, 'Prod')).toBe('Prod');
  });

  it('falls back to the first Stage when the remembered one is gone', () => {
    expect(chooseStage(stages, 'Gone')).toBe('Dev');
  });

  it('picks nothing for an app without Stages', () => {
    expect(chooseStage([], 'Prod')).toBeUndefined();
  });
});

describe('showStage', () => {
  const stack = (id: string, extra: Partial<StackBoxView> = {}): StackBoxView => ({
    id,
    label: id,
    env: 'env-agnostic',
    ...extra,
  });
  const node = (id: string, stackId: string): NodeView => ({
    id,
    stackId,
    label: id,
    subtitle: '',
    fqn: '',
    icon: 'generic',
    source: { file: 'a.ts', line: 1, col: 1 },
  });
  const view: View = {
    version: 3,
    synthing: false,
    hasDesign: true,
    stages,
    stacks: [
      stack('Pipeline'),
      stack('Dev/Core', { stageId: 'Dev' }),
      stack('Dev/Core/Worker', { stageId: 'Dev', parentId: 'Dev/Core' }),
      stack('Prod/Core', { stageId: 'Prod' }),
    ],
    nodes: [
      node('Pipeline/a', 'Pipeline'),
      node('Dev/Core/b', 'Dev/Core'),
      node('Dev/Core/Worker/c', 'Dev/Core/Worker'),
      node('Prod/Core/d', 'Prod/Core'),
    ],
    edges: [],
    problems: [],
  };

  it('keeps the Stacks of the chosen Stage and those outside every Stage, with their Nodes', () => {
    const shown = showStage(view, 'Dev');
    expect(shown.stacks.map((s) => s.id)).toEqual(['Pipeline', 'Dev/Core', 'Dev/Core/Worker']);
    expect(shown.nodes.map((n) => n.id)).toEqual(['Pipeline/a', 'Dev/Core/b', 'Dev/Core/Worker/c']);
  });

  it('keeps the edges between the Nodes it shows, and drops those that reach one it does not', () => {
    const edge = (from: string, to: string) => ({
      id: `${from}->${to}`,
      kind: 'reference' as const,
      from,
      to,
      prop: 'p',
      text: 'x',
      source: { file: 'a.ts', line: 1, col: 1 },
    });
    const withEdges = { ...view, edges: [edge('Dev/Core/b', 'Pipeline/a'), edge('Dev/Core/b', 'Prod/Core/d')] };
    expect(showStage(withEdges, 'Dev').edges.map((e) => e.id)).toEqual(['Dev/Core/b->Pipeline/a']);
  });

  it('shows the other Stage when asked for it', () => {
    expect(showStage(view, 'Prod').stacks.map((s) => s.id)).toEqual(['Pipeline', 'Prod/Core']);
  });

  it('shows everything for an app without Stages', () => {
    const plain = { ...view, stages: [], stacks: [stack('A'), stack('B')], nodes: [] };
    expect(showStage(plain, undefined).stacks).toHaveLength(2);
  });
});

describe('the remembered Stage', () => {
  const memory = () => {
    const items = new Map<string, string>();
    return {
      items,
      getItem: (k: string) => items.get(k) ?? null,
      setItem: (k: string, v: string) => void items.set(k, v),
    };
  };

  it('is kept in browser storage and read back', () => {
    const storage = memory();
    expect(rememberedStage(storage)).toBeUndefined();
    rememberStage('Prod', storage);
    expect(rememberedStage(storage)).toBe('Prod');
  });

  it('works without storage, which a browser can refuse', () => {
    const refusing = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
    };
    expect(() => rememberStage('Prod', refusing)).not.toThrow();
    expect(rememberedStage(refusing)).toBeUndefined();
    expect(rememberedStage(undefined)).toBeUndefined();
  });
});
