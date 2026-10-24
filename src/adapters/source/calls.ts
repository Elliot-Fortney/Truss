// Reads which statements of the code make Grants, Integrations and Network Connections (CONTEXT.md, ADR 0012). Part of `analyse` (ADR 0007).
import ts from '@typescript/typescript6';
import { entryFor, type Catalog, type CatalogEntry } from '../../core/catalog.ts';
import { nodeEditability } from '../../core/editability.ts';
import type { CallFacts, NodeFacts } from '../../core/facts.ts';
import type { ConnectionHint, ConnectionKind, HintCall } from '../../core/overlay.ts';
import { parentPath } from '../../core/construct-id.ts';
import { bare, type ReferenceReader } from './references.ts';
import { isStringLike, lastName } from './syntax.ts';

const SELF = '__self__';
const PEER = '__peer__';

const templates = new Map<string, ts.Expression>();

/** An Overlay's argument as an expression, with `{self}` and `{peer}` as names. */
function template(code: string): ts.Expression {
  let parsed = templates.get(code);
  if (!parsed) {
    const sf = ts.createSourceFile(
      'template.ts',
      `(${code.split('{self}').join(SELF).split('{peer}').join(PEER)})`,
      ts.ScriptTarget.Latest,
      true,
    );
    const statement = sf.statements[0];
    parsed =
      statement && ts.isExpressionStatement(statement) && ts.isParenthesizedExpression(statement.expression)
        ? statement.expression.expression
        : ts.factory.createNull();
    templates.set(code, parsed);
  }
  return parsed;
}

const mentionsPlaceholder = (n: ts.Node): boolean =>
  (ts.isIdentifier(n) && (n.text === SELF || n.text === PEER)) || ts.forEachChild(n, mentionsPlaceholder) === true;

/** The last two names of a call's callee, which is as much of `ns.Class.method` as the code has to agree on. */
function calleeName(e: ts.Expression): string | undefined {
  if (ts.isIdentifier(e)) return e.text;
  if (!ts.isPropertyAccessExpression(e)) return undefined;
  const object = lastName(e.expression);
  return object ? `${object}.${e.name.text}` : e.name.text;
}

/** What a hint's arguments bound the two ends to, as the keys of the spans that make them. */
interface Bound {
  self?: string;
  peer?: string;
  env?: string;
}

interface Reading {
  /** Reads the node an expression stands for, the way a placeholder is bound. */
  keyOf(e: ts.Expression, role: 'self' | 'peer'): string | undefined;
}

/** Whether `actual` is what `pattern` says, for the parts of the pattern that name the two Nodes; every other part of the pattern is left to the developer. */
function matches(pattern: ts.Expression, actual: ts.Expression, bound: Bound, reading: Reading): boolean {
  pattern = bare(pattern);
  actual = bare(actual);
  if (!mentionsPlaceholder(pattern)) return true;
  if (ts.isIdentifier(pattern)) {
    const role = pattern.text === PEER ? 'peer' : 'self';
    const key = reading.keyOf(actual, role);
    if (key === undefined || (bound[role] !== undefined && bound[role] !== key)) return false;
    bound[role] = key;
    return true;
  }
  if (ts.isPropertyAccessExpression(pattern))
    return (
      ts.isPropertyAccessExpression(actual) &&
      actual.name.text === pattern.name.text &&
      matches(pattern.expression, actual.expression, bound, reading)
    );
  if (ts.isNewExpression(pattern)) {
    if (!ts.isNewExpression(actual) || lastName(actual.expression) !== lastName(pattern.expression)) return false;
    return (pattern.arguments ?? []).every(
      (a, i) =>
        !mentionsPlaceholder(a) ||
        (actual.arguments?.[i] !== undefined && matches(a, actual.arguments[i], bound, reading)),
    );
  }
  if (ts.isCallExpression(pattern)) {
    if (!ts.isCallExpression(actual) || calleeName(actual.expression) !== calleeName(pattern.expression)) return false;
    return pattern.arguments.every(
      (a, i) =>
        !mentionsPlaceholder(a) ||
        (actual.arguments[i] !== undefined && matches(a, actual.arguments[i], bound, reading)),
    );
  }
  return false;
}

/** Whether the call's arguments are what the hint's say. A secondary call that sets an environment variable names it with a string. */
function argsMatch(
  call: Pick<HintCall, 'args'>,
  actual: readonly ts.Expression[],
  bound: Bound,
  reading: Reading,
  env: boolean,
): boolean {
  if (actual.length < call.args.length) return false;
  if (env) {
    const name = actual[0] && bare(actual[0]);
    if (!name || !isStringLike(name)) return false;
    bound.env = name.text;
  }
  return call.args.every((code, i) => matches(template(code), actual[i]!, bound, reading));
}

/** Calls and loops and branches the code can't be changed through. */
function surroundOf(st: ts.Statement): string | undefined {
  for (let p: ts.Node | undefined = st.parent; p; p = p.parent) {
    if (ts.isSourceFile(p) || ts.isModuleBlock(p)) return undefined;
    if (
      ts.isForStatement(p) ||
      ts.isForInStatement(p) ||
      ts.isForOfStatement(p) ||
      ts.isWhileStatement(p) ||
      ts.isDoStatement(p)
    )
      return 'Made in a loop';
    if (ts.isIfStatement(p) || ts.isSwitchStatement(p) || ts.isTryStatement(p) || ts.isConditionalExpression(p))
      return 'Made only under a condition';
    if (ts.isConstructorDeclaration(p)) return undefined;
    if (ts.isFunctionLike(p)) {
      const call = p.parent;
      if (
        ts.isCallExpression(call) &&
        ts.isPropertyAccessExpression(call.expression) &&
        ['forEach', 'map', 'flatMap', 'filter', 'reduce', 'some', 'every'].includes(call.expression.name.text)
      )
        return 'Made in a loop';
      const name =
        (ts.isFunctionDeclaration(p) || ts.isMethodDeclaration(p)) && p.name && ts.isIdentifier(p.name)
          ? p.name.text
          : ts.isVariableDeclaration(call) && ts.isIdentifier(call.name)
            ? call.name.text
            : '(anonymous function)';
      return `Made in the helper ${name}`;
    }
    if (ts.isClassLike(p)) return 'Made outside a constructor';
  }
  return undefined;
}

const enclosingClassName = (st: ts.Node): string | undefined => {
  for (let p: ts.Node | undefined = st.parent; p; p = p.parent)
    if (ts.isClassDeclaration(p) && p.name) return p.name.text;
  return undefined;
};

/** One statement read for the Connection it makes, before its Nodes are paired up. Nodes are named by the key of the span that makes them. */
interface Found {
  statement: ts.ExpressionStatement;
  kind: ConnectionKind;
  role: 'primary' | 'secondary';
  method: string[];
  /** The Node the hint belongs to, the Node it connects to, and the one the method is called on. */
  self: string;
  peer: string;
  on: string;
  hint?: { fqn: string; index: number; flow: 'out' | 'in' };
  env?: string;
  /** More than one hint reads the same statement. */
  ambiguous: boolean;
}

/** The ways to read a call's callee as a receiver, then a method: `a.b.c(…)` is `a` then `b.c`, or `a.b` then `c`. The longest receiver first. */
function splits(call: ts.CallExpression): { receiver: ts.Expression; method: string[] }[] {
  const chain: ts.Expression[] = [];
  const names: string[] = [];
  let at = bare(call.expression);
  while (ts.isPropertyAccessExpression(at)) {
    names.unshift(at.name.text);
    at = bare(at.expression);
    chain.unshift(at);
  }
  return names.map((_, k) => ({ receiver: chain[k]!, method: names.slice(k) })).reverse();
}

export class CallReader {
  private readonly out: CallFacts[] = [];
  private readonly reading: (kind: ConnectionKind) => Reading;

  constructor(
    private readonly nodes: Readonly<Record<string, NodeFacts>>,
    private readonly fqns: ReadonlyMap<string, string>,
    private readonly files: Iterable<string>,
    private readonly parse: (file: string) => ts.SourceFile | undefined,
    private readonly resolver: ReferenceReader,
    private readonly catalog: Catalog,
  ) {
    this.reading = (kind) => ({
      keyOf: (e, role) => this.keyOf(e, role === 'peer' ? kind : undefined),
    });
  }

  read(): CallFacts[] {
    for (const file of this.files) {
      const sf = this.parse(file);
      if (!sf) continue;
      const visit = (n: ts.Node) => {
        if (ts.isExpressionStatement(n)) this.statement(sf, file, n);
        ts.forEachChild(n, visit);
      };
      visit(sf);
    }
    return this.out;
  }

  /** The key of the Node an expression is, or, for the end a hint passes as an argument, the Node it reaches through an Overlay accessor. */
  private keyOf(e: ts.Expression, accessorFor?: ConnectionKind): string | undefined {
    const direct = this.resolver.valueOf(e, 0);
    if (direct !== undefined || accessorFor === undefined) return direct;
    const names: string[] = [];
    let at = bare(e);
    while (ts.isPropertyAccessExpression(at)) {
      names.unshift(at.name.text);
      at = bare(at.expression);
    }
    const root = names.length > 0 ? this.resolver.valueOf(at, 0) : undefined;
    const path = root === undefined ? undefined : this.resolver.bySpan.get(root)?.[0];
    const accessors = path === undefined ? [] : (this.entryOf(path)?.overlay?.accessors ?? []);
    if (accessorFor !== 'network' && accessorFor !== 'grant') return undefined;
    const as = accessorFor === 'network' ? 'connectable' : 'grantee';
    return accessors.some((a) => a.as === as && a.path.join('.') === names.join('.')) ? root : undefined;
  }

  private entryOf(path: string): CatalogEntry | undefined {
    const fqn = this.fqns.get(path);
    return fqn ? entryFor(this.catalog, fqn) : undefined;
  }

  private statement(sf: ts.SourceFile, file: string, st: ts.ExpressionStatement): void {
    const call = bare(st.expression);
    if (!ts.isCallExpression(call)) return;
    for (const { receiver, method } of splits(call)) {
      const key = this.resolver.valueOf(receiver, 0);
      if (key === undefined) continue;
      const found = this.hintsFor(st, call, key, method);
      if (found.length === 0) found.push(...this.generic(st, call, key, method));
      if (found.length === 0) continue;
      for (const f of found) this.emit(sf, file, f);
      return;
    }
  }

  /** The Overlay hints of the Node at `key` that the call is an instance of. */
  private hintsFor(st: ts.ExpressionStatement, call: ts.CallExpression, key: string, method: string[]): Found[] {
    const selfPath = this.resolver.bySpan.get(key)?.[0];
    const entry = selfPath === undefined ? undefined : this.entryOf(selfPath);
    const hints = entry?.overlay?.connections ?? [];
    const found: Found[] = [];
    hints.forEach((hint, index) => {
      if (!hint.primary.forms.some((f) => f.join('.') === method.join('.'))) return;
      const bound: Bound = { self: key };
      if (!argsMatch(hint.primary, call.arguments, bound, this.reading(hint.kind), false) || bound.peer === undefined)
        return;
      if (!this.fits(bound.peer, hint)) return;
      found.push({
        statement: st,
        kind: hint.kind,
        role: 'primary',
        method,
        self: key,
        peer: bound.peer,
        on: key,
        hint: { fqn: entry!.fqn, index, flow: hint.flow },
        ambiguous: false,
      });
    });
    const out: Found[] = found.map((f) => ({ ...f, ambiguous: found.length > 1 }));
    // What completes each one, in the statements next to it.
    for (const f of out.slice(0, 1)) {
      const hint = hints[f.hint!.index]!;
      for (const spec of hint.secondary ?? []) out.push(...this.secondaries(st, hint, spec, f));
    }
    return out;
  }

  /** The Node at `peer` is one of the classes the hint connects to. */
  private fits(peer: string, hint: ConnectionHint): boolean {
    const path = this.resolver.bySpan.get(peer)?.[0];
    const fqn = path === undefined ? undefined : this.fqns.get(path);
    if (fqn === undefined) return false;
    const assignable = new Set([fqn, ...(entryFor(this.catalog, fqn)?.assignableTo ?? [])]);
    return hint.peers.some((p) => assignable.has(p));
  }

  /** Statements beside `primary` that make the call a hint's secondary call describes between the same two Nodes. */
  private secondaries(primary: ts.ExpressionStatement, hint: ConnectionHint, spec: HintCall, f: Found): Found[] {
    const siblings =
      ts.isBlock(primary.parent) || ts.isSourceFile(primary.parent) || ts.isModuleBlock(primary.parent)
        ? primary.parent.statements
        : [];
    const out: Found[] = [];
    for (const st of siblings) {
      if (!ts.isExpressionStatement(st) || st === primary) continue;
      const call = bare(st.expression);
      if (!ts.isCallExpression(call)) continue;
      const wanted = spec.on === 'self' ? f.self : f.peer;
      const read = splits(call).find(
        (x) =>
          this.resolver.valueOf(x.receiver, 0) === wanted &&
          spec.forms.some((form) => form.join('.') === x.method.join('.')),
      );
      if (!read) continue;
      const bound: Bound = { self: f.self, peer: f.peer };
      const quoted = /^['"]/.test(spec.args[0]?.trim() ?? '');
      if (!argsMatch(spec, call.arguments, bound, this.reading(hint.kind), quoted)) continue;
      out.push({
        ...f,
        statement: st,
        role: 'secondary',
        method: read.method,
        on: wanted,
        ...(bound.env !== undefined ? { env: bound.env } : {}),
      });
    }
    return out;
  }

  /** A generic jsii call that takes an `IGrantable` and returns a `Grant`: the Grant it makes is recognised, though no hint says how to write one. */
  private generic(st: ts.ExpressionStatement, call: ts.CallExpression, key: string, method: string[]): Found[] {
    const path = this.resolver.bySpan.get(key)?.[0];
    const entry = path === undefined ? undefined : this.entryOf(path);
    const first = call.arguments[0];
    if (!entry || method.length !== 1 || !entry.grantMethods.includes(method[0]!) || !first) return [];
    const peer = this.keyOf(first, 'grant');
    return peer === undefined
      ? []
      : [{ statement: st, kind: 'grant', role: 'primary', method, self: key, peer, on: key, ambiguous: false }];
  }

  /** Pairs the Nodes the span keys stand for, one pair for each instance of the class around the call, and says what keeps it from being edited. */
  private emit(sf: ts.SourceFile, file: string, f: Found): void {
    if (f.self === f.peer) return;
    const selfs = this.resolver.bySpan.get(f.self) ?? [];
    const peers = this.resolver.bySpan.get(f.peer) ?? [];
    let pairs: [string, string][];
    let ambiguous = f.ambiguous;
    if (selfs.length === 1 && peers.length === 1) pairs = [[selfs[0]!, peers[0]!]];
    else {
      pairs = selfs.flatMap((s) =>
        peers.filter((p) => parentPath(p) === parentPath(s)).map((p): [string, string] => [s, p]),
      );
      if (pairs.length === 0) {
        pairs = selfs.flatMap((s) => peers.map((p): [string, string] => [s, p]));
        ambiguous = true;
      }
    }
    const start = sf.getLineAndCharacterOfPosition(f.statement.getStart(sf));
    const end = sf.getLineAndCharacterOfPosition(f.statement.getEnd());
    const span = {
      file,
      start: { line: start.line + 1, col: start.character + 1 },
      end: { line: end.line + 1, col: end.character + 1 },
    };
    for (const [s, p] of pairs) {
      const [on, peer] = f.on === f.self ? [s, p] : [p, s];
      const [from, to] = f.kind === 'grant' ? [p, s] : f.hint?.flow === 'in' ? [p, s] : [s, p];
      const reason = ambiguous
        ? 'More than one reading of this call fits, so Truss shows it and leaves it alone'
        : this.why(f.statement, file, [s, p]);
      this.out.push({
        id: `${file}:${span.start.line}:${span.start.col}`,
        kind: f.kind,
        role: f.role,
        on,
        peer,
        from,
        to,
        method: f.method,
        ...(f.hint ? { hint: `${f.hint.fqn}#${f.hint.index}` } : {}),
        ...(f.env !== undefined ? { env: f.env } : {}),
        text: f.statement.getText(sf),
        span,
        editable: reason === undefined,
        ...(reason !== undefined ? { reason } : {}),
      });
    }
  }

  /** What keeps Truss from editing a call made between these two Nodes, if anything does. */
  private why(st: ts.Statement, file: string, paths: readonly string[]): string | undefined {
    const surround = surroundOf(st);
    if (surround) return `${surround}, so Truss shows it and leaves it alone`;
    const nodes = paths.map((p) => this.nodes[p]);
    for (const [i, node] of nodes.entries()) {
      if (!node) return 'Truss found no code for one of its Nodes';
      const name = node.literalId ?? node.className;
      if (node.span.file !== file) return `${name} is made in ${node.span.file}, not in the file of this call`;
      const lock = nodeEditability(paths[i]!, node);
      if (!lock.editable) return `${name}: ${lock.reason}`;
    }
    const scope = enclosingClassName(st);
    const [self, peer] = nodes as [NodeFacts, NodeFacts];
    if (self.enclosingClass?.name !== scope || peer.enclosingClass?.name !== scope)
      return 'The Nodes and the call are not in the same scope';
    if (self.pathsOnSpan !== peer.pathsOnSpan) return 'The Nodes are not made the same number of times';
    return undefined;
  }
}
