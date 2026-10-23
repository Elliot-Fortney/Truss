import { unifiedDiff, type FileDiff } from '../core/diff.ts';
import { describeIntent, emptyDraftHistory, idOf, redo, stage, undo, type DraftHistory, type Intent } from '../core/intents.ts';
import type { Source } from '../core/ports.ts';
import { buildReport, type Problem } from '../core/problems.ts';
import type { DraftView } from '../core/view.ts';
import { planEdit, type Base, type Planned } from './edit-check.ts';

export type DraftOutcome = { ok: true } | { ok: false; reason: string };

/**
 * The Draft (CONTEXT.md): the edits not yet saved, the Base they are planned on, and what has been
 * checked about them. It owns the rule that the screen shows the Draft as it is now: a check made on
 * older intents is ignored, and Save is blocked until the current intents have been checked.
 */
export class Draft {
  private history: DraftHistory = emptyDraftHistory;
  private current: Base | undefined;
  /** Edits dropped when the code changed under the Draft, and why. */
  private notices: string[] = [];
  /** Everything found wrong with the Design on screen: the app's own annotations and cycles, and what the checks of the Draft found. */
  private found: Problem[] = [];
  /** The intents last checked, so that Save knows the screen shows the Draft as it is now. */
  private checkedIntents: readonly Intent[] | undefined;
  /** The intents the Draft last synthed with, so that those staged since are the ones that may have broken it. */
  private lastGood: readonly Intent[] = [];
  /** The error the Draft's synth gave, while it is the latest word on the Draft. */
  private error: string | undefined;

  constructor(private readonly source: Source) {}

  /** The app as the files hold it, from the last synth of them. */
  get base(): Base | undefined {
    return this.current;
  }

  get intents(): readonly Intent[] {
    return this.history.intents;
  }

  /** Everything found wrong with the Design on screen. */
  problems(): Problem[] {
    return this.found;
  }

  /** Replaces the Problems with ones that are not the result of checking the Draft (a synth error, the Sidecar, the app's own). */
  setProblems(problems: Problem[]): void {
    this.found = problems;
  }

  /** Sets the error the Draft's synth gave, or clears it. */
  setError(message: string | undefined): void {
    this.error = message;
  }

  /** Adds an edit. Refused, leaving the Draft as it was, when it can't be planned. An edit that changes no code leaves the Draft empty, keeping redo. */
  stage(intent: Intent): DraftOutcome {
    if (!this.current) return { ok: false, reason: 'There is no Design to edit yet.' };
    const before = this.history;
    this.history = stage(before, intent);
    const planned = this.plan()!;
    if (!planned.ok) {
      this.history = before;
      return { ok: false, reason: planned.reason };
    }
    if (Object.keys(planned.changes).length === 0) this.history = { intents: [], redo: before.redo };
    this.changed(false);
    return { ok: true };
  }

  undo(): DraftOutcome {
    if (!this.current) return { ok: false, reason: 'There is no Design to edit yet.' };
    if (this.history.intents.length === 0) return { ok: false, reason: 'Nothing to undo.' };
    this.history = undo(this.history);
    this.changed();
    return { ok: true };
  }

  redo(): DraftOutcome {
    if (!this.current) return { ok: false, reason: 'There is no Design to edit yet.' };
    if (this.history.redo.length === 0) return { ok: false, reason: 'Nothing to redo.' };
    this.history = redo(this.history);
    this.changed();
    return { ok: true };
  }

  discard(): DraftOutcome {
    if (!this.current) return { ok: false, reason: 'There is no Design to edit yet.' };
    this.history = emptyDraftHistory;
    this.changed();
    return { ok: true };
  }

  /** Takes `base` as the Base, planning the intents on it again: each that no longer finds its target is dropped, and a notice says why. */
  rebase(base: Base): void {
    this.current = base;
    const dropped: string[] = [];
    for (let plan = this.source.plan(base.files, base.facts, this.history.intents); !plan.ok; plan = this.source.plan(base.files, base.facts, this.history.intents)) {
      const intent = this.history.intents[plan.intent];
      if (!intent) break;
      dropped.push(`Dropped ${describeIntent(intent)} on ${intent.expect.literalId}: ${plan.reason}`);
      this.history = { ...this.history, intents: this.history.intents.filter((_, i) => i !== plan.intent) };
    }
    // Notices stay until the Draft is undone, redone, discarded or saved, so a later rebase adds to them rather than replacing them.
    this.notices = [...this.notices, ...dropped];
  }

  /** Records the result of checking `intents` and what it found. Ignored when the Draft's intents are no longer those. */
  checked(intents: readonly Intent[], problems: Problem[]): void {
    if (intents !== this.history.intents) return;
    this.checkedIntents = intents;
    this.lastGood = intents;
    this.error = undefined;
    this.found = problems;
  }

  /** Why Save can't go ahead yet, when it can't: the screen has to show the Draft as it is now, because the checks were made on what it shows. */
  saveBlock(): string | undefined {
    return this.checkedIntents === this.history.intents ? undefined : 'Truss is still checking the Draft. Try again in a moment.';
  }

  /** The Draft's intents planned on the Base. Undefined with no Base to plan on. */
  plan(): Planned | undefined {
    return this.current && planEdit(this.source, this.current, this.history.intents);
  }

  /** Clears the Draft after it was written to the user's files. */
  saved(): void {
    this.history = emptyDraftHistory;
    this.notices = [];
    this.found = [];
    this.lastGood = [];
  }

  /** What the browser shows of the Draft; nothing when it holds nothing and has nothing to say. */
  view(): DraftView | undefined {
    const { intents, redo: undone } = this.history;
    if (intents.length === 0 && undone.length === 0 && this.notices.length === 0) return undefined;
    const planned = this.plan();
    const diffs: FileDiff[] = [];
    if (planned?.ok && this.current) {
      for (const [file, text] of planned.overlay) {
        const diff = unifiedDiff(file, this.current.files.get(file) ?? '', text);
        if (diff) diffs.push(diff);
      }
    }
    const suspects = this.error === undefined ? [] : intents.filter((i) => !this.lastGood.includes(i));
    const bugs = this.found.filter((p) => p.trussBug).map((p) => p.message);
    return {
      items: intents.map((i) => ({
        id: i.path,
        label: idOf(i),
        summary: describeIntent(i),
        ...(suspects.includes(i) ? { suspect: true as const } : {}),
        ...(suspects.length === 1 && suspects[0] === i ? { error: this.error! } : {}),
        ...(suspects.length === 1 && suspects[0] === i && intents.at(-1) === i ? { undoable: true as const } : {}),
      })),
      canUndo: intents.length > 0,
      canRedo: undone.length > 0,
      diffs,
      problems: this.found.filter((p) => p.blocking).map((p) => p.message),
      notices: this.notices,
      ...(bugs.length > 0 ? { report: buildReport(intents, diffs, bugs) } : {}),
    };
  }

  /** The intents are no longer the ones last checked; undo, redo and discard also end the notices. */
  private changed(clearNotices = true): void {
    if (clearNotices) this.notices = [];
    this.checkedIntents = undefined;
  }
}
