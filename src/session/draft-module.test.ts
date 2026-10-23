import { describe, expect, it } from 'vitest';
import { TsSource } from '../adapters/source/ts-source.ts';
import type { Intent } from '../core/intents.ts';
import type { FileSet } from '../core/ports.ts';
import { readFixtureAssembly, readFixtureFiles } from '../../test/support/fixture.ts';
import { Draft } from './draft.ts';
import type { Base } from './edit-check.ts';

const SHOP = 'lib/shop-stack.ts';
const source = new TsSource();

const baseOf = (files: FileSet): Base => {
  const assembly = readFixtureAssembly('straight-line');
  return { files, facts: source.analyse(files, assembly), assembly };
};
const setProp = (id: string, className: string, prop: string, value: boolean): Intent => ({ type: 'setProp', path: `ShopStack/${id}`, expect: { className, literalId: id }, prop: [prop], value: { kind: 'boolean', value } });
const versioned = (value = false) => setProp('Uploads', 's3.Bucket', 'versioned', value);
const fifo = () => setProp('Orders', 'sqs.Queue', 'fifo', true);

/** A Draft on the straight-line fixture, with the real Source and no synth. */
function draft(): { draft: Draft; files: FileSet } {
  const files = readFixtureFiles('straight-line');
  const d = new Draft(source);
  d.rebase(baseOf(files));
  return { draft: d, files };
}
const renamed = (files: FileSet, from: string, to: string): FileSet => new Map(files).set(SHOP, files.get(SHOP)!.replace(`'${from}'`, `'${to}'`));

describe('the Draft module', () => {
  it('stages an edit and shows it with its diff', () => {
    const { draft: d } = draft();
    expect(d.stage(versioned())).toEqual({ ok: true });
    expect(d.view()?.items.map((i) => i.summary)).toEqual(['versioned → false']);
    expect(d.view()?.canUndo).toBe(true);
  });

  it('refuses everything until it has a Base', () => {
    const d = new Draft(source);
    for (const outcome of [d.stage(versioned()), d.undo(), d.redo(), d.discard()]) expect(outcome).toEqual({ ok: false, reason: 'There is no Design to edit yet.' });
  });

  it('rolls back a staged edit that cannot be planned', () => {
    const { draft: d } = draft();
    d.stage(versioned());
    const wrong: Intent = { ...fifo(), expect: { className: 'sqs.Queue', literalId: 'Nope' } };
    const outcome = d.stage(wrong);
    expect(outcome.ok).toBe(false);
    expect(d.view()?.items.map((i) => i.summary)).toEqual(['versioned → false']);
  });

  it('leaves the Draft empty when an edit changes nothing', () => {
    const { draft: d } = draft();
    // The code already says versioned: true, so putting it back changes no code.
    expect(d.stage(versioned(true))).toEqual({ ok: true });
    expect(d.intents).toEqual([]);
    expect(d.view()).toBeUndefined();
  });

  it('refuses undo and redo with nothing to undo or redo', () => {
    const { draft: d } = draft();
    expect(d.undo()).toEqual({ ok: false, reason: 'Nothing to undo.' });
    expect(d.redo()).toEqual({ ok: false, reason: 'Nothing to redo.' });
  });

  it('rebase drops an edit whose target moved, and says why', () => {
    const { draft: d, files } = draft();
    d.stage(versioned());
    d.stage(fifo());
    d.rebase(baseOf(renamed(files, 'Uploads', 'Renamed')));
    expect(d.intents.map((i) => i.path)).toEqual(['ShopStack/Orders']);
    expect(d.view()?.notices).toHaveLength(1);
    expect(d.view()?.notices[0]).toMatch(/Dropped versioned → false on Uploads/);
  });

  it('keeps notices across rebases, and clears them on undo, redo, discard and save', () => {
    const clearing: Array<(d: Draft) => void> = [(d) => d.undo(), (d) => (d.undo(), d.redo()), (d) => d.discard(), (d) => d.saved()];
    for (const clear of clearing) {
      const { draft: d, files } = draft();
      d.stage(versioned());
      d.stage(fifo());
      d.stage(setProp('Uploads', 's3.Bucket', 'enforceSSL', true));
      d.stage(setProp('Catalog', 'dynamodb.Table', 'pointInTimeRecovery', true));
      const first = renamed(files, 'Uploads', 'Renamed');
      d.rebase(baseOf(first));
      d.rebase(baseOf(renamed(first, 'Orders', 'Renamed2')));
      expect(d.view()?.notices).toHaveLength(3);
      expect(d.intents).toHaveLength(1);
      clear(d);
      expect(d.view()?.notices ?? []).toEqual([]);
    }
  });

  it('ignores a check of older intents', () => {
    const { draft: d } = draft();
    d.stage(versioned());
    const older = d.intents;
    d.stage(fifo());
    d.checked(older, [{ id: 'x', severity: 'error', source: 'synth', message: 'boom', draft: true, blocking: true }]);
    expect(d.saveBlock()).toMatch(/still checking/);
    expect(d.problems()).toEqual([]);
  });

  it('holds Save until the current intents have been checked', () => {
    const { draft: d } = draft();
    d.stage(versioned());
    expect(d.saveBlock()).toMatch(/still checking/);
    d.checked(d.intents, []);
    expect(d.saveBlock()).toBeUndefined();
    d.undo();
    d.redo();
    expect(d.saveBlock()).toMatch(/still checking/);
  });

  it('shows the Problems of the check, and clears them when saved', () => {
    const { draft: d } = draft();
    d.stage(versioned());
    d.checked(d.intents, [{ id: 'x', severity: 'error', source: 'synth', message: 'boom', draft: true, blocking: true }]);
    expect(d.view()?.problems).toEqual(['boom']);
    d.saved();
    expect(d.problems()).toEqual([]);
    expect(d.view()).toBeUndefined();
  });

  it('shows diffs that match the planned overlay', () => {
    const { draft: d, files } = draft();
    d.stage(versioned());
    d.stage(fifo());
    const planned = d.plan()!;
    expect(planned.ok).toBe(true);
    if (!planned.ok) return;
    const diffs = d.view()!.diffs;
    expect(diffs.map((x) => x.file)).toEqual([...planned.overlay.keys()]);
    expect(diffs[0]!.diff).toContain('-      versioned: true,\n+      versioned: false,');
    expect(planned.overlay.get(SHOP)).not.toBe(files.get(SHOP));
  });
});
