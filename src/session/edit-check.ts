import type { SynthResult, Assembly } from '../core/assembly.ts';
import type { Catalog } from '../core/catalog.ts';
import { applyChanges, unifiedDiff, type FileDiff, type TextChange } from '../core/diff.ts';
import { judgeEdit, newDiagnostics } from '../core/edit-check.ts';
import type { Facts } from '../core/facts.ts';
import type { Intent } from '../core/intents.ts';
import type { Diagnostic, FileSet, Files, Source, SourceUse, Synth } from '../core/ports.ts';

/** The app as it is on disk, which an edit's intents are planned against. */
export interface Base {
  files: FileSet;
  facts: Facts;
  assembly: Assembly;
}

/** Intents turned into text. */
export type Planned = { ok: true; changes: Record<string, TextChange[]>; overlay: FileSet; merged: FileSet } | { ok: false; intent: number; reason: string; uses?: SourceUse[] };

/** Plans `intents` on the base: the changes, the files they make, and the base with those files replaced. */
export function planEdit(source: Source, base: Base, intents: readonly Intent[]): Planned {
  const plan = source.plan(base.files, base.facts, intents);
  if (!plan.ok) return plan;
  const overlay: FileSet = new Map(Object.entries(plan.changes).map(([file, changes]) => [file, applyChanges(base.files.get(file)!, changes)]));
  return { ok: true, changes: plan.changes, overlay, merged: new Map([...base.files, ...overlay]) };
}

/** How a TypeScript diagnostic an edit adds is told to the user. */
export const typeScriptMessage = (d: Diagnostic): string => `${d.file}:${d.line}: TypeScript ${d.code}: ${d.message}`;

/** Why an edit can't be trusted, one failure at a time. */
export type EditFailure =
  | { kind: 'plan'; message: string }
  | { kind: 'typescript'; message: string; diagnostic?: Diagnostic }
  | { kind: 'synth'; message: string }
  | { kind: 'judge'; message: string };

export interface EditChecked {
  planned: Extract<Planned, { ok: true }> | undefined;
  diffs: FileDiff[];
  failures: EditFailure[];
}

/**
 * Checks `intents` against the base given `after`, the result of synthing the files with the edit made: the
 * edit holds when it can be planned, adds no TypeScript diagnostic to the files it touches, the app still
 * synths, and its diff and the assembly change in the shape the intents mean (ADR 0006, ADR 0007). Save and
 * the tests of every kind of edit both run this. `baseDiagnostics` caches the type-check of the base by the
 * files touched, for as long as the base lasts.
 */
export function checkEditOn(
  app: { appDir: string; source: Source },
  base: Base,
  intents: readonly Intent[],
  after: SynthResult,
  baseDiagnostics: Map<string, Diagnostic[]> = new Map(),
): EditChecked {
  const planned = planEdit(app.source, base, intents);
  if (!planned.ok) {
    const at = intents[planned.intent];
    return { planned: undefined, diffs: [], failures: [{ kind: 'plan', message: `Source can't place ${at ? (at.type === 'setProp' ? at.prop.join('.') : at.type === 'renameId' ? 'the new Construct ID' : at.type === 'removeNode' ? 'the removal' : at.type === 'addReference' || at.type === 'removeReference' || at.type === 'repointReference' ? 'the Reference' : at.type === 'addConnection' || at.type === 'removeConnection' || at.type === 'replaceConnection' ? 'the Connection' : 'the new construct') : 'the edit'}: ${planned.reason}` }] };
  }
  const failures: EditFailure[] = [];
  const touched = Object.keys(planned.changes);
  try {
    const key = touched.join('\0');
    if (!baseDiagnostics.has(key)) baseDiagnostics.set(key, app.source.diagnostics(app.appDir, base.files, touched));
    for (const d of newDiagnostics(baseDiagnostics.get(key)!, app.source.diagnostics(app.appDir, planned.merged, touched))) failures.push({ kind: 'typescript', message: typeScriptMessage(d), diagnostic: d });
  } catch (err) {
    // A type-check that can't run fails the edit too, since it can't be vouched for.
    failures.push({ kind: 'typescript', message: `Couldn't type-check the Draft: ${err instanceof Error ? err.message : String(err)}` });
  }
  if (!after.ok) failures.push({ kind: 'synth', message: `The app doesn't synth with the edit: ${after.error.message}` });
  else {
    const judged = judgeEdit({ files: base.files, changes: planned.changes, facts: base.facts, intents, before: base.assembly, after: after.assembly });
    failures.push(...judged.map((message): EditFailure => ({ kind: 'judge', message })));
  }
  return { planned, diffs: [...planned.overlay].flatMap(([file, text]) => unifiedDiff(file, base.files.get(file) ?? '', text) ?? []), failures };
}

/** The ports and folder an edit is tried on. */
export interface EditApp {
  appDir: string;
  /** What the app's installed libraries offer, which the calls that make Connections are read against. */
  catalog?: Catalog;
  synth: Synth;
  files: Files;
  source: Source;
}

export type EditOutcome = { ok: true; diffs: FileDiff[]; files: FileSet } | { ok: false; failures: string[] };

/**
 * Tries `intents` on the app without saving anything and reports why the edit can't be trusted. The
 * edit holds when its diff is confined to the constructs the intents name, it adds no TypeScript
 * diagnostic to the files it touches, the app still synths, and the assembly changes in the shape the
 * intents mean (ADR 0006, ADR 0007). Save runs these same checks on the Draft.
 */
export async function checkEdit(app: EditApp, intents: readonly Intent[]): Promise<EditOutcome> {
  const files = await app.files.read();
  const before = await app.synth.synth(app.appDir);
  if (!before.ok) return { ok: false, failures: [`The app doesn't synth before the edit: ${before.error.message}`] };
  const base: Base = { files, facts: app.source.analyse(files, before.assembly, app.catalog), assembly: before.assembly };

  const plan = planEdit(app.source, base, intents);
  const after = plan.ok ? await app.synth.synth(app.appDir, { overlay: plan.overlay }) : before;
  const checked = checkEditOn(app, base, intents, after);
  if (checked.failures.length > 0 || !checked.planned) return { ok: false, failures: checked.failures.map((f) => f.message) };
  return { ok: true, files: checked.planned.overlay, diffs: checked.diffs };
}

/** Throws, naming every check that fails, unless the edit holds. The tests of every kind of edit use this. */
export async function assertEditHolds(app: EditApp, intents: readonly Intent[]): Promise<EditOutcome & { ok: true }> {
  const outcome = await checkEdit(app, intents);
  if (!outcome.ok) throw new Error(`The edit doesn't hold:\n${outcome.failures.map((f) => `  - ${f}`).join('\n')}`);
  return outcome;
}
