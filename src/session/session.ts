import type { Assembly, SourceLocation, SynthError, SynthResult } from '../core/assembly.ts';
import { searchCatalog, type Catalog, type SearchHit } from '../core/catalog.ts';
import { unifiedDiff, type FileDiff, type TextChange } from '../core/diff.ts';
import { targetPaths } from '../core/edit-check.ts';
import type { Facts } from '../core/facts.ts';
import { describeIntent, emptyDraft, redo, stage, undo, type Draft, type Intent } from '../core/intents.ts';
import type { CatalogLoad, Diagnostic, FileSet, Files, Source, Synth } from '../core/ports.ts';
import { buildPanel, inputFor } from '../core/panel.ts';
import type { ClientMessage, DraftMessage, EditMessage, PanelMessage, Reply } from '../core/protocol.ts';
import { currentFormatVersion, emptySidecar, MIGRATIONS, parseSidecar, serializeSidecar, SIDECAR_FILE, withNote, withPosition, type Migration, type Sidecar } from '../core/sidecar.ts';
import { annotationProblems, buildReport, cycleProblems, nodeAt, sourcePosition, type Problem } from '../core/problems.ts';
import { locateError } from '../core/synth-error.ts';
import { commit } from './commit.ts';
import { checkEditOn, planEdit, type Base, type Planned } from './edit-check.ts';
import { buildView, type DraftView, type View } from '../core/view.ts';

export interface SessionDeps {
  appDir: string;
  synth: Synth;
  files: Files;
  source: Source;
  /** What the app's installed libraries offer, read at startup (ADR 0009). Absent, nothing can be searched. */
  catalog?: Catalog;
  /**
   * Reads the Catalog again from what the app has installed. Asked before every synth, so that when the
   * resolved `aws-cdk-lib` changes the Catalog is regenerated (or loaded from cache) before the re-synth
   * (ADR 0009). An answer that refuses the app stops that synth and is shown as the reason.
   */
  reloadCatalog?: () => Promise<CatalogLoad>;
  /** The Sidecar's format history; only tests give their own. */
  migrations?: readonly Migration[];
}

/**
 * Holds the state for one app and is the only layer that calls the ports. The browser is a view
 * over it: every state change is pushed as the whole View, tagged with a version that only goes up.
 */
/** After this many stale results in a row the next one is shown anyway; the run behind it still follows. */
const MAX_STALE_IN_A_ROW = 2;

export class Session {
  private current: View = { version: 0, synthing: true, hasDesign: false, stages: [], stacks: [], nodes: [], problems: [] };
  private listeners = new Set<(view: View) => void>();
  private unwatch: (() => void) | undefined;
  private stopped = false;
  /** The synth cycle in progress: the run, plus the one run that may be waiting behind it. */
  private cycle: Promise<void> | undefined;
  /** Set when the files changed during a run, so that run's result is stale and one more run is due. */
  private waiting = false;
  /** Results dropped as stale in a row, so continuous edits can't keep the Design from ever updating. */
  private staleInARow = 0;
  private sidecar: Sidecar = emptySidecar();
  /** Runs Sidecar changes and the showing of a synth result one at a time, so each builds on the one before. */
  private queue: Promise<unknown> = Promise.resolve();
  /** What the Design on screen was derived from; absent until a synth has succeeded with a usable Sidecar. */
  private snapshot: { facts: Facts; assembly: Assembly } | undefined;

  /** The app as the files hold it, from the last synth of them. */
  private base: Base | undefined;
  /** Bumped when the files may have changed; the base is out of date until a synth has read the version it was bumped to. */
  private filesVersion = 0;
  private baseVersion = -1;
  private draft: Draft = emptyDraft;
  /** The intents the Design on screen was synthed with, so that Save knows the screen shows the Draft as it is now. */
  private shownIntents: readonly Intent[] | undefined;
  /** Edits dropped when the code changed under the Draft, and why. */
  private notices: string[] = [];
  /** Everything found wrong with the Design on screen: the app's own annotations and cycles, and what the checks of the shown Draft found. */
  private found: Problem[] = [];
  /** The intents the Draft last synthed with, so that those staged since are the ones that may have broken it. */
  private lastGood: readonly Intent[] = [];
  /** The error the Draft's synth gave, while it is the latest word on the Draft. */
  private draftError: string | undefined;
  /** TypeScript diagnostics of the files on disk, by the files a Draft touches, for the length of one base. */
  private baseDiagnostics = new Map<string, Diagnostic[]>();
  /** Why the app can't be synthed with a Draft applied, when it can't. */
  private blocked: string | undefined;

  private readonly migrations: readonly Migration[];
  private catalog: Catalog | undefined;

  constructor(private readonly deps: SessionDeps) {
    this.migrations = deps.migrations ?? MIGRATIONS;
    this.catalog = deps.catalog;
  }

  view(): View {
    return this.current;
  }

  /** How many edits the Draft holds, which Truss asks about before it quits. */
  draftSize(): number {
    return this.draft.intents.length;
  }

  /** The palette's search: constructs of the Catalog by name, service or CloudFormation type, best first. */
  searchCatalog(query: string, limit?: number): SearchHit[] {
    return this.catalog ? searchCatalog(this.catalog, query, limit) : [];
  }

  /** Calls `listener` with every new View. Returns an unsubscribe function. */
  subscribe(listener: (view: View) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Watches the app, then synths it and derives the first Design. Resolves when that synth is done. */
  async start(): Promise<void> {
    this.unwatch ??= this.deps.files.watch(() => {
      this.filesVersion++;
      void this.request();
    });
    await this.request();
  }

  /** Stops watching. A synth already running finishes, but nothing is derived after it. */
  stop(): void {
    this.stopped = true;
    this.unwatch?.();
    this.unwatch = undefined;
  }

  /** Applies one request from the browser. Never throws: a failure is a refusal. */
  handle(message: ClientMessage): Promise<Reply> {
    // A search only reads the Catalog, so it neither waits behind an edit nor stops when edits are paused.
    if (message.type === 'search') {
      return Promise.resolve({ type: 'results', requestId: message.requestId, hits: this.searchCatalog(message.query) });
    }
    // Likewise a panel only reads the Design on screen.
    if (message.type === 'panel') return Promise.resolve(this.panel(message));
    // Save waits for the synth in flight, so it writes what the screen shows.
    if (message.type === 'save') return this.settled().then(() => this.serialised(() => this.save(message.requestId)));
    return this.serialised(() => this.apply(message));
  }

  /** The property panel of a Node or Stack of the Design on screen. */
  private panel({ requestId, id }: PanelMessage): Reply {
    const panel = this.snapshot && buildPanel(id, this.current, this.snapshot.facts, this.catalog, { intents: this.draft.intents, ...this.editBlock() });
    if (!panel) return { type: 'refused', requestId, reason: `No Node or Stack at ${id}` };
    const here = this.found.filter((p) => p.path === id || p.path?.startsWith(`${id}/`));
    if (here.length > 0) panel.problems = here.map((p) => ({ severity: p.severity, message: p.message, draft: p.draft }));
    return { type: 'panel', requestId, panel };
  }

  /** Why no edit can be made to the Draft at the moment, if so. A synth error the Draft itself causes doesn't stop it: the Draft is what the user fixes it with. */
  private editBlock(): { blocked?: string } {
    if (this.current.error && this.current.error.kind !== 'draft') return { blocked: `Editing is paused until the app synths again: ${this.current.error.message}` };
    return this.blocked ? { blocked: this.blocked } : {};
  }

  /**
   * Asks for a synth of the files as they are now. At most one runs and at most one waits: a request
   * while one is running makes it stale and queues a single run that reads the latest state.
   * Resolves when no run is left.
   */
  private request(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (this.cycle) {
      this.waiting = true;
      return this.cycle;
    }
    this.cycle = this.drain();
    return this.cycle;
  }

  /** Resolves once no synth is running or waiting. */
  private async settled(): Promise<void> {
    while (this.cycle) await this.cycle;
  }

  private async drain(): Promise<void> {
    try {
      do {
        this.waiting = false;
        await this.derive();
      } while (this.waiting && !this.stopped);
    } finally {
      // Cleared in the same turn as the loop's last check, so no request can slip in between.
      this.cycle = undefined;
    }
  }

  private async derive(): Promise<void> {
    this.push({ synthing: true });
    try {
      if (!(await this.refreshCatalog()) || this.stopped) return;
      if (!this.base || this.baseVersion !== this.filesVersion) {
        if (!(await this.deriveBase())) return;
      }
      if (this.draft.intents.length === 0) return;
      await this.deriveDraft();
    } catch (err) {
      if (this.stopped || this.isStale()) return;
      this.fail({ message: err instanceof Error ? err.message : String(err) });
    }
  }

  /** Synths the files as they are on disk, and shows them when the Draft is empty. False when that did not give a base to build the Draft on. */
  private async deriveBase(): Promise<boolean> {
    const version = this.filesVersion;
    const [result, files, support] = await Promise.all([this.deps.synth.synth(this.deps.appDir), this.deps.files.read(), this.draftSupport()]);
    if (this.stopped || this.isStale()) return false;
    return this.serialised(async () => {
      this.blocked = support;
      if (!(await this.readSidecar())) return false;
      if (!result.ok) {
        this.fail(result.error);
        return false;
      }
      this.base = { files, facts: this.deps.source.analyse(files, result.assembly), assembly: result.assembly };
      this.baseDiagnostics = new Map();
      this.baseVersion = version;
      if (this.draft.intents.length === 0) this.showBase(true);
      return true;
    });
  }

  /** The Draft's text synthed in a shadow copy of the app, after the Draft is planned again on the base: an edit the code has changed under is dropped. */
  private async deriveDraft(): Promise<void> {
    const base = this.base!;
    this.rebase(base);
    // The base synthed, so an error shown from before it did is over, whatever the rebase left of the Draft.
    if (this.draft.intents.length === 0) return this.serialised(async () => this.showBase(true));
    const planned = this.planned()!;
    if (!planned.ok) return this.failDraft({ message: planned.reason });
    const intents = this.draft.intents;
    const result = await this.deps.synth.synth(this.deps.appDir, { overlay: planned.overlay });
    if (this.stopped || this.isStale()) return;
    await this.serialised(() => this.show(result, planned.merged, { intents, changes: planned.changes, base }));
  }

  /** Plans the Draft on `base` again, dropping each intent that no longer finds its target and noting why. */
  private rebase(base: Base): void {
    const dropped: string[] = [];
    for (let plan = this.deps.source.plan(base.files, base.facts, this.draft.intents); !plan.ok; plan = this.deps.source.plan(base.files, base.facts, this.draft.intents)) {
      const intent = this.draft.intents[plan.intent];
      if (!intent) break;
      dropped.push(`Dropped ${describeIntent(intent)} on ${intent.expect.literalId}: ${plan.reason}`);
      this.draft = { ...this.draft, intents: this.draft.intents.filter((_, i) => i !== plan.intent) };
    }
    // Notices stay until the Draft is undone, redone, discarded or saved, so a later rebase adds to them rather than replacing them.
    this.notices = [...this.notices, ...dropped];
  }

  /** Whether the app can be synthed with a Draft, and if not, why. */
  private async draftSupport(): Promise<string | undefined> {
    const support = await this.deps.synth.draftSupport?.(this.deps.appDir);
    return support && !support.ok ? support.reason : undefined;
  }

  /** Takes the Catalog the app's installed libraries give now. False, with the reason shown, when Truss can't open the app any more. */
  private async refreshCatalog(): Promise<boolean> {
    if (!this.deps.reloadCatalog) return true;
    const load = await this.deps.reloadCatalog();
    if (load.ok) {
      this.catalog = load.catalog;
      return true;
    }
    if (!this.stopped) this.fail({ message: load.message });
    return false;
  }

  /**
   * Reads the Sidecar as the file holds it now, not as it was when the synth began. False, with the
   * problem shown in place of the Design, when it can't be used.
   */
  private async readSidecar(): Promise<boolean> {
    const sidecarText = await this.deps.files.readText(SIDECAR_FILE);
    const parsed = sidecarText === undefined ? { ok: true as const, sidecar: emptySidecar() } : parseSidecar(sidecarText, this.migrations);
    if (!parsed.ok) {
      this.snapshot = undefined;
      this.found = [];
      this.push({ synthing: false, hasDesign: false, error: { kind: 'sidecar', message: parsed.message }, stages: [], stacks: [], nodes: [] });
      return false;
    }
    this.sidecar = parsed.sidecar;
    return true;
  }

  /** Shows the result of synthing the Draft. */
  private async show(result: SynthResult, files: FileSet, shown: { intents: readonly Intent[]; changes: Record<string, TextChange[]>; base: Base }): Promise<void> {
    // The Draft was changed while this was synthing (discarded, say): the result is of a Draft that is gone.
    if (shown.intents !== this.draft.intents) return;
    if (!(await this.readSidecar())) return;
    if (!result.ok) return this.failDraft(result.error, { ...shown, merged: files });
    const facts = this.deps.source.analyse(files, result.assembly);
    this.snapshot = { facts, assembly: result.assembly };
    this.shownIntents = shown.intents;
    this.lastGood = shown.intents;
    this.draftError = undefined;
    this.found = [
      ...annotationProblems(result.assembly, shown.base.assembly),
      ...cycleProblems(result.assembly, shown.base.assembly),
      ...this.editProblems(shown, files, result),
    ];
    this.push({ synthing: false, hasDesign: true, error: undefined, ...this.body(), ...this.draftFields() });
  }

  /** What the shared edit check finds wrong with the shown Draft: the TypeScript diagnostics it adds, and the ways it is not the edit the intents mean. */
  private editProblems(shown: { intents: readonly Intent[]; changes: Record<string, TextChange[]>; base: Base }, merged: FileSet, result: SynthResult): Problem[] {
    const checked = checkEditOn(this.deps, shown.base, shown.intents, result, this.baseDiagnostics);
    return checked.failures.map((f): Problem => {
      if (f.kind === 'typescript') {
        const d = f.diagnostic;
        const at = d ? this.traceToBase({ file: d.file, line: d.line, col: 1 }, { ...shown, merged }) : undefined;
        return { id: `typescript:${f.message}`, severity: 'error', source: 'typescript', message: f.message, ...(at?.path ? { path: at.path } : {}), ...(d ? { location: { file: d.file, line: d.line, col: 1 } } : {}), draft: true, blocking: true };
      }
      return { id: `truss:${f.message}`, severity: 'error', source: 'truss', message: f.message, draft: true, blocking: true, trussBug: true };
    });
  }

  /** Where a place in the Draft's text is in the code on disk, and the Node it is in (the text of the Draft has different line numbers inside the code it changes). */
  private traceToBase(at: SourceLocation, shown: { base: Base; changes: Record<string, TextChange[]>; merged: FileSet }): { location: SourceLocation; path?: string } {
    const mergedText = shown.merged.get(at.file);
    const baseText = shown.base.files.get(at.file);
    if (mergedText === undefined || baseText === undefined) return { location: at };
    const location = { file: at.file, ...sourcePosition(baseText, shown.changes[at.file] ?? [], mergedText, at) };
    const path = nodeAt(shown.base.facts, location);
    return { location, ...(path ? { path } : {}) };
  }

  /** The Problems of the app on disk, which are the ones that are not the Draft's. */
  private baseProblems(): Problem[] {
    return this.base ? [...annotationProblems(this.base.assembly), ...cycleProblems(this.base.assembly)] : [];
  }

  /** The Problem that a synth error is. */
  private errorProblem(error: SynthError, draft: boolean, path?: string): Problem {
    return { id: 'synth', severity: 'error', source: 'synth', message: error.message, ...(path ? { path } : {}), ...(error.location ? { location: error.location } : {}), draft, blocking: true };
  }

  /** Shows the files as they are on disk, with the Draft empty. An error the Draft caused is gone with it, and with `fresh` (a synth just succeeded) so is any other. */
  private showBase(fresh = false): void {
    const base = this.base!;
    this.snapshot = { facts: base.facts, assembly: base.assembly };
    this.shownIntents = undefined;
    this.lastGood = [];
    this.draftError = undefined;
    const error = fresh || this.current.error?.kind === 'draft' ? undefined : this.current.error;
    this.found = [...(error ? this.found.filter((p) => p.source === 'synth' && !p.draft) : []), ...this.baseProblems()];
    this.push({ synthing: false, hasDesign: true, error, ...this.body(), ...this.draftFields() });
  }

  /** The View of the Design on screen, with the Nodes the Draft changes marked. */
  private body() {
    return buildView(this.snapshot!.facts, this.snapshot!.assembly, this.sidecar, this.base ? targetPaths(this.base.facts, this.draft.intents) : new Set());
  }

  /** The parts of the View that speak of the Draft, always all of them so that a push clears what no longer holds. */
  private draftFields(): Pick<View, 'draft' | 'draftBlocked'> {
    return { draft: this.draftView(), draftBlocked: this.blocked };
  }

  private draftView(): DraftView | undefined {
    const { intents, redo: undone } = this.draft;
    if (intents.length === 0 && undone.length === 0 && this.notices.length === 0) return undefined;
    const planned = this.planned();
    const diffs: FileDiff[] = [];
    if (planned?.ok && this.base) {
      for (const [file, text] of planned.overlay) {
        const diff = unifiedDiff(file, this.base.files.get(file) ?? '', text);
        if (diff) diffs.push(diff);
      }
    }
    const suspects = this.draftError === undefined ? [] : intents.filter((i) => !this.lastGood.includes(i));
    const bugs = this.found.filter((p) => p.trussBug).map((p) => p.message);
    return {
      items: intents.map((i) => ({
        id: i.path,
        label: i.expect.literalId,
        summary: describeIntent(i),
        ...(suspects.includes(i) ? { suspect: true as const } : {}),
        ...(suspects.length === 1 && suspects[0] === i ? { error: this.draftError! } : {}),
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

  /** Plans the Draft's intents on the base. Undefined with no base to plan on. */
  private planned(): Planned | undefined {
    if (!this.base) return undefined;
    return planEdit(this.deps.source, this.base, this.draft.intents);
  }

  /** Stale means the files changed during the run, so the next run reads newer ones; but only so many in a row. */
  private isStale(): boolean {
    if (this.waiting && this.staleInARow < MAX_STALE_IN_A_ROW) {
      this.staleInARow++;
      return true;
    }
    this.staleInARow = 0;
    return false;
  }

  /** Shows the error. The last good Design, if there is one, stays so the user keeps their bearings. */
  private fail(error: SynthError): void {
    const location = error.location ?? locateError(error, this.deps.appDir);
    this.draftError = undefined;
    this.found = [this.errorProblem({ ...error, ...(location ? { location } : {}) }, false)];
    this.push({ synthing: false, error: { ...error, ...(location ? { location } : {}) }, ...this.draftFields() });
  }

  /**
   * Shows the error the Draft causes. The last good Design stays; the error is traced to the Node whose `new`
   * it points into, and the edits staged since the last good synth become suspects.
   */
  private failDraft(error: SynthError, shown?: { base: Base; changes: Record<string, TextChange[]>; merged: FileSet }): void {
    const raw = error.location ?? locateError(error, this.deps.appDir);
    const traced = raw && shown ? this.traceToBase(raw, shown) : raw ? { location: raw } : undefined;
    const withPlace = { ...error, ...(traced ? { location: traced.location } : {}) };
    this.draftError = error.message;
    this.found = [this.errorProblem(withPlace, true, traced && 'path' in traced ? traced.path : undefined), ...this.baseProblems()];
    this.push({ synthing: false, error: { ...withPlace, kind: 'draft' }, ...this.draftFields() });
  }

  private serialised<T>(work: () => Promise<T>): Promise<T> {
    const run = this.queue.then(work);
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async apply(message: EditMessage | Exclude<DraftMessage, { type: 'save' }>): Promise<Reply> {
    const { requestId } = message;
    if (!this.snapshot) return { type: 'refused', requestId, reason: 'There is no Design to edit yet.' };
    if (message.type === 'setProp') return this.setProp(message);
    // A Draft is held as it was while the code on disk doesn't synth, so only Discard can change it then.
    if ((message.type === 'undo' || message.type === 'redo') && this.current.error && this.current.error.kind !== 'draft') {
      return { type: 'refused', requestId, reason: `Editing is paused until the app synths again: ${this.current.error.message}` };
    }
    if (message.type === 'undo' || message.type === 'redo' || message.type === 'discard') return this.changeDraft(message);
    // The Design on screen is the last good one, dimmed: editing it waits until the app synths again.
    if (this.current.error) {
      return { type: 'refused', requestId, reason: `Editing is paused until the app synths again: ${this.current.error.message}` };
    }
    if (!this.current.nodes.some((n) => n.id === message.id)) {
      return { type: 'refused', requestId, reason: `No Node at ${message.id}` };
    }
    let next: Sidecar;
    try {
      // The file may have changed since the last change (a branch switch, a pull), so build on what it holds now.
      const text = await this.deps.files.readText(SIDECAR_FILE);
      const parsed = text === undefined ? { ok: true as const, sidecar: emptySidecar() } : parseSidecar(text, this.migrations);
      if (!parsed.ok) return { type: 'refused', requestId, reason: parsed.message };
      next =
        message.type === 'move'
          ? withPosition(parsed.sidecar, message.id, message)
          : withNote(parsed.sidecar, message.id, message.note);
      await this.deps.files.writeText(SIDECAR_FILE, serializeSidecar(next, currentFormatVersion(this.migrations)));
    } catch (err) {
      return { type: 'refused', requestId, reason: `Couldn't update ${SIDECAR_FILE}: ${err instanceof Error ? err.message : String(err)}` };
    }
    this.sidecar = next;
    this.push(this.body());
    return { type: 'ack', requestId };
  }

  /** Stages an edit of a prop: checked against the panel the user edited it in, planned, and then synthed in a shadow copy. */
  private setProp(message: Extract<DraftMessage, { type: 'setProp' }>): Reply {
    const { requestId, id, prop, value } = message;
    const refuse = (reason: string): Reply => ({ type: 'refused', requestId, reason });
    if (!this.base || !this.snapshot) return refuse('There is no Design to edit yet.');
    const panel = buildPanel(id, this.current, this.snapshot.facts, this.catalog, { intents: this.draft.intents, ...this.editBlock() });
    if (!panel) return refuse(`No Node or Stack at ${id}`);
    if (panel.readOnly) return refuse(panel.readOnly);
    const input = inputFor(panel, prop);
    const named = prop.join('.');
    if (!input) return refuse(`${named} can't be edited here`);
    const fits =
      input.kind === value.kind &&
      (input.kind !== 'enum' || (value.kind === 'enum' && value.type === input.fqn && input.members.includes(value.member)));
    if (!fits) return refuse(`${named} takes a ${input.kind}, not a ${value.kind}`);
    if (panel.literalId === undefined) return refuse(`${id} has no Construct ID in the code to edit by`);

    const intent: Intent = { type: 'setProp', path: id, expect: { className: panel.className, literalId: panel.literalId }, prop, value };
    const before = this.draft;
    this.draft = stage(before, intent);
    const planned = this.planned()!;
    if (!planned.ok) {
      this.draft = before;
      return refuse(planned.reason);
    }
    // A Draft that changes no code, as when a value is put back, holds nothing.
    if (Object.keys(planned.changes).length === 0) this.draft = { intents: [], redo: this.draft.redo };
    this.afterDraftChange();
    return { type: 'ack', requestId };
  }

  private changeDraft({ requestId, type }: { requestId: string; type: 'undo' | 'redo' | 'discard' }): Reply {
    const refuse = (reason: string): Reply => ({ type: 'refused', requestId, reason });
    if (!this.base) return refuse('There is no Design to edit yet.');
    if (type === 'undo') {
      if (this.draft.intents.length === 0) return refuse('Nothing to undo.');
      this.draft = undo(this.draft);
    } else if (type === 'redo') {
      if (this.draft.redo.length === 0) return refuse('Nothing to redo.');
      this.draft = redo(this.draft);
    } else {
      this.draft = emptyDraft;
    }
    this.notices = [];
    this.afterDraftChange();
    return { type: 'ack', requestId };
  }

  /** Shows the Draft as it now is at once (badges, list, diff), and synths it in the background. An empty Draft needs no synth: the base is the Design. */
  private afterDraftChange(): void {
    if (this.draft.intents.length === 0) {
      this.showBase();
      return;
    }
    this.shownIntents = undefined;
    // The checks were of the Draft as it was; the error stays, with its suspects, until synth has another word.
    this.found = this.found.filter((p) => !p.blocking || p.source === 'synth');
    this.push({ ...this.body(), ...this.draftFields() });
    void this.request();
  }

  /** Writes the Draft to the user's files, all of them or none (ADR 0006). */
  private async save(requestId: string): Promise<Reply> {
    const refuse = (reason: string): Reply => ({ type: 'refused', requestId, reason });
    const base = this.base;
    if (!base || this.draft.intents.length === 0) return refuse('There is nothing in the Draft to save.');
    // A Draft is held, not rebased, while the code on disk doesn't synth: there is nothing to check it against.
    if (this.current.error?.kind === 'draft') return refuse(`Fix the Problem the Draft causes first: ${this.current.error.message}`);
    if (this.current.error) return refuse(`Save is paused until the app synths again: ${this.current.error.message}`);
    // Files changed after Save began to wait: the Draft has not been planned on them.
    if (this.cycle || this.baseVersion !== this.filesVersion) return refuse('Truss is still reading changes to your code. Try again in a moment.');
    // The screen has to show the Draft as it is now, because the checks were made on what it shows.
    if (this.shownIntents !== this.draft.intents || !this.snapshot) return refuse('Truss is still checking the Draft. Try again in a moment.');
    const planned = this.planned();
    if (!planned?.ok) return refuse(planned ? planned.reason : 'There is no Design to save.');

    const checked = checkEditOn(this.deps, base, this.draft.intents, { ok: true, assembly: this.snapshot.assembly }, this.baseDiagnostics);
    const failures = [...this.found.filter((p) => p.blocking && p.source !== 'typescript' && p.source !== 'truss').map((p) => p.message), ...checked.failures.map((f) => f.message)];
    if (failures.length > 0) return refuse(`The Draft can't be saved: ${failures.join('; ')}`);

    const written = await commit(this.deps.files, planned.overlay, base.files);
    if (!written.ok) return refuse(written.reason);

    this.draft = emptyDraft;
    this.notices = [];
    this.found = [];
    this.lastGood = [];
    // What was written is now the base, but only a synth of it can say so.
    this.filesVersion++;
    this.push({ ...this.body(), ...this.draftFields() });
    void this.request();
    return { type: 'ack', requestId };
  }

  private push(change: Partial<Omit<View, 'version'>>): void {
    const next: View = { ...this.current, problems: this.found, ...change, version: this.current.version + 1 };
    // A field set to undefined is a field cleared.
    if (next.error === undefined) delete next.error;
    if (next.draft === undefined) delete next.draft;
    if (next.draftBlocked === undefined) delete next.draftBlocked;
    this.current = next;
    for (const listener of this.listeners) listener(next);
  }
}
