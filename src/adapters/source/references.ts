// Reads which props of a construct point at other Nodes (CONTEXT.md: Reference). Part of `analyse` (ADR 0007).
import ts from '@typescript/typescript6';
import type { NodeFacts, ReferenceFacts, ReferenceForm } from '../../core/facts.ts';
import { parentPath } from '../../core/construct-id.ts';

const spanKey = (file: string, line: number, col: number) => `${file}:${line}:${col}`;
const MAX_ALIAS_DEPTH = 8;

/** What a prop's value says about one Node it names, before the Node is found by its span. */
interface Found {
  /** The span key of the `new` or `fromXxx` call that makes the Node. */
  target: string;
  form: ReferenceForm;
  expression: ts.Expression;
  /** The element of an array prop it is in. */
  index?: number;
}

const READ_ONLY: Partial<Record<ReferenceForm, string>> = {
  accessor: 'Reads a property of the Node, so Truss draws it to the Node but does not edit it',
  call: 'Passed through a call, so Truss draws it but does not edit it',
  conditional: 'Chosen by a condition, so Truss draws it but does not edit it',
};

/** Strips the wrappers that don't change what an expression is: parentheses, a cast, a non-null `!`. */
export function bare(e: ts.Expression): ts.Expression {
  while (ts.isParenthesizedExpression(e) || ts.isAsExpression(e) || ts.isSatisfiesExpression(e) || ts.isNonNullExpression(e)) e = e.expression;
  return e;
}

/** Reads the References of every construct made by a `new` in `files`. */
export class ReferenceReader {
  /** Paths by the span key of the call that makes them. */
  readonly bySpan = new Map<string, string[]>();

  constructor(
    private readonly nodes: Readonly<Record<string, NodeFacts>>,
    private readonly parse: (file: string) => ts.SourceFile | undefined,
    private readonly stacks: ReadonlySet<string>,
  ) {
    for (const [path, f] of Object.entries(nodes)) {
      const key = spanKey(f.span.file, f.span.start.line, f.span.start.col);
      (this.bySpan.get(key) ?? this.bySpan.set(key, []).get(key)!).push(path);
    }
  }

  read(): ReferenceFacts[] {
    const out: ReferenceFacts[] = [];
    for (const paths of this.bySpan.values()) {
      const first = this.nodes[paths[0]!]!;
      if (first.external || first.props?.form !== 'object') continue;
      const sf = this.parse(first.span.file);
      const made = sf && this.newAt(sf, first);
      const props = made?.arguments?.[2];
      if (!sf || !props || !ts.isObjectLiteralExpression(props)) continue;
      for (const from of paths.filter((p) => !this.stacks.has(p))) {
        for (const p of props.properties) {
          for (const found of this.inProp(p)) {
            const to = this.pathFor(found.target, from);
            if (to === undefined || to === from || this.stacks.has(to)) continue;
            out.push(this.fact(sf, first, from, to, p, found));
          }
        }
      }
    }
    return out;
  }

  private fact(sf: ts.SourceFile, node: NodeFacts, from: string, to: string, prop: ts.ObjectLiteralElementLike, found: Found): ReferenceFacts {
    const { expression, form } = found;
    const start = sf.getLineAndCharacterOfPosition(expression.getStart(sf));
    const end = sf.getLineAndCharacterOfPosition(expression.getEnd());
    const readOnly = READ_ONLY[form];
    return {
      from,
      to,
      prop: (prop.name as ts.Identifier | ts.StringLiteral).text,
      form,
      editable: readOnly === undefined,
      ...(readOnly ? { reason: readOnly } : {}),
      ...(found.index !== undefined ? { index: found.index } : {}),
      text: expression.getText(sf),
      span: { file: node.span.file, start: { line: start.line + 1, col: start.character + 1 }, end: { line: end.line + 1, col: end.character + 1 } },
    };
  }

  /** The `new` (or call) a Node's facts point at. */
  private newAt(sf: ts.SourceFile, f: NodeFacts): ts.NewExpression | undefined {
    let found: ts.NewExpression | undefined;
    const visit = (n: ts.Node) => {
      if (ts.isNewExpression(n)) {
        const { line, character } = sf.getLineAndCharacterOfPosition(n.getStart(sf));
        if (line + 1 === f.span.start.line && character + 1 === f.span.start.col) found = n;
      }
      if (!found) ts.forEachChild(n, visit);
    };
    visit(sf);
    return found;
  }

  /**
   * The path of the Node a span key names, as seen from `from`. A span many paths share (a Stack class created
   * more than once) is read as the one beside `from`; with no one nearest, it names nothing.
   */
  pathFor(target: string, from: string): string | undefined {
    const paths = this.bySpan.get(target);
    if (!paths) return undefined;
    if (paths.length === 1) return paths[0];
    const near = paths.filter((p) => parentPath(p) === parentPath(from));
    return near.length === 1 ? near[0] : undefined;
  }

  /** What one prop of the props object names: a shorthand, or a value read for the Nodes in it. */
  private inProp(p: ts.ObjectLiteralElementLike): Found[] {
    if (ts.isShorthandPropertyAssignment(p)) {
      const target = this.valueOf(p.name, 0);
      return target ? [{ target, form: 'shorthand', expression: p.name }] : [];
    }
    if (!ts.isPropertyAssignment(p) || !(ts.isIdentifier(p.name) || ts.isStringLiteral(p.name))) return [];
    const value = bare(p.initializer);
    if (ts.isArrayLiteralExpression(value)) return value.elements.flatMap((e, index) => (ts.isSpreadElement(e) ? [] : this.inExpression(e).map((f) => ({ ...f, index }))));
    return this.inExpression(value);
  }

  /** The Nodes an expression names, and how. */
  private inExpression(raw: ts.Expression): Found[] {
    const e = bare(raw);
    const direct = this.valueOf(e, 0);
    if (direct) return [{ target: direct, form: formOf(e, this.isAlias(e)), expression: e }];
    if (ts.isPropertyAccessExpression(e) || ts.isElementAccessExpression(e)) {
      const base = this.inExpression(e.expression);
      return base.length > 0 ? [{ ...base[0]!, form: 'accessor', expression: e }] : [];
    }
    if (ts.isConditionalExpression(e)) return [...this.inExpression(e.whenTrue), ...this.inExpression(e.whenFalse)].map((f) => ({ ...f, form: 'conditional' as const }));
    if (ts.isCallExpression(e)) return [e.expression, ...e.arguments].flatMap((a) => this.inExpression(a)).map((f) => ({ ...f, form: 'call' as const }));
    return [];
  }

  /** Whether an identifier names its Node through another variable: `const v = vpc`. */
  private isAlias(e: ts.Expression): boolean {
    if (!ts.isIdentifier(e)) return false;
    const init = this.declaredAs(e, e.text);
    return init !== undefined && !ts.isNewExpression(bare(init)) && !ts.isCallExpression(bare(init));
  }

  /** The span key of the Node an identifier, `this.field` or alias stands for. */
  valueOf(e: ts.Expression, depth: number): string | undefined {
    if (depth > MAX_ALIAS_DEPTH) return undefined;
    e = bare(e);
    // A `new` written in the prop itself is the Node, not a Reference to it.
    if (depth > 0 && (ts.isNewExpression(e) || ts.isCallExpression(e))) return this.keyOf(e);
    let init: ts.Expression | undefined;
    if (ts.isIdentifier(e)) init = this.declaredAs(e, e.text);
    else if (ts.isPropertyAccessExpression(e) && e.expression.kind === ts.SyntaxKind.ThisKeyword) init = this.fieldAs(e, e.name.text);
    if (!init) return undefined;
    const value = bare(init);
    return ts.isNewExpression(value) || ts.isCallExpression(value) ? this.keyOf(value) : this.valueOf(value, depth + 1);
  }

  /** The key of a call that makes a Node, if it is one. */
  private keyOf(call: ts.NewExpression | ts.CallExpression): string | undefined {
    const sf = call.getSourceFile();
    const { line, character } = sf.getLineAndCharacterOfPosition(call.getStart(sf));
    const key = spanKey(sf.fileName, line + 1, character + 1);
    return this.bySpan.has(key) ? key : undefined;
  }

  /** What the variable `name` in scope at `at` is initialised with; undefined for a parameter, an import or anything not a `const`/`let`. */
  private declaredAs(at: ts.Node, name: string): ts.Expression | undefined {
    for (let p: ts.Node | undefined = at.parent; p; p = p.parent) {
      if (ts.isFunctionLike(p) && p.parameters.some((param) => ts.isIdentifier(param.name) && param.name.text === name)) return undefined;
      const statements = ts.isBlock(p) || ts.isSourceFile(p) || ts.isModuleBlock(p) ? p.statements : ts.isCaseClause(p) || ts.isDefaultClause(p) ? p.statements : undefined;
      if (!statements) continue;
      for (const s of statements) {
        if (!ts.isVariableStatement(s)) continue;
        const d = s.declarationList.declarations.find((v) => ts.isIdentifier(v.name) && v.name.text === name);
        if (d) return d.initializer;
      }
    }
    return undefined;
  }

  /** What `this.name` is set to in the class around `at`: its initializer, or the first `this.name = …` in its body. */
  private fieldAs(at: ts.Node, name: string): ts.Expression | undefined {
    let cls: ts.Node | undefined = at.parent;
    while (cls && !ts.isClassLike(cls)) cls = cls.parent;
    if (!cls || !ts.isClassLike(cls)) return undefined;
    const declared = cls.members.find((m): m is ts.PropertyDeclaration => ts.isPropertyDeclaration(m) && ts.isIdentifier(m.name) && m.name.text === name && m.initializer !== undefined);
    if (declared) return declared.initializer;
    let found: ts.Expression | undefined;
    const visit = (n: ts.Node) => {
      if (found) return;
      if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isPropertyAccessExpression(n.left) && n.left.expression.kind === ts.SyntaxKind.ThisKeyword && n.left.name.text === name) found = n.right;
      else ts.forEachChild(n, visit);
    };
    visit(cls);
    return found;
  }
}

function formOf(e: ts.Expression, alias: boolean): ReferenceForm {
  if (alias) return 'alias';
  return ts.isPropertyAccessExpression(e) ? 'field' : 'identifier';
}
