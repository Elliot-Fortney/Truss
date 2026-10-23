import { applyChanges, unifiedDiff, type FileDiff } from '../core/diff.ts';
import { judgeEdit, newDiagnostics } from '../core/edit-check.ts';
import type { Intent } from '../core/intents.ts';
import type { FileSet, Files, Source, Synth } from '../core/ports.ts';

/** The ports and folder an edit is tried on. */
export interface EditApp {
  appDir: string;
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
  const facts = app.source.analyse(files, before.assembly);

  const plan = app.source.plan(files, facts, intents);
  if (!plan.ok) return { ok: false, failures: [`Source can't place ${intents[plan.intent] ? intents[plan.intent]!.prop.join('.') : 'the edit'}: ${plan.reason}`] };
  const overlay: FileSet = new Map(Object.entries(plan.changes).map(([file, changes]) => [file, applyChanges(files.get(file)!, changes)]));
  const after = new Map([...files, ...overlay]);
  const touched = [...overlay.keys()];

  const failures: string[] = [];
  const added = newDiagnostics(app.source.diagnostics(app.appDir, files, touched), app.source.diagnostics(app.appDir, after, touched));
  failures.push(...added.map((d) => `${d.file}:${d.line}: TypeScript ${d.code}: ${d.message}`));

  const synthed = await app.synth.synth(app.appDir, { overlay });
  if (!synthed.ok) failures.push(`The app doesn't synth with the edit: ${synthed.error.message}`);
  else failures.push(...judgeEdit({ files, changes: plan.changes, facts, intents, before: before.assembly, after: synthed.assembly }));

  if (failures.length > 0) return { ok: false, failures };
  return { ok: true, files: overlay, diffs: [...overlay].flatMap(([file, text]) => unifiedDiff(file, files.get(file) ?? '', text) ?? []) };
}

/** Throws, naming every check that fails, unless the edit holds. The tests of every kind of edit use this. */
export async function assertEditHolds(app: EditApp, intents: readonly Intent[]): Promise<EditOutcome & { ok: true }> {
  const outcome = await checkEdit(app, intents);
  if (!outcome.ok) throw new Error(`The edit doesn't hold:\n${outcome.failures.map((f) => `  - ${f}`).join('\n')}`);
  return outcome;
}
