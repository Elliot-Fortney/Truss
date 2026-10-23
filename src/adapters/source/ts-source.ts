// The only module that imports `typescript` (ADR 0007). Nothing that leaves it is a syntax tree.
import ts from '@typescript/typescript6';
import type { Assembly, Frame, TreeNode } from '../../core/assembly.ts';
import type { Binding, EnclosingClass, Facts, NodeFacts, PropFacts, PropsFacts, Span, Surround } from '../../core/facts.ts';
import type { FileSet, Source } from '../../core/ports.ts';

const frameKey = (f: Frame) => `${f.file}:${f.line}:${f.col}`;

export class TsSource implements Source {
  /** Parsed files, reused while a file's text is unchanged. */
  private parsed = new Map<string, { text: string; sf: ts.SourceFile }>();

  analyse(files: FileSet, assembly: Assembly): Facts {
    const frames = new Map<string, Frame>();
    this.collectFrames(assembly.tree, assembly, new Set(assembly.stacks.map((s) => s.path)), undefined, frames);

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
    return { nodes };
  }

  /**
   * Gives each construct the frame of the `new` call that made it. A construct without its own
   * creation stack (an L2 container) takes the frame its descendants agree on; an app-defined
   * construct class takes the call site of its constructor. Only the shallowest path on a frame is
   * kept, because the paths beneath it are that construct's own children.
   */
  private collectFrames(
    node: TreeNode,
    assembly: Assembly,
    stacks: Set<string>,
    parentFrame: Frame | undefined,
    out: Map<string, Frame>,
    stackPath?: string,
    userDepth = 0,
  ): void {
    const isStack = stacks.has(node.path);
    if (isStack) stackPath = node.path;
    const isUserClass = stackPath !== undefined && !isStack && node.fqn === USER_CONSTRUCT_FQN;
    if (isUserClass) userDepth++;
    // A stack is only ever where its own `new` call is; borrowing its children's frame would hide them.
    const borrowed =
      node.path === '' || isStack
        ? undefined
        : isUserClass
          ? userClassFrame(node, assembly, stackPath!, userDepth)
          : agreedFrame(node, assembly);
    const frame = assembly.creation[node.path]?.[0] ?? borrowed;
    if (node.path !== '' && frame && (!parentFrame || frameKey(parentFrame) !== frameKey(frame))) {
      out.set(node.path, frame);
    }
    for (const child of node.children) this.collectFrames(child, assembly, stacks, frame, out, stackPath, userDepth);
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
    const literalId = id && (ts.isStringLiteral(id) || ts.isNoSubstitutionTemplateLiteral(id)) ? id.text : undefined;
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

/** The frame every descendant with a creation stack shares, if they all share one. */
function agreedFrame(node: TreeNode, assembly: Assembly): Frame | undefined {
  const seen = new Map<string, Frame>();
  const walk = (n: TreeNode) => {
    const f = assembly.creation[n.path]?.[0];
    if (f) seen.set(frameKey(f), f);
    n.children.forEach(walk);
  };
  node.children.forEach(walk);
  return seen.size === 1 ? [...seen.values()][0] : undefined;
}

function propsOf(sf: ts.SourceFile, arg: ts.Expression): PropsFacts {
  if (!ts.isObjectLiteralExpression(arg)) return { form: 'other', text: arg.getText(sf) };
  const props: PropFacts[] = arg.properties.map((p) => {
    // A spread has no name of its own, so its source text stands in for one.
    const name = ts.isSpreadAssignment(p) ? p.getText(sf) : p.name ? p.name.getText(sf) : p.getText(sf);
    const value = ts.isPropertyAssignment(p) ? p.initializer : undefined;
    return { name, kind: value && isLiteral(value) ? 'literal' : 'expression', text: value ? value.getText(sf) : p.getText(sf) };
  });
  return { form: 'object', props };
}

function isLiteral(n: ts.Expression): boolean {
  return (
    ts.isStringLiteral(n) ||
    ts.isNoSubstitutionTemplateLiteral(n) ||
    ts.isNumericLiteral(n) ||
    n.kind === ts.SyntaxKind.TrueKeyword ||
    n.kind === ts.SyntaxKind.FalseKeyword ||
    n.kind === ts.SyntaxKind.NullKeyword ||
    (ts.isPrefixUnaryExpression(n) && n.operator === ts.SyntaxKind.MinusToken && ts.isNumericLiteral(n.operand))
  );
}

function bindingOf(n: ts.NewExpression): Binding {
  const parent = n.parent;
  if (ts.isVariableDeclaration(parent)) return 'const';
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
