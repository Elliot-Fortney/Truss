// The only module that imports `typescript` (ADR 0007). Nothing that leaves it is a syntax tree.
import { join } from 'node:path';
import ts from '@typescript/typescript6';
import type { Assembly, Frame, TreeNode } from '../../core/assembly.ts';
import type { Binding, EnclosingClass, Facts, NodeFacts, PropFacts, PropsFacts, Span, Surround } from '../../core/facts.ts';
import type { Intent } from '../../core/intents.ts';
import type { Diagnostic, FileSet, PlanResult, Source } from '../../core/ports.ts';
import type { Catalog } from '../../core/catalog.ts';
import { CallReader } from './calls.ts';
import { ReferenceReader } from './references.ts';
import { planIntents } from './ts-plan.ts';
import { isStringLike, literalValue, memberOf, quantityOf } from './syntax.ts';
import { NESTED_STACK_FQN, STAGE_FQN, withoutNestedStackPlumbing } from '../../core/tree.ts';

const frameKey = (f: Frame) => `${f.file}:${f.line}:${f.col}`;

/** What `collectFrames` needs at every construct of the tree. */
interface FrameContext {
  assembly: Assembly;
  /** The frame of the `new` that made each path that has a creation stack of its own. */
  sites: Map<string, Frame>;
  /** Construct paths of the stacks synth wrote an artifact for. */
  stacks: Set<string>;
  out: Map<string, Frame>;
}

/** A `Class.fromXxx(this, 'Id', ...)` call: the facts it gives each construct it makes, and where to look for them. */
interface FromCall {
  facts: Omit<NodeFacts, 'pathsOnSpan'>;
  literalId: string;
  enclosingClass: EnclosingClass;
}

/** The string literals among a call's arguments. */
const identifiersOf = (args: readonly ts.Expression[]): string[] => args.flatMap((a) => (isStringLike(a) ? [a.text] : []));

export class TsSource implements Source {
  /** Parsed files, reused while a file's text is unchanged. */
  private parsed = new Map<string, { text: string; sf: ts.SourceFile }>();

  analyse(files: FileSet, assembly: Assembly, catalog?: Catalog): Facts {
    const sites = new Map<string, Frame>();
    for (const [path, list] of Object.entries(assembly.creation)) {
      const frame = this.creationSite(files, list);
      if (frame) sites.set(path, frame);
    }
    const frames = new Map<string, Frame>();
    this.collectFrames(assembly.tree, { assembly, sites, stacks: new Set(assembly.stacks.map((s) => s.path)), out: frames }, undefined);

    const nodes: Record<string, NodeFacts> = {};
    const perSpan = new Map<string, number>();
    for (const [path, frame] of frames) {
      const found = this.locateNew(files, frame);
      if (!found) continue;
      nodes[path] = { ...found, pathsOnSpan: 0 };
      perSpan.set(frameKey(frame), (perSpan.get(frameKey(frame)) ?? 0) + 1);
    }
    for (const [path, frame] of frames) {
      const facts = nodes[path];
      if (facts) facts.pathsOnSpan = perSpan.get(frameKey(frame)) ?? 1;
    }
    this.addExternals(files, assembly.tree, nodes);
    const reader = new ReferenceReader(nodes, (file) => this.parse(files, file), new Set(assembly.stacks.map((s) => s.path)));
    const references = reader.read();
    const fqns = new Map<string, string>();
    const index = (n: TreeNode) => {
      fqns.set(n.path, n.fqn);
      n.children.forEach(index);
    };
    index(assembly.tree);
    const calls = catalog ? new CallReader(nodes, fqns, files.keys(), (file) => this.parse(files, file), reader, catalog).read() : [];
    return { nodes, ...(references.length > 0 ? { references } : {}), ...(calls.length > 0 ? { calls } : {}) };
  }

  plan(files: FileSet, facts: Facts, intents: readonly Intent[]): PlanResult {
    return planIntents(files, facts, intents, (file) => this.parse(files, file));
  }

  /** Library files already parsed, reused while their modification time is unchanged: parsing `aws-cdk-lib` is most of the cost of a type check. */
  private libraries = new Map<string, { mtime: number; sf: ts.SourceFile }>();

  diagnostics(appDir: string, files: FileSet, touched: readonly string[]): Diagnostic[] {
    const configPath = ts.findConfigFile(appDir, ts.sys.fileExists, 'tsconfig.json');
    const config = configPath
      ? ts.getParsedCommandLineOfConfigFile(configPath, {}, { ...ts.sys, onUnRecoverableConfigFileDiagnostic: () => undefined })
      : undefined;
    const options: ts.CompilerOptions = { ...(config?.options ?? { strict: true, target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true, skipLibCheck: true }), noEmit: true };
    const absolute = (file: string) => join(appDir, file);
    const overlay = new Map([...files].map(([file, text]) => [absolute(file), text]));
    const host = ts.createCompilerHost(options);
    const { fileExists, readFile } = host;
    host.fileExists = (f) => overlay.has(f) || fileExists(f);
    host.readFile = (f) => overlay.get(f) ?? readFile(f);
    host.getSourceFile = (name, languageVersion) => {
      const text = overlay.get(name);
      if (text !== undefined) return ts.createSourceFile(name, text, languageVersion, true);
      const mtime = ts.sys.getModifiedTime?.(name)?.getTime() ?? 0;
      const cached = this.libraries.get(name);
      if (cached && cached.mtime === mtime) return cached.sf;
      const read = readFile(name);
      if (read === undefined) return undefined;
      const sf = ts.createSourceFile(name, read, languageVersion, true);
      this.libraries.set(name, { mtime, sf });
      return sf;
    };
    const roots = new Set([...(config?.fileNames ?? []), ...touched.map(absolute)]);
    const program = ts.createProgram({ rootNames: [...roots], options, host });
    return touched.flatMap((file) => {
      const sf = program.getSourceFile(absolute(file));
      if (!sf) return [];
      return [...program.getSyntacticDiagnostics(sf), ...program.getSemanticDiagnostics(sf)].map((d) => ({
        file,
        line: d.start === undefined ? 0 : sf.getLineAndCharacterOfPosition(d.start).line + 1,
        code: d.code,
        message: ts.flattenDiagnosticMessageText(d.messageText, '\n'),
      }));
    });
  }

  /**
   * The frame of the `new` that made a construct. A class of the app's own that extends a CDK construct
   * runs its constructor first, so the stack starts at that class's `super` call (or at the class itself,
   * when it has no constructor); the `new` call that made it is the frame after.
   */
  private creationSite(files: FileSet, frames: Frame[]): Frame | undefined {
    let i = 0;
    while (i < frames.length - 1 && frames[i]!.fn?.startsWith('new ') && this.isConstructorEntry(files, frames[i]!)) i++;
    return frames[i];
  }

  /** Whether the frame points at a `super(...)` call or at the `class` keyword of an implicit constructor. */
  private isConstructorEntry(files: FileSet, frame: Frame): boolean {
    const sf = this.parse(files, frame.file);
    if (!sf) return false;
    let hit = false;
    const visit = (n: ts.Node) => {
      const at = (node: ts.Node) => {
        const { line, character } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
        return line + 1 === frame.line && character + 1 === frame.col;
      };
      if (ts.isCallExpression(n) && n.expression.kind === ts.SyntaxKind.SuperKeyword && at(n)) hit = true;
      if (ts.isClassLike(n)) {
        const keyword = n.getChildren(sf).find((c) => c.kind === ts.SyntaxKind.ClassKeyword);
        if (keyword && at(keyword)) hit = true;
      }
      if (!hit) ts.forEachChild(n, visit);
    };
    visit(sf);
    return hit;
  }

  /**
   * Adds the Nodes made by `Class.fromXxx(this, 'Id', ...)` calls. Such a construct has no creation
   * stack, so it is found the other way round: a call with a literal ID in the constructor of a class
   * (or of a class of the app's own that extends it) gives each instance's child of that ID.
   */
  private addExternals(files: FileSet, tree: TreeNode, nodes: Record<string, NodeFacts>): void {
    const calls = [...files.keys()].flatMap((file) => (files.get(file)?.includes('.from') ? this.fromCalls(files, file) : []));
    if (calls.length === 0) return;
    const children = new Map<string, TreeNode[]>();
    const index = (n: TreeNode) => {
      children.set(n.path, n.children);
      n.children.forEach(index);
    };
    index(tree);
    // The constructs the app creates, before any external is added: an external is never another's parent.
    const parents = Object.entries(nodes).map(([path, facts]) => ({ path, chain: this.classChain(files, facts.className.split('.').at(-1)!) }));
    for (const call of calls) {
      const paths = parents
        .filter((p) => p.chain.has(call.enclosingClass.name) && children.get(p.path)?.some((c) => c.path === `${p.path}/${call.literalId}`))
        .map((p) => `${p.path}/${call.literalId}`)
        .filter((path) => !nodes[path]);
      for (const path of paths) nodes[path] = { ...call.facts, pathsOnSpan: paths.length };
    }
  }

  /** The class named `name` and the classes of the app's own it extends, by name. */
  private classChain(files: FileSet, name: string): Set<string> {
    const chain = new Set<string>();
    for (let decl = this.findClass(files, name); decl && !chain.has(decl.name!.text); ) {
      chain.add(decl.name!.text);
      const base = decl.heritageClauses?.find((h) => h.token === ts.SyntaxKind.ExtendsKeyword)?.types[0]?.expression;
      const baseName = base && (ts.isPropertyAccessExpression(base) ? base.name.text : ts.isIdentifier(base) ? base.text : undefined);
      decl = baseName ? this.findClass(files, baseName) : undefined;
    }
    if (chain.size === 0) chain.add(name);
    return chain;
  }

  /** The `X.fromY(this, 'Id', ...)` calls written directly in a class body. */
  private fromCalls(files: FileSet, file: string): FromCall[] {
    const sf = this.parse(files, file);
    if (!sf) return [];
    const found: FromCall[] = [];
    const visit = (n: ts.Node) => {
      if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && /^from[A-Z]/.test(n.expression.name.text)) {
        const [scope, id] = n.arguments;
        const enclosingClass = this.enclosingClassOf(files, n);
        const identifiers = identifiersOf(n.arguments.slice(2));
        if (scope?.kind === ts.SyntaxKind.ThisKeyword && id && isStringLike(id) && enclosingClass && !surroundOf(n)) {
          found.push({
            literalId: id.text,
            enclosingClass,
            facts: {
              span: spanOf(sf, n, file),
              className: n.expression.getText(sf),
              literalId: id.text,
              binding: bindingOf(n),
              enclosingClass,
              external: true,
              ...(identifiers.length > 0 ? { identifiers } : {}),
            },
          });
        }
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
    return found;
  }

  /**
   * Gives each construct the frame of the `new` call that made it. A construct without its own
   * creation stack (an L2 container) takes the frame its descendants agree on; an app-defined
   * construct class takes the call site of its constructor. Only the shallowest path on a frame is
   * kept, because the paths beneath it are that construct's own children.
   */
  private collectFrames(node: TreeNode, ctx: FrameContext, parentFrame: Frame | undefined, stackPath?: string, userDepth = 0): void {
    const isStack = ctx.stacks.has(node.path) || node.fqn === NESTED_STACK_FQN;
    if (isStack) stackPath = node.path;
    const isUserClass = stackPath !== undefined && !isStack && node.fqn === USER_CONSTRUCT_FQN;
    if (isUserClass) userDepth++;
    // A stack is only ever where its own `new` call is; borrowing its children's frame would hide them.
    const borrowed =
      node.path === '' || isStack || node.fqn === STAGE_FQN
        ? undefined
        : isUserClass
          ? userClassFrame(node, ctx.assembly, stackPath!, userDepth)
          : agreedFrame(node, ctx.sites);
    const frame = ctx.sites.get(node.path) ?? borrowed;
    if (node.path !== '' && frame && (!parentFrame || frameKey(parentFrame) !== frameKey(frame))) {
      ctx.out.set(node.path, frame);
    }
    for (const child of withoutNestedStackPlumbing(node.children)) this.collectFrames(child, ctx, frame, stackPath, userDepth);
  }

  private locateNew(files: FileSet, frame: Frame): Omit<NodeFacts, 'pathsOnSpan'> | undefined {
    const sf = this.parse(files, frame.file);
    if (!sf) return undefined;
    let found: ts.NewExpression | undefined;
    const visit = (n: ts.Node) => {
      if (ts.isNewExpression(n)) {
        const { line, character } = sf.getLineAndCharacterOfPosition(n.getStart(sf));
        if (line + 1 === frame.line && character + 1 === frame.col) found = n;
      }
      if (!found) ts.forEachChild(n, visit);
    };
    visit(sf);
    if (!found) return undefined;

    const id = found.arguments?.[1];
    const literalId = id && isStringLike(id) ? id.text : undefined;
    const enclosingClass = this.enclosingClassOf(files, found);
    const surround = surroundOf(found);
    const propsArg = found.arguments?.[2];
    return {
      span: spanOf(sf, found, frame.file),
      className: found.expression.getText(sf),
      ...(literalId !== undefined ? { literalId } : {}),
      binding: bindingOf(found),
      ...(enclosingClass ? { enclosingClass } : {}),
      ...(surround ? { surround } : {}),
      ...(propsArg ? { props: propsOf(sf, propsArg) } : {}),
    };
  }

  /** The innermost class around `n`, with what it extends followed through the app's own classes. */
  private enclosingClassOf(files: FileSet, n: ts.Node): EnclosingClass | undefined {
    for (let p: ts.Node | undefined = n.parent; p; p = p.parent) {
      if (ts.isClassDeclaration(p) && p.name) return { name: p.name.text, kind: this.classKind(files, p, new Set()) };
    }
    return undefined;
  }

  /**
   * Stack, Stage or construct, from the name each `extends` clause ends in, followed through the app's
   * own classes. A base class from a library other than CDK itself counts as a construct, which locks.
   */
  private classKind(files: FileSet, decl: ts.ClassDeclaration, seen: Set<string>): EnclosingClass['kind'] {
    const base = decl.heritageClauses?.find((h) => h.token === ts.SyntaxKind.ExtendsKeyword)?.types[0]?.expression;
    const baseName = base && (ts.isPropertyAccessExpression(base) ? base.name.text : ts.isIdentifier(base) ? base.text : undefined);
    if (baseName === 'Stack' || baseName === 'NestedStack') return 'stack';
    if (baseName === 'Stage') return 'stage';
    if (!baseName || seen.has(baseName)) return 'construct';
    const own = this.findClass(files, baseName);
    if (!own) return 'construct';
    seen.add(baseName);
    return this.classKind(files, own, seen);
  }

  /** The top-level class declared with `name` in the first file that has one. */
  private findClass(files: FileSet, name: string): ts.ClassDeclaration | undefined {
    for (const file of files.keys()) {
      const sf = this.parse(files, file);
      const hit = sf?.statements.find((s): s is ts.ClassDeclaration => ts.isClassDeclaration(s) && s.name?.text === name);
      if (hit) return hit;
    }
    return undefined;
  }

  private parse(files: FileSet, file: string): ts.SourceFile | undefined {
    const text = files.get(file);
    if (text === undefined) return undefined;
    const cached = this.parsed.get(file);
    if (cached?.text === text) return cached.sf;
    const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
    this.parsed.set(file, { text, sf });
    return sf;
  }
}

/** What the tree calls a construct whose class the app defines and that extends `Construct` directly. */
const USER_CONSTRUCT_FQN = 'constructs.Construct';

/**
 * Where an app-defined construct class was instantiated. Synth records no stack for such a class, but
 * every resource it creates carries the chain of constructor calls that led to it: each `new X` frame
 * is code inside X's constructor, and the frame after it is where X was created. Counting those from
 * the Stack's own constructor outward gives the call site of the class `depth` levels below the Stack.
 */
function userClassFrame(node: TreeNode, assembly: Assembly, stackPath: string, depth: number): Frame | undefined {
  const stackFrame = assembly.creation[stackPath]?.[0];
  const leaf = firstCreated(node, assembly);
  if (!stackFrame || !leaf) return undefined;
  const stackCtor = leaf.findIndex((f, i) => leaf[i + 1] && frameKey(leaf[i + 1]!) === frameKey(stackFrame));
  if (stackCtor < 0) return undefined;
  const ctors = leaf.flatMap((f, i) => (i <= stackCtor && f.fn?.startsWith('new ') ? [i] : []));
  const ctor = ctors[ctors.length - 1 - depth];
  return ctor === undefined ? undefined : leaf[ctor + 1];
}

/** The creation frames of the first descendant that has any. */
function firstCreated(node: TreeNode, assembly: Assembly): Frame[] | undefined {
  for (const child of node.children) {
    const frames = assembly.creation[child.path] ?? firstCreated(child, assembly);
    if (frames) return frames;
  }
  return undefined;
}

/**
 * The frame every descendant with a creation stack shares. When a later call of the app adds constructs beneath the
 * Node (a grant makes its role's policy, an event source its mapping), they do not share it: then it is the frame of the
 * L1 resource the construct is named for (`Resource`), or else the one frame most of them have.
 */
function agreedFrame(node: TreeNode, sites: Map<string, Frame>): Frame | undefined {
  const seen = new Map<string, { frame: Frame; count: number }>();
  const walk = (n: TreeNode) => {
    const f = sites.get(n.path);
    if (f) {
      const there = seen.get(frameKey(f));
      seen.set(frameKey(f), { frame: f, count: (there?.count ?? 0) + 1 });
    }
    n.children.forEach(walk);
  };
  node.children.forEach(walk);
  if (seen.size === 1) return [...seen.values()][0]!.frame;
  const own = sites.get(`${node.path}/Resource`);
  if (own) return own;
  const ranked = [...seen.values()].sort((a, b) => b.count - a.count);
  return ranked.length > 1 && ranked[0]!.count > ranked[1]!.count ? ranked[0]!.frame : undefined;
}

/** The props argument as written: an object literal prop by prop, anything else as one piece of text. */
function propsOf(sf: ts.SourceFile, arg: ts.Expression): PropsFacts {
  if (!ts.isObjectLiteralExpression(arg)) return { form: 'other', text: arg.getText(sf) };
  return { form: 'object', props: fieldsOf(sf, arg) };
}

function fieldsOf(sf: ts.SourceFile, obj: ts.ObjectLiteralExpression): PropFacts[] {
  return obj.properties.map((p): PropFacts => {
    // A spread has no name of its own, so its source text stands in for one.
    const name = ts.isSpreadAssignment(p) ? p.getText(sf) : p.name ? p.name.getText(sf) : p.getText(sf);
    const value = ts.isPropertyAssignment(p) ? p.initializer : undefined;
    if (value && ts.isObjectLiteralExpression(value)) return { name, kind: 'object', text: value.getText(sf), fields: fieldsOf(sf, value) };
    const literal = value ? literalValue(value) : undefined;
    const member = value ? memberOf(value) : undefined;
    const quantity = value ? quantityOf(value) : undefined;
    return {
      name,
      kind: literal ? 'literal' : 'expression',
      text: value ? value.getText(sf) : p.getText(sf),
      ...(literal ? { value: literal.value } : {}),
      ...(member ? { member } : {}),
      ...(quantity ? { quantity } : {}),
    };
  });
}

/** `const q = new Queue(...)`, `this.q = new Queue(...)` or a class property initializer, through any parentheses or `as`. */
function bindingOf(n: ts.Expression): Binding {
  let parent = n.parent;
  while (ts.isParenthesizedExpression(parent) || ts.isAsExpression(parent) || ts.isSatisfiesExpression(parent) || ts.isNonNullExpression(parent)) {
    parent = parent.parent;
  }
  if (ts.isVariableDeclaration(parent)) return 'const';
  if (ts.isPropertyDeclaration(parent)) return 'field';
  const assignedToThis =
    ts.isBinaryExpression(parent) &&
    parent.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
    ts.isPropertyAccessExpression(parent.left) &&
    parent.left.expression.kind === ts.SyntaxKind.ThisKeyword;
  return assignedToThis ? 'field' : 'none';
}

/** Callbacks of these array methods run once per element, so a `new` inside one is a loop. */
const ITERATING_METHODS = new Set(['forEach', 'map', 'flatMap', 'filter', 'reduce', 'some', 'every']);

/** The nearest loop or function around `n`; a class constructor, or the top of the file, ends the walk. */
function surroundOf(n: ts.Node): Surround | undefined {
  for (let p: ts.Node | undefined = n.parent; p; p = p.parent) {
    if (ts.isForStatement(p) || ts.isForInStatement(p) || ts.isForOfStatement(p) || ts.isWhileStatement(p) || ts.isDoStatement(p)) {
      return { kind: 'loop' };
    }
    if (ts.isConstructorDeclaration(p) || ts.isClassLike(p)) return undefined;
    if (ts.isFunctionLike(p)) {
      const call = p.parent;
      if (ts.isCallExpression(call) && ts.isPropertyAccessExpression(call.expression) && ITERATING_METHODS.has(call.expression.name.text)) {
        return { kind: 'loop' };
      }
      return { kind: 'helper', name: functionName(p) };
    }
  }
  return undefined;
}

function functionName(fn: ts.SignatureDeclaration): string {
  if (fn.name && (ts.isIdentifier(fn.name) || ts.isStringLiteral(fn.name))) return fn.name.text;
  const owner = fn.parent;
  if (ts.isVariableDeclaration(owner) && ts.isIdentifier(owner.name)) return owner.name.text;
  if (ts.isPropertyAssignment(owner) && ts.isIdentifier(owner.name)) return owner.name.text;
  return '(anonymous function)';
}

function spanOf(sf: ts.SourceFile, n: ts.Node, file: string): Span {
  const pos = (offset: number) => {
    const { line, character } = sf.getLineAndCharacterOfPosition(offset);
    return { line: line + 1, col: character + 1 };
  };
  return { file, start: pos(n.getStart(sf)), end: pos(n.getEnd()) };
}
