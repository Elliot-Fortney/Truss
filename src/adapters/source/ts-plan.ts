// Turns intents into text changes in the file's own style (ADR 0007). It edits the text and leaves everything else alone.
import ts from '@typescript/typescript6';
import { applyChanges, offsetOf, type TextChange } from '../../core/diff.ts';
import type { CallFacts, Facts, NodeFacts, ReferenceFacts } from '../../core/facts.ts';
import { constructIdProblem, parentPath } from '../../core/construct-id.ts';
import { nodeEditability } from '../../core/editability.ts';
import {
  isConnectionIntent,
  isReferenceIntent,
  onBase,
  sameCall,
  type AddNodeIntent,
  type AddedProp,
  type CallPlan,
  type CallRef,
  type ConnectionIntent,
  type DuplicateIntent,
  type Intent,
  type NodeRef,
  type PropValue,
  type ReferenceIntent,
  type RemoveNodeIntent,
} from '../../core/intents.ts';
import type { FileSet, PlanResult, SourceUse } from '../../core/ports.ts';
import { isStringLike, literalValue, memberOf, quantityOf } from './syntax.ts';
import { languageServiceOver, referencesTo, useAt } from './uses.ts';

const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const CDK_LIB = 'aws-cdk-lib';

/** An intent Source can't place. Thrown inside the planner and turned into a refusal at its edge. */
class Refusal extends Error {
  constructor(
    readonly intent: number,
    reason: string,
    readonly uses?: SourceUse[],
  ) {
    super(reason);
  }
}

/** The value to set at a path of props, the props to set inside one, or the Nodes a prop is to point at. */
type Assign =
  | { leaf: PropValue; intent: number }
  | { fields: Map<string, Assign>; intent: number }
  | { refs: RefEdit; intent: number };

function assign(into: Map<string, Assign>, prop: readonly string[], value: PropValue, intent: number): void {
  const [name, ...rest] = prop;
  if (name === undefined) return;
  const there = into.get(name);
  if (rest.length === 0) return void into.set(name, { leaf: value, intent });
  // A later edit of a field replaces an earlier edit of the whole prop.
  const fields = there && 'fields' in there ? there.fields : new Map<string, Assign>();
  into.set(name, { fields, intent });
  assign(fields, rest, value, intent);
}

interface Target {
  file: string;
  facts: NodeFacts;
  assigns: Map<string, Assign>;
  /** The Construct ID to write in place of the one in the code, and the intent that asks for it. */
  rename?: { id: string; intent: number };
  /** The first intent that edits this construct, which a refusal is blamed on. */
  intent: number;
  /** The Reference edits to its props, by prop, in the order they were made. */
  refs: Map<string, { many: boolean; ops: RefOp[]; intent: number; from: string }>;
  /** What the source said about the whole app, which a Reference is written against. */
  world: Facts;
}

/** Everything the planner learns about one file, and the changes it has made to it so far. */
class FileEdit {
  readonly changes: TextChange[] = [];
  /** Where the statements this plan deletes or rewrites start, so that none is dealt with twice. */
  readonly removed = new Set<number>();
  readonly newline: string;
  readonly quote: string;
  private identifiers: Set<string> | undefined;
  private readonly namedAdds = new Map<ts.ImportDeclaration, string[]>();
  /** The imports this plan adds, by module: one line each, however many of its names are used. */
  private readonly newImports = new Map<string, { named: string[] } | { alias: string }>();
  private readonly refs = new Map<string, string>();
  /** Statements that move to follow another, each with the statement it goes after. */
  private readonly moves = new Map<ts.Statement, { after: ts.Statement; note: string }>();

  constructor(
    readonly file: string,
    readonly text: string,
    readonly sf: ts.SourceFile,
  ) {
    this.newline = text.includes('\r\n') ? '\r\n' : '\n';
    this.quote = quoteStyle(sf);
  }

  change(start: number, end: number, text: string, purpose?: TextChange['purpose']): void {
    this.changes.push({ start, end, text, ...(purpose ? { purpose } : {}) });
  }

  /** Moves `statement` to follow `after`, or further down if it was already to move below a statement past that one. */
  moveBelow(statement: ts.Statement, after: ts.Statement, note: string): void {
    const there = this.moves.get(statement);
    // The note says where it ends up, so it follows the statement it moves below.
    if (!there || there.after.getEnd() < after.getEnd()) this.moves.set(statement, { after, note });
  }

  /** Turns each move into the deletion of the statement and its insertion, with the edits made inside it carried along. */
  private finishMoves(): void {
    for (const [statement, { after, note }] of this.moves) {
      const r = removalRange(this, statement);
      const inside = this.changes.filter((c) => c.start >= r.start && c.end <= r.end);
      for (const c of inside) this.changes.splice(this.changes.indexOf(c), 1);
      let text = this.text.slice(r.start, r.end);
      for (const c of inside.sort((a, b) => b.start - a.start))
        text = text.slice(0, c.start - r.start) + c.text + text.slice(c.end - r.start);
      const body = text.replace(/^[ \t]+/, '').replace(/(\r?\n)+[ \t]*$/, '');
      this.changes.push({ start: r.start, end: r.end, text: '', purpose: 'move', note });
      const end = after.getEnd();
      const at = ts.getTrailingCommentRanges(this.text, end)?.at(-1)?.end ?? end;
      this.change(at, at, `${this.newline}${this.indentOf(after)}${body}`, 'move');
    }
  }

  /** The text after the changes so far, with imports. */
  finish(): TextChange[] {
    this.finishMoves();
    for (const [decl, names] of this.namedAdds) {
      const elements = (decl.importClause!.namedBindings as ts.NamedImports).elements;
      const last = elements[elements.length - 1]!;
      const between = this.text.slice(
        (decl.importClause!.namedBindings as ts.NamedImports).getStart(this.sf),
        last.getStart(this.sf),
      );
      const separator = between.includes('\n') ? `,${this.newline}${this.indentOf(last)}` : ', ';
      this.changes.push({
        start: last.getEnd(),
        end: last.getEnd(),
        text: names.map((n) => separator + n).join(''),
        purpose: 'import',
      });
    }
    if (this.newImports.size > 0) {
      const imports = this.sf.statements.filter(ts.isImportDeclaration);
      const lastImport = imports.at(-1);
      const at = lastImport ? lastImport.getEnd() : 0;
      const quoted = (m: string) => `${this.importQuote()}${m}${this.importQuote()}`;
      const semi = this.importSemicolon();
      const lines = [...this.newImports]
        .map(([module, i]) =>
          'alias' in i
            ? `import * as ${i.alias} from ${quoted(module)}${semi}`
            : `import { ${i.named.join(', ')} } from ${quoted(module)}${semi}`,
        )
        .join(this.newline);
      this.changes.push({
        start: at,
        end: at,
        text: lastImport ? this.newline + lines : lines + this.newline,
        purpose: 'import',
      });
    }
    return this.changes.sort((a, b) => a.start - b.start);
  }

  indentOf(n: ts.Node): string {
    const start = n.getStart(this.sf);
    const lineStart = this.text.lastIndexOf('\n', start - 1) + 1;
    return /^[ \t]*/.exec(this.text.slice(lineStart))![0];
  }

  /** Keeps `name` from being given to anything else in this plan. */
  claim(name: string): void {
    this.used(name);
    this.identifiers!.add(name);
  }

  /** Whether the file already has an identifier called `name`, or this plan has given it to something. */
  used(name: string): boolean {
    if (!this.identifiers) {
      this.identifiers = new Set();
      const visit = (n: ts.Node) => {
        if (ts.isIdentifier(n)) this.identifiers!.add(n.text);
        ts.forEachChild(n, visit);
      };
      visit(this.sf);
    }
    return this.identifiers.has(name);
  }

  /**
   * How the file refers to `type` of `module`: through an alias it already imports the module as, or
   * by a name it already imports, or one it adds to its own imports in the same style.
   */
  ref(intent: number, module: string, type: string, alias: string): string {
    const cached = this.refs.get(`${module}:${type}`);
    if (cached) return cached;
    const found = this.findRef(module, type);
    if (found) {
      this.refs.set(`${module}:${type}`, found);
      return found;
    }
    // Named when the module is the root or the file's imports of CDK modules are named; a namespace import otherwise.
    const named = module === CDK_LIB || this.namedStyle();
    const added = this.newImports.get(module);
    // One import per module: a second name of it joins the line, or reuses the namespace, this plan already added.
    const bound = named ? type : added && 'alias' in added ? added.alias : alias;
    if (this.used(bound) && !(added && 'alias' in added))
      throw new Refusal(
        intent,
        `The file already uses the name ${bound} for something else, so ${type} can't be imported as it`,
      );
    if (named) {
      if (added && 'named' in added) added.named.push(type);
      else this.newImports.set(module, { named: [type] });
    } else if (!added) this.newImports.set(module, { alias });
    const result = named ? type : `${bound}.${type}`;
    this.refs.set(`${module}:${type}`, result);
    return result;
  }

  private findRef(module: string, type: string): string | undefined {
    for (const s of this.sf.statements) {
      if (
        ts.isImportEqualsDeclaration(s) &&
        ts.isExternalModuleReference(s.moduleReference) &&
        ts.isStringLiteral(s.moduleReference.expression) &&
        s.moduleReference.expression.text === module
      ) {
        return `${s.name.text}.${type}`;
      }
      if (!ts.isImportDeclaration(s) || !ts.isStringLiteral(s.moduleSpecifier) || s.moduleSpecifier.text !== module)
        continue;
      const clause = s.importClause;
      if (!clause || clause.isTypeOnly) continue;
      const bindings = clause.namedBindings;
      if (bindings && ts.isNamespaceImport(bindings)) return `${bindings.name.text}.${type}`;
      if (clause.name && !bindings) return `${clause.name.text}.${type}`;
      if (bindings && ts.isNamedImports(bindings)) {
        const el = bindings.elements.find((e) => !e.isTypeOnly && (e.propertyName ?? e.name).text === type);
        if (el) return el.name.text;
      }
    }
    // A value import of the module's names: the type joins it.
    for (const s of this.sf.statements) {
      if (!ts.isImportDeclaration(s) || !ts.isStringLiteral(s.moduleSpecifier) || s.moduleSpecifier.text !== module)
        continue;
      const bindings = s.importClause?.namedBindings;
      if (
        s.importClause &&
        !s.importClause.isTypeOnly &&
        bindings &&
        ts.isNamedImports(bindings) &&
        bindings.elements.length > 0
      ) {
        if (this.used(type)) return undefined;
        this.namedAdds.set(s, [...(this.namedAdds.get(s) ?? []), type]);
        return type;
      }
    }
    return undefined;
  }

  private cdkImports(): ts.ImportDeclaration[] {
    return this.sf.statements.filter(
      (s): s is ts.ImportDeclaration =>
        ts.isImportDeclaration(s) &&
        ts.isStringLiteral(s.moduleSpecifier) &&
        s.moduleSpecifier.text.startsWith(`${CDK_LIB}/`),
    );
  }

  /** The file imports CDK modules by name, and none as a namespace. */
  private namedStyle(): boolean {
    const imports = this.cdkImports();
    return (
      imports.length > 0 &&
      imports.every(
        (s) => s.importClause?.namedBindings !== undefined && ts.isNamedImports(s.importClause.namedBindings),
      )
    );
  }

  private importQuote(): string {
    const first = this.sf.statements.find(ts.isImportDeclaration);
    return first && ts.isStringLiteral(first.moduleSpecifier) ? first.moduleSpecifier.getText(this.sf)[0]! : this.quote;
  }

  private importSemicolon(): string {
    const last = this.sf.statements.filter(ts.isImportDeclaration).at(-1);
    return !last || last.getText(this.sf).endsWith(';') ? ';' : '';
  }
}

/** The quote the file uses for most of its strings; a single quote when it is a tie. */
function quoteStyle(sf: ts.SourceFile): string {
  let single = 0;
  let double = 0;
  const visit = (n: ts.Node) => {
    if (ts.isStringLiteral(n)) n.getText(sf).startsWith('"') ? double++ : single++;
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return double > single ? '"' : "'";
}

function quoted(value: string, quote: string): string {
  const escaped = value
    .replace(/\\/g, '\\\\')
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029')
    .split(quote)
    .join('\\' + quote);
  return quote + (quote === '`' ? escaped.replace(/\$\{/g, '\\${') : escaped) + quote;
}

/** Where an enum or construct class of `aws-cdk-lib` is imported from, and what its namespace is called when the file has to import it whole. */
function enumHome(intent: number, fqn: string): { module: string; type: string; alias: string } {
  const parts = fqn.split('.');
  const type = parts.at(-1)!;
  const namespace = parts.length === 3 ? parts[1]! : undefined;
  if (parts[0] !== CDK_LIB || parts.length < 2 || parts.length > 3)
    throw new Refusal(intent, `Truss only writes enums and constructs of ${CDK_LIB}, not ${fqn}`);
  if (!namespace) return { module: CDK_LIB, type, alias: 'cdk' };
  const module = `${CDK_LIB}/${(namespace.startsWith('aws_') ? `aws-${namespace.slice(4)}` : namespace).replace(/_/g, '-')}`;
  const alias = namespace.replace(/^aws_/, '').replace(/_(\w)/g, (_, c: string) => c.toUpperCase());
  return { module, type, alias };
}

function emit(edit: FileEdit, intent: number, value: PropValue, existing: ts.Expression | undefined): string {
  switch (value.kind) {
    case 'string': {
      const quote = existing && isStringLike(existing) ? existing.getText(edit.sf)[0]! : edit.quote;
      return quoted(value.value, quote);
    }
    case 'number':
      return Object.is(value.value, -0) ? '0' : String(value.value);
    case 'boolean':
      return String(value.value);
    case 'duration':
    case 'size': {
      const type = value.kind === 'duration' ? 'Duration' : 'Size';
      const call = `${value.unit}(${value.amount})`;
      // Keep how the file already writes the class, whatever it is imported as.
      if (existing && quantityOf(existing)?.type === type)
        return `${((existing as ts.CallExpression).expression as ts.PropertyAccessExpression).expression.getText(edit.sf)}.${call}`;
      return `${edit.ref(intent, CDK_LIB, type, 'cdk')}.${call}`;
    }
    case 'enum': {
      const home = enumHome(intent, value.type);
      if (existing && memberOf(existing)?.type === home.type)
        return `${(existing as ts.PropertyAccessExpression).expression.getText(edit.sf)}.${value.member}`;
      return `${edit.ref(intent, home.module, home.type, home.alias)}.${value.member}`;
    }
  }
}

function render(edit: FileEdit, name: string, a: Assign): string {
  if ('refs' in a) return renderRefs(name, a.refs) ?? '';
  return `${name}: ${'leaf' in a ? emit(edit, a.intent, a.leaf, undefined) : renderObject(edit, a.fields)}`;
}

const renderObject = (edit: FileEdit, fields: Map<string, Assign>): string =>
  `{ ${[...fields]
    .map(([name, a]) => render(edit, name, a))
    .filter((r) => r !== '')
    .join(', ')} }`;

/** What may be replaced by a value from the canvas: a value of the same kind as the ones the canvas writes. */
const isReplaceable = (e: ts.Expression) =>
  literalValue(e) !== undefined || memberOf(e) !== undefined || quantityOf(e) !== undefined;

function propNamed(obj: ts.ObjectLiteralExpression, name: string): ts.ObjectLiteralElementLike | undefined {
  return obj.properties.findLast(
    (p) => p.name !== undefined && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) && p.name.text === name,
  );
}

function editObject(edit: FileEdit, obj: ts.ObjectLiteralExpression, fields: Map<string, Assign>): void {
  const added: string[] = [];
  for (const [name, a] of fields) {
    const existing = propNamed(obj, name);
    if ('refs' in a) {
      const text = editRefs(edit, obj, name, existing, a);
      if (text) added.push(text);
      continue;
    }
    if (!existing) {
      added.push(render(edit, name, a));
      continue;
    }
    if (!ts.isPropertyAssignment(existing))
      throw new Refusal(a.intent, `${name} is not written as \`${name}: value\` in the code`);
    const init = existing.initializer;
    if ('leaf' in a) {
      if (!isReplaceable(init))
        throw new Refusal(
          a.intent,
          `${name} is an expression in the code (${init.getText(edit.sf)}), which Truss leaves alone`,
        );
      const text = emit(edit, a.intent, a.leaf, init);
      if (text !== init.getText(edit.sf)) edit.change(init.getStart(edit.sf), init.getEnd(), text);
    } else {
      if (!ts.isObjectLiteralExpression(init))
        throw new Refusal(
          a.intent,
          `${name} is ${init.getText(edit.sf)} in the code, not an object Truss can edit field by field`,
        );
      editObject(edit, init, a.fields);
    }
  }
  if (added.length > 0) append(edit, obj, added);
}

/** Adds props after the last one (so after any spread, where they win), laid out the way the object is. */
function append(edit: FileEdit, obj: ts.ObjectLiteralExpression | ts.ArrayLiteralExpression, entries: string[]): void {
  const { sf, text, newline } = edit;
  const props: ts.NodeArray<ts.Node> = ts.isObjectLiteralExpression(obj) ? obj.properties : obj.elements;
  const last = props.at(-1);
  const [opening, closing] = ts.isObjectLiteralExpression(obj) ? ['{ ', ' }'] : ['[', ']'];
  if (!last) {
    edit.change(obj.getStart(sf), obj.getEnd(), `${opening}${entries.join(', ')}${closing}`);
    return;
  }
  const open = sf.getLineAndCharacterOfPosition(obj.getStart(sf)).line;
  const multiline = sf.getLineAndCharacterOfPosition(props[0]!.getStart(sf)).line !== open;
  const comma = props.hasTrailingComma
    ? obj
        .getChildren(sf)
        .find((c) => c.kind === ts.SyntaxKind.SyntaxList)!
        .getChildren(sf)
        .at(-1)!
    : undefined;
  const afterLast = comma ? comma.getEnd() : last.getEnd();
  if (!multiline) {
    comma
      ? edit.change(afterLast, afterLast, ` ${entries.join(', ')},`)
      : edit.change(afterLast, afterLast, `, ${entries.join(', ')}`);
    return;
  }
  const indent = edit.indentOf(last);
  // A comment after the last prop stays with it, on its line.
  const anchor = ts.getTrailingCommentRanges(text, afterLast)?.at(-1)?.end ?? afterLast;
  const lines = entries.map((e) => `${newline}${indent}${e}`);
  if (!comma) edit.change(last.getEnd(), last.getEnd(), ',');
  edit.change(anchor, anchor, lines.join(',') + (comma ? ',' : ''));
}

function editNew(edit: FileEdit, target: Target): void {
  const { facts, intent } = target;
  const start = offsetOf(edit.text, facts.span.start.line, facts.span.start.col);
  let found: ts.NewExpression | undefined;
  const visit = (n: ts.Node) => {
    if (ts.isNewExpression(n) && n.getStart(edit.sf) === start) found = n;
    if (!found) ts.forEachChild(n, visit);
  };
  visit(edit.sf);
  const id = found?.arguments?.[1];
  if (
    !found ||
    found.expression.getText(edit.sf) !== facts.className ||
    !id ||
    !isStringLike(id) ||
    id.text !== facts.literalId
  ) {
    throw new Refusal(
      intent,
      `The code at ${facts.span.file}:${facts.span.start.line} is not the \`new ${facts.className}\` Truss read`,
    );
  }
  if (target.rename && target.rename.id !== facts.literalId) {
    const quote = id.getText(edit.sf)[0]!;
    edit.change(id.getStart(edit.sf), id.getEnd(), quoted(target.rename.id, quote));
  }
  const props = found.arguments![2];
  for (const [prop, r] of target.refs)
    target.assigns.set(prop, { refs: refEdit(edit, found, target, prop, r), intent: r.intent });
  if (target.assigns.size === 0) return;
  if (!props) {
    edit.change(id.getEnd(), id.getEnd(), `, ${renderObject(edit, target.assigns)}`);
    return;
  }
  if (!ts.isObjectLiteralExpression(props))
    throw new Refusal(intent, `The props are passed as ${props.getText(edit.sf)}, not written out in the call`);
  editObject(edit, props, target.assigns);
}

// --- Adding and duplicating ---------------------------------------------------------------------------

/** A statement that makes a new construct, with the scope it is made in. */
interface Creation {
  index: number;
  intent: AddNodeIntent | DuplicateIntent;
  /** The Stack the construct goes in, as the code makes it. */
  scopePath: string;
  scope: NodeFacts;
  /** The `new` call that is copied; only for a duplicate. */
  source?: NodeFacts;
}

/** Where a new statement goes, and how it refers to its scope. */
interface Placement {
  edit: FileEdit;
  /** The statement the new one follows. */
  anchor: ts.Statement;
  /** What the scope is called where the statement is written: `this`, or the variable the Stack is bound to. */
  scopeArg: string;
  /** The class whose constructor the statement goes in, and whether the constructs in it are kept in fields. */
  cls?: ts.ClassDeclaration;
  fields: boolean;
}

const RESERVED = new Set(
  'break case catch class const continue debugger default delete do else enum export extends false finally for function if import in instanceof new null return super switch this throw true try typeof var void while with yield let static implements interface package private protected public await async of type'.split(
    ' ',
  ),
);

/** The name a construct with Construct ID `id` is bound to: the ID with a lowercase first letter, made a valid identifier that nothing in the file uses. */
function bindingFor(edit: FileEdit, id: string): string {
  let base = id.replace(/[^A-Za-z0-9_$]/g, '');
  base = base.charAt(0).toLowerCase() + base.slice(1);
  if (!IDENTIFIER.test(base)) base = `node${base.charAt(0).toUpperCase()}${base.slice(1)}`;
  if (RESERVED.has(base)) base += 'Node';
  let name = base;
  for (let n = 2; edit.used(name); n++) name = `${base}${n}`;
  edit.claim(name);
  return name;
}

const newAt = (edit: FileEdit, f: NodeFacts): ts.NewExpression | undefined => {
  const start = offsetOf(edit.text, f.span.start.line, f.span.start.col);
  let found: ts.NewExpression | undefined;
  const visit = (n: ts.Node) => {
    if (ts.isNewExpression(n) && n.getStart(edit.sf) === start) found = n;
    if (!found) ts.forEachChild(n, visit);
  };
  visit(edit.sf);
  return found;
};

/** The statement of `body` that holds `n`. */
function statementIn(n: ts.Node, body: ts.Node): ts.Statement | undefined {
  for (let at: ts.Node | undefined = n; at?.parent; at = at.parent)
    if (at.parent === body && ts.isStatement(at)) return at;
  return undefined;
}

const mentions = (s: ts.Node, name: string): boolean => {
  let hit = false;
  const visit = (n: ts.Node) => {
    if (ts.isIdentifier(n) && n.text === name) hit = true;
    if (!hit) ts.forEachChild(n, visit);
  };
  visit(s);
  return hit;
};

/**
 * Where the statement for a new construct in `scope` goes: after the last editable sibling's statement, or
 * at the end of the constructor, for a Stack class; after the last use of the variable, for a Stack made inline in `bin/`.
 */
function place(
  c: Creation,
  facts: Facts,
  edits: (file: string, intent: number) => FileEdit,
  files: FileSet,
  parse: (file: string) => ts.SourceFile | undefined,
): Placement {
  const { scope, scopePath, index } = c;
  const className = scope.className.split('.').at(-1)!;
  let cls: { edit: FileEdit; decl: ts.ClassDeclaration } | undefined;
  for (const file of files.keys()) {
    const sf = parse(file);
    const decl = sf?.statements.find(
      (st): st is ts.ClassDeclaration => ts.isClassDeclaration(st) && st.name?.text === className,
    );
    if (decl) {
      cls = { edit: edits(file, index), decl };
      break;
    }
  }
  if (cls) {
    const ctor = cls.decl.members.find(ts.isConstructorDeclaration);
    if (!ctor?.body || ctor.body.statements.length === 0)
      throw new Refusal(index, `${className} has no constructor body to add the construct to`);
    const siblings = Object.entries(facts.nodes).filter(([path, f]) => parentPath(path) === scopePath && !f.external);
    let anchor = ctor.body.statements.at(-1)!;
    let end = -1;
    for (const [path, f] of siblings) {
      if (f.span.file !== cls.edit.file || !nodeEditability(path, f).editable) continue;
      const found = newAt(cls.edit, f);
      const st = found && statementIn(found, ctor.body);
      if (st && st.getEnd() > end) {
        anchor = st;
        end = st.getEnd();
      }
    }
    return {
      edit: cls.edit,
      anchor,
      scopeArg: 'this',
      cls: cls.decl,
      fields: siblings.some(([, f]) => f.binding === 'field'),
    };
  }
  if (scope.surround)
    throw new Refusal(
      index,
      `${scopePath} is made in a ${scope.surround.kind === 'loop' ? 'loop' : `helper, ${scope.surround.name}`}, so Truss can't tell where to add to it`,
    );
  const edit = edits(scope.span.file, index);
  const made = newAt(edit, scope);
  let decl: ts.Node | undefined = made;
  while (decl && !ts.isVariableDeclaration(decl)) decl = decl.parent;
  const statement = decl?.parent?.parent;
  if (
    !decl ||
    !ts.isVariableDeclaration(decl) ||
    !ts.isIdentifier(decl.name) ||
    !statement ||
    !ts.isVariableStatement(statement) ||
    !(ts.isSourceFile(statement.parent) || ts.isBlock(statement.parent))
  ) {
    throw new Refusal(index, `${scopePath} isn't kept in a variable, so there is nothing to add the construct to`);
  }
  const list = statement.parent.statements;
  const name = decl.name.text;
  const after = list.slice(list.indexOf(statement));
  const anchor = after.findLast((st) => mentions(st, name)) ?? statement;
  return { edit, anchor, scopeArg: name, fields: false };
}

/** `code` with the classes it names (`uses`, by FQN) imported the way the file imports, and written as the file refers to them. */
function importing(edit: FileEdit, index: number, code: string, uses: readonly string[] | undefined): string {
  for (const fqn of uses ?? []) {
    const home = enumHome(index, fqn);
    const ref = edit.ref(index, home.module, home.type, home.alias);
    if (ref !== home.type) code = code.replace(new RegExp(`(?<![\\w$.'"])${home.type}\\b`, 'g'), ref);
  }
  return code;
}

/** The code of the added construct's props, as the object literal it goes in; empty when it has none. */
function addedProps(edit: FileEdit, index: number, props: readonly AddedProp[]): string {
  const parts = props.map((p) => {
    if (!IDENTIFIER.test(p.name)) throw new Refusal(index, `${p.name} is not a prop name`);
    if ('value' in p) return render(edit, p.name, { leaf: p.value, intent: index });
    return `${p.name}: ${importing(edit, index, p.snippet.code, p.snippet.uses)}`;
  });
  return parts.length > 0 ? `, { ${parts.join(', ')} }` : '';
}

/** The quote the statement uses for its first string, which is the file's own style where the statement goes; else the quote the file mostly uses. */
function quoteNear(edit: FileEdit, statement: ts.Node): string {
  let first: ts.StringLiteral | undefined;
  const visit = (n: ts.Node) => {
    if (ts.isStringLiteral(n) && !first) first = n;
    if (!first) ts.forEachChild(n, visit);
  };
  visit(statement);
  return first ? first.getText(edit.sf)[0]! : edit.quote;
}

/** Inserts `text` on a new line after `anchor`, keeping a comment that trails the anchor with it. */
function insertAfter(edit: FileEdit, anchor: ts.Node, text: string): void {
  const end = anchor.getEnd();
  const at = ts.getTrailingCommentRanges(edit.text, end)?.at(-1)?.end ?? end;
  edit.change(at, at, `${edit.newline}${edit.indentOf(anchor)}${text}`, 'add');
}

/** Declares the field `name` of type `type` in `cls`, in the way its other fields are declared. */
function declareField(edit: FileEdit, cls: ts.ClassDeclaration, name: string, type: string): void {
  const properties = cls.members.filter(ts.isPropertyDeclaration);
  const modifiers =
    properties
      .at(-1)
      ?.modifiers?.map((m) => m.getText(edit.sf))
      .join(' ') ?? 'readonly';
  const declaration = `${modifiers ? modifiers + ' ' : ''}${name}: ${type};`;
  const last = properties.at(-1);
  if (last) {
    insertAfter(edit, last, declaration);
    return;
  }
  const ctor = cls.members.find(ts.isConstructorDeclaration)!;
  const at = ctor.getStart(edit.sf);
  edit.change(at, at, `${declaration}${edit.newline}${edit.newline}${edit.indentOf(ctor)}`, 'add');
}

function create(
  c: Creation,
  facts: Facts,
  edits: (file: string, intent: number) => FileEdit,
  files: FileSet,
  parse: (file: string) => ts.SourceFile | undefined,
): void {
  const { intent, index } = c;
  const placed = place(c, facts, edits, files, parse);
  const { edit, anchor } = placed;
  const semicolon = anchor.getText(edit.sf).endsWith(';') ? ';' : '';
  if (intent.type === 'addNode') {
    const problem = constructIdProblem(intent.id, []);
    if (problem) throw new Refusal(index, problem);
    const home = enumHome(index, intent.fqn);
    const type = edit.ref(index, home.module, home.type, home.alias);
    const name = bindingFor(edit, intent.id);
    const made = `new ${type}(${placed.scopeArg}, ${quoted(intent.id, quoteNear(edit, anchor))}${addedProps(edit, index, intent.props)})`;
    if (placed.fields && placed.cls) {
      declareField(edit, placed.cls, name, type);
      insertAfter(edit, anchor, `this.${name} = ${made}${semicolon}`);
      return;
    }
    insertAfter(edit, anchor, `const ${name} = ${made}${semicolon}`);
    return;
  }
  copy(c as Creation & { intent: DuplicateIntent; source: NodeFacts }, placed, semicolon);
}

/** Writes a copy of the statement that makes the construct, with the ID and the name it is bound to changed. */
function copy(
  c: Creation & { intent: DuplicateIntent; source: NodeFacts },
  placed: Placement,
  semicolon: string,
): void {
  const { intent, index, source } = c;
  const { edit } = placed;
  const problem = constructIdProblem(intent.newId, []);
  if (problem) throw new Refusal(index, problem);
  if (edit.file !== source.span.file)
    throw new Refusal(index, `${intent.path} is in ${source.span.file}, not in the file the copy goes in`);
  const found = newAt(edit, source);
  const id = found?.arguments?.[1];
  if (!found || !id || !isStringLike(id))
    throw new Refusal(index, `The code at ${source.span.file}:${source.span.start.line} is not the \`new\` Truss read`);
  let statement: ts.Node | undefined = found;
  while (statement && !ts.isStatement(statement)) statement = statement.parent;
  if (!statement || !ts.isStatement(statement))
    throw new Refusal(index, `${intent.path} isn't made by a statement of its own, so it can't be copied`);
  const replacements: { start: number; end: number; text: string }[] = [
    { start: id.getStart(edit.sf), end: id.getEnd(), text: quoted(intent.newId, id.getText(edit.sf)[0]!) },
  ];
  let declared: { old: string; name: string } | undefined;
  if (ts.isVariableStatement(statement)) {
    const [only, ...more] = statement.declarationList.declarations;
    if (!only || more.length > 0 || !ts.isIdentifier(only.name) || only.initializer !== found)
      throw new Refusal(index, `${intent.path} is made in a statement Truss can't copy`);
    const name = bindingFor(edit, intent.newId);
    replacements.push({ start: only.name.getStart(edit.sf), end: only.name.getEnd(), text: name });
  } else if (ts.isExpressionStatement(statement)) {
    const e = statement.expression;
    if (
      ts.isBinaryExpression(e) &&
      e.right === found &&
      ts.isPropertyAccessExpression(e.left) &&
      e.left.expression.kind === ts.SyntaxKind.ThisKeyword
    ) {
      const name = bindingFor(edit, intent.newId);
      replacements.push({ start: e.left.name.getStart(edit.sf), end: e.left.name.getEnd(), text: name });
      declared = { old: e.left.name.text, name };
    } else if (e !== found) throw new Refusal(index, `${intent.path} is made in a statement Truss can't copy`);
  } else throw new Refusal(index, `${intent.path} is made in a statement Truss can't copy`);

  const from = statement.getStart(edit.sf);
  let text = edit.text.slice(from, statement.getEnd());
  for (const r of replacements.sort((a, b) => b.start - a.start))
    text = text.slice(0, r.start - from) + r.text + text.slice(r.end - from);
  if (!semicolon && text.endsWith(';')) text = text.slice(0, -1);
  if (declared && placed.cls) {
    const property = placed.cls.members.find(
      (m): m is ts.PropertyDeclaration =>
        ts.isPropertyDeclaration(m) && ts.isIdentifier(m.name) && m.name.text === declared.old,
    );
    if (property) {
      const start = property.getStart(edit.sf);
      const name = property.name.getStart(edit.sf) - start;
      insertAfter(
        edit,
        property,
        edit.text.slice(start, property.getEnd()).slice(0, name) +
          declared.name +
          edit.text.slice(property.name.getEnd(), property.getEnd()),
      );
    }
  }
  insertAfter(edit, placed.anchor, text);
}

// --- Removing -----------------------------------------------------------------------------------------

/** A statement that is deleted. */
interface Removal {
  index: number;
  intent: RemoveNodeIntent;
  facts: NodeFacts;
}

const LINE_END = /^[ \t]*(\r?\n|$)/;

/**
 * The text of `node` that goes when it is deleted: its comments directly above it (not one set apart by a blank line)
 * and trailing it on its last line, and its line breaks when it has the lines to itself. A blank line left doubled, or at the top of a block, is dropped.
 */
function removalRange(edit: FileEdit, node: ts.Node): { start: number; end: number } {
  const { text } = edit;
  const lineStartOf = (at: number) => text.lastIndexOf('\n', at - 1) + 1;
  const alone = (at: number) => /^[ \t]*$/.test(text.slice(lineStartOf(at), at));
  let start = node.getStart(edit.sf);
  for (const c of (ts.getLeadingCommentRanges(text, node.pos) ?? []).reverse()) {
    if (!alone(c.pos) || (text.slice(c.end, start).match(/\n/g)?.length ?? 0) > 1) break;
    start = c.pos;
  }
  let end = node.getEnd();
  for (const c of ts.getTrailingCommentRanges(text, end) ?? []) end = c.end;
  const wholeLines = alone(start) && LINE_END.test(text.slice(end));
  if (!wholeLines) return { start, end };
  start = lineStartOf(start);
  end += LINE_END.exec(text.slice(end))![0].length;
  if (/(\n[ \t]*\r?\n|\{[ \t]*\r?\n)$/.test(text.slice(0, start)) || start === 0)
    end += /^[ \t]*\r?\n/.exec(text.slice(end))?.[0].length ?? 0;
  return { start, end };
}

/** Deletes the statement that makes a construct, and the field it is kept in, unless code other than that still uses it. */
function removeNode(
  r: Removal,
  edits: (file: string, intent: number) => FileEdit,
  files: FileSet,
  service: ts.LanguageService,
  world: Facts,
): void {
  const { index, intent, facts } = r;
  const edit = edits(facts.span.file, index);
  const found = newAt(edit, facts);
  let statement: ts.Node | undefined = found;
  while (statement && !ts.isStatement(statement)) statement = statement.parent;
  if (!found || !statement || !ts.isStatement(statement))
    throw new Refusal(index, `The code at ${facts.span.file}:${facts.span.start.line} is not the \`new\` Truss read`);
  // What the construct is called in the code: a variable, or a field of the class.
  let name: ts.Node | undefined;
  let property: ts.PropertyDeclaration | undefined;
  if (ts.isVariableStatement(statement)) {
    const [only, ...more] = statement.declarationList.declarations;
    if (!only || more.length > 0 || !ts.isIdentifier(only.name) || only.initializer !== found)
      throw new Refusal(index, `${intent.path} is made in a statement Truss can't remove`);
    name = only.name;
  } else if (ts.isExpressionStatement(statement)) {
    const e = statement.expression;
    if (
      ts.isBinaryExpression(e) &&
      e.right === found &&
      ts.isPropertyAccessExpression(e.left) &&
      e.left.expression.kind === ts.SyntaxKind.ThisKeyword
    ) {
      name = e.left.name;
      let cls: ts.Node | undefined = statement;
      while (cls && !ts.isClassLike(cls)) cls = cls.parent;
      property =
        cls && ts.isClassLike(cls)
          ? cls.members.find(
              (m): m is ts.PropertyDeclaration =>
                ts.isPropertyDeclaration(m) && ts.isIdentifier(m.name) && m.name.text === (name as ts.Identifier).text,
            )
          : undefined;
    } else if (e !== found) throw new Refusal(index, `${intent.path} is made in a statement Truss can't remove`);
  } else throw new Refusal(index, `${intent.path} isn't made by a statement of its own, so it can't be removed`);

  // The calls that connect it to other Nodes go with it.
  const calls = (world.calls ?? []).filter((c) => c.editable && (c.on === intent.path || c.peer === intent.path));
  const gone = [
    removalRange(edit, statement),
    ...(property ? [removalRange(edit, property)] : []),
    ...callRanges(edit, calls, index),
  ];
  if (name) {
    const at = (property?.name ?? name).getStart(edit.sf);
    const uses = referencesTo(service, edit.file, at).filter(
      (u) => u.file !== edit.file || !gone.some((g) => u.start >= g.start && u.end <= g.end),
    );
    if (uses.length > 0) {
      const places = uses
        .sort((a, b) => a.file.localeCompare(b.file) || a.start - b.start)
        .map((u) => useAt(files, u.file, u.start));
      throw new Refusal(
        index,
        `${intent.expect.literalId} is still used in ${places.length === 1 ? 'one place' : `${places.length} places`}: ${places.map((p) => `${p.file}:${p.line}`).join(', ')}`,
        places,
      );
    }
  }
  deleteCalls(edit, calls, index);
  for (const g of gone.slice(0, property ? 2 : 1)) edit.change(g.start, g.end, '', 'remove');
}

// --- References ---------------------------------------------------------------------------------------

/** One change to the Nodes a prop points at, in the order the Draft made them. */
type RefOp =
  | { kind: 'add'; to: NodeRef; intent: number }
  | { kind: 'remove'; to: NodeRef; intent: number }
  | { kind: 'repoint'; was: NodeRef; to: NodeRef; intent: number };

/** What the Draft does to one prop that points at Nodes, and how to write a Node there. */
interface RefEdit {
  many: boolean;
  ops: RefOp[];
  /** How the code names `to` where the Reference is written; moves the source statement below it when that is needed and safe. */
  write(to: NodeRef, intent: number): string;
  /** The Nodes the prop points at now, by position. */
  existing: ReferenceFacts[];
  intent: number;
}

/** An entry of a prop that points at Nodes: one the code has, or one the Draft adds. */
interface RefEntry {
  target: string;
  /** The code of a Reference the Draft writes; absent for one that stays as it is. */
  text?: string;
  /** The element of the code it was; absent for one the Draft adds. */
  at?: number;
  removed?: true;
}

const refOpOf = (intent: ReferenceIntent, index: number): RefOp =>
  intent.type === 'addReference'
    ? { kind: 'add', to: intent.to, intent: index }
    : intent.type === 'removeReference'
      ? { kind: 'remove', to: intent.to, intent: index }
      : { kind: 'repoint', was: intent.was, to: intent.to, intent: index };

/** Applies the Draft's changes to what a prop points at now, and says where each Node ends up. */
function settle(r: RefEdit, prop: string): RefEntry[] {
  const entries: RefEntry[] = r.existing.map((e, i) => ({ target: e.to, at: i }));
  const live = () => entries.filter((e) => !e.removed);
  const named = (n: NodeRef) => n.literalId || n.path;
  for (const op of r.ops) {
    if (op.kind === 'add') {
      if (live().some((e) => e.target === op.to.path))
        throw new Refusal(op.intent, `${prop} already points at ${named(op.to)}`);
      if (!r.many && live().length > 0)
        throw new Refusal(op.intent, `${prop} already points at another Node, and takes one`);
      entries.push({ target: op.to.path, text: r.write(op.to, op.intent) });
      continue;
    }
    const gone = op.kind === 'remove' ? op.to : op.was;
    const entry = live().find((e) => e.target === gone.path);
    if (!entry) throw new Refusal(op.intent, `${prop} doesn't point at ${named(gone)} in the code`);
    if (op.kind === 'remove') entry.removed = true;
    else {
      if (live().some((e) => e.target === op.to.path))
        throw new Refusal(op.intent, `${prop} already points at ${named(op.to)}`);
      entry.target = op.to.path;
      entry.text = r.write(op.to, op.intent);
    }
  }
  return entries;
}

/** The prop as it is written when the code doesn't have it yet; undefined when it comes to nothing. */
function renderRefs(name: string, r: RefEdit): string | undefined {
  const texts = settle(r, name).flatMap((e) => (e.removed || e.text === undefined ? [] : [e.text]));
  if (texts.length === 0) return undefined;
  if (r.many) return `${name}: [${texts.join(', ')}]`;
  return texts[0] === name ? name : `${name}: ${texts[0]}`;
}

/**
 * Deletes `items[indices]` from a list, with the commas around them. A run that ends before the last item goes up to the
 * next item; one that includes the last goes from the end of the item before it. All of them go: the list is left empty.
 */
function removeItems(
  edit: FileEdit,
  container: ts.ObjectLiteralExpression | ts.ArrayLiteralExpression,
  indices: readonly number[],
): void {
  const { sf } = edit;
  const items: ts.NodeArray<ts.Node> = ts.isObjectLiteralExpression(container)
    ? container.properties
    : container.elements;
  const gone = new Set(indices);
  if (gone.size === items.length) {
    edit.change(container.getStart(sf) + 1, container.getEnd() - 1, '');
    return;
  }
  for (let i = 0; i < items.length; i++) {
    if (!gone.has(i) || gone.has(i - 1)) continue;
    let j = i;
    while (gone.has(j + 1)) j++;
    if (j < items.length - 1) edit.change(items[i]!.getStart(sf), items[j + 1]!.getStart(sf), '');
    else edit.change(items[i - 1]!.getEnd(), items[j]!.getEnd(), '');
  }
}

/** Edits the code of one prop that points at Nodes. Returns the prop to add to the object when the code doesn't have it. */
function editRefs(
  edit: FileEdit,
  obj: ts.ObjectLiteralExpression,
  name: string,
  existing: ts.ObjectLiteralElementLike | undefined,
  a: { refs: RefEdit; intent: number },
): string | undefined {
  const r = a.refs;
  if (!existing) return renderRefs(name, r);
  const entries = settle(r, name);
  const at = obj.properties.indexOf(existing);
  const live = entries.filter((e) => !e.removed);
  if (!r.many) {
    const entry = entries[0];
    if (!entry || entry.removed) {
      removeItems(edit, obj, [at]);
    } else if (entry.text !== undefined) {
      if (ts.isShorthandPropertyAssignment(existing))
        edit.change(
          existing.getStart(edit.sf),
          existing.getEnd(),
          entry.text === name ? name : `${name}: ${entry.text}`,
        );
      else if (ts.isPropertyAssignment(existing)) {
        const init = existing.initializer;
        if (entry.text === name) edit.change(existing.getStart(edit.sf), existing.getEnd(), name);
        else edit.change(init.getStart(edit.sf), init.getEnd(), entry.text);
      }
    }
    return undefined;
  }
  if (!ts.isPropertyAssignment(existing) || !ts.isArrayLiteralExpression(existing.initializer))
    throw new Refusal(a.intent, `${name} is not written as \`${name}: [...]\` in the code`);
  const list = existing.initializer;
  if (live.length === 0) {
    removeItems(edit, obj, [at]);
    return undefined;
  }
  const removed = entries.flatMap((e) => (e.removed && e.at !== undefined ? [e.at] : []));
  if (removed.length > 0) removeItems(edit, list, removed);
  for (const e of entries) {
    if (e.removed || e.at === undefined || e.text === undefined) continue;
    const el = list.elements[e.at]!;
    edit.change(el.getStart(edit.sf), el.getEnd(), e.text);
  }
  const fresh = entries.flatMap((e) => (!e.removed && e.at === undefined && e.text !== undefined ? [e.text] : []));
  if (fresh.length > 0) append(edit, list, fresh);
  return undefined;
}

const isMakingCall = (n: ts.Node): n is ts.NewExpression | ts.CallExpression =>
  ts.isNewExpression(n) || ts.isCallExpression(n);

/** The `new` or `fromXxx` call that starts where `f` says. */
function madeAt(edit: FileEdit, f: NodeFacts): ts.NewExpression | ts.CallExpression | undefined {
  const start = offsetOf(edit.text, f.span.start.line, f.span.start.col);
  let found: ts.NewExpression | ts.CallExpression | undefined;
  const visit = (n: ts.Node) => {
    if (isMakingCall(n) && n.getStart(edit.sf) === start && (ts.isNewExpression(n) || f.external)) found = n;
    if (!found) ts.forEachChild(n, visit);
  };
  visit(edit.sf);
  return found;
}

/** What a Node is called in the code that made it, and the statement or member that holds it. */
interface Holder {
  /** `vpc` or `this.vpc`. */
  text: string;
  /** The statement or class member the Node is made in. */
  site: ts.Statement | ts.ClassElement;
  /** The block, source file or class the site is in. */
  container: ts.Node;
}

function holderOf(made: ts.Expression): Holder | undefined {
  let top: ts.Expression = made;
  while (
    ts.isParenthesizedExpression(top.parent) ||
    ts.isAsExpression(top.parent) ||
    ts.isSatisfiesExpression(top.parent) ||
    ts.isNonNullExpression(top.parent)
  )
    top = top.parent;
  const parent = top.parent;
  if (ts.isVariableDeclaration(parent) && parent.initializer === top && ts.isIdentifier(parent.name)) {
    const statement = parent.parent.parent;
    return ts.isVariableStatement(statement)
      ? { text: parent.name.text, site: statement, container: statement.parent }
      : undefined;
  }
  if (
    ts.isBinaryExpression(parent) &&
    parent.right === top &&
    parent.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
    ts.isPropertyAccessExpression(parent.left) &&
    parent.left.expression.kind === ts.SyntaxKind.ThisKeyword
  ) {
    const statement = parent.parent;
    return ts.isExpressionStatement(statement)
      ? { text: `this.${parent.left.name.text}`, site: statement, container: statement.parent }
      : undefined;
  }
  if (ts.isPropertyDeclaration(parent) && parent.initializer === top && ts.isIdentifier(parent.name))
    return { text: `this.${parent.name.text}`, site: parent, container: parent.parent };
  return undefined;
}

/** The statement that holds `n` in `container`'s list of statements or members, however deep inside it `n` is. */
function sitIn(n: ts.Node, container: ts.Node): ts.Node | undefined {
  for (let at: ts.Node | undefined = n; at?.parent; at = at.parent) if (at.parent === container) return at;
  return undefined;
}

/** The name the statement that makes the source gives it, when the statement is nothing but that. Undefined if the statement does more. */
function ownStatement(statement: ts.Node, made: ts.Expression): { statement: ts.Statement; name?: string } | undefined {
  if (ts.isVariableStatement(statement)) {
    const [only, ...more] = statement.declarationList.declarations;
    return only &&
      more.length === 0 &&
      ts.isIdentifier(only.name) &&
      only.initializer &&
      bareExpression(only.initializer) === made
      ? { statement, name: only.name.text }
      : undefined;
  }
  if (ts.isExpressionStatement(statement)) {
    const e = statement.expression;
    if (bareExpression(e) === made) return { statement };
    if (
      ts.isBinaryExpression(e) &&
      bareExpression(e.right) === made &&
      ts.isPropertyAccessExpression(e.left) &&
      e.left.expression.kind === ts.SyntaxKind.ThisKeyword
    )
      return { statement, name: e.left.name.text };
  }
  return undefined;
}

function bareExpression(e: ts.Expression): ts.Expression {
  while (
    ts.isParenthesizedExpression(e) ||
    ts.isAsExpression(e) ||
    ts.isSatisfiesExpression(e) ||
    ts.isNonNullExpression(e)
  )
    e = e.expression;
  return e;
}

/**
 * How the code writes the Node `to` where the source `new` is, or why it can't: the Node has to be kept in a variable or a
 * field that is in scope there. A Node made after the source, in the same block, is made before it by moving the source's
 * statement below it, when nothing in between uses the source.
 */
function writeReference(
  edit: FileEdit,
  source: ts.NewExpression,
  sourceFacts: NodeFacts,
  to: NodeFacts,
  label: string,
  intent: number,
): string {
  const source_ = sourceFacts.literalId ?? sourceFacts.className;
  if (to.span.file !== edit.file)
    throw new Refusal(
      intent,
      `${label} is made in ${to.span.file}, and ${source_} in ${edit.file}, so they have no scope in common`,
    );
  const made = madeAt(edit, to);
  const holder = made && holderOf(made);
  if (!made || !holder)
    throw new Refusal(intent, `${label} isn't kept in a variable or a field, so there is nothing to point at`);
  const site = sitIn(source, holder.container);
  if (!site)
    throw new Refusal(
      intent,
      `${source_} and ${label} have no scope in common: ${label} is declared in a block ${source_} is not in`,
    );
  if (site === holder.site)
    throw new Refusal(intent, `${source_} is made in the same statement as ${label}, so it can't point at it`);

  if (ts.isClassLike(holder.container)) {
    // A field set by a property initializer is there for the constructor and every method; for another initializer only when it comes first.
    const members = holder.container.members;
    if (ts.isPropertyDeclaration(site) && members.indexOf(site) < members.indexOf(holder.site as ts.ClassElement)) {
      throw new Refusal(intent, `${source_} is declared before ${label} in the class, so it can't point at it`);
    }
    return holder.text;
  }
  const list = (holder.container as ts.Block | ts.SourceFile | ts.ModuleBlock).statements;
  const from = list.indexOf(site as ts.Statement);
  const at = list.indexOf(holder.site as ts.Statement);
  if (from > at) return holder.text;

  // The source comes first, so its statement moves below the Node's.
  const own = ownStatement(site, source);
  if (!own)
    throw new Refusal(
      intent,
      `${source_} is made in a statement that does more than make it, so Truss can't move it below ${label}`,
    );
  if (own.name !== undefined) {
    const used = list.slice(from + 1, at + 1).find((s) => mentions(s, own.name!));
    if (used) {
      const line = edit.sf.getLineAndCharacterOfPosition(used.getStart(edit.sf)).line + 1;
      throw new Refusal(
        intent,
        `${source_} is used on line ${line}, before ${label} is made, so it can't move below ${label}`,
      );
    }
  }
  edit.moveBelow(own.statement, holder.site as ts.Statement, `${source_} moves below ${label}`);
  return holder.text;
}

/** The Reference edit of one prop of `target`: where it points now, and how a Node is written there. */
function refEdit(
  edit: FileEdit,
  source: ts.NewExpression,
  target: Target,
  prop: string,
  r: { many: boolean; ops: RefOp[]; intent: number; from: string },
): RefEdit {
  // One instance of a Stack class created several times stands for them all.
  const mine = (target.world.references ?? []).filter(
    (e) => e.prop === prop && target.world.nodes[e.from] && key(target.world.nodes[e.from]!) === key(target.facts),
  );
  const first = mine.filter((e) => e.from === r.from).sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
  const all = mine;
  if (all.some((e) => !e.editable))
    throw new Refusal(r.intent, `${prop} is set by ${all.find((e) => !e.editable)!.text}, which Truss leaves alone`);
  const propText =
    target.facts.props?.form === 'object' ? target.facts.props.props.find((p) => p.name === prop) : undefined;
  if (propText && all.length === 0 && !(r.many && /^\[\s*\]$/.test(propText.text.trim())))
    throw new Refusal(
      r.intent,
      `${prop} is written as ${propText.text} in the code, not as a Node Truss can point elsewhere`,
    );
  return {
    many: r.many,
    ops: r.ops,
    intent: r.intent,
    existing: first,
    write: (to, intent) => {
      const toFacts = target.world.nodes[to.path];
      if (!toFacts) throw new Refusal(intent, `There is no construct at ${to.path} in the code`);
      return writeReference(edit, source, target.facts, toFacts, to.literalId || to.path, intent);
    },
  };
}

// --- Connections --------------------------------------------------------------------------------------

/** An edit of the calls that make a Connection. */
interface Connecting {
  index: number;
  intent: ConnectionIntent;
}

const refOfFact = (c: CallFacts): CallRef => ({
  role: c.role,
  on: c.on,
  peer: c.peer,
  method: c.method,
  ...(c.env !== undefined ? { env: c.env } : {}),
});

/** The calls of the code that `refs` name, each of which has to be one Truss can edit. */
function callsNamed(world: Facts, refs: readonly CallRef[], index: number): CallFacts[] {
  const found: CallFacts[] = [];
  for (const ref of refs) {
    const hit = (world.calls ?? []).find((c) => sameCall(refOfFact(c), ref) && !found.includes(c));
    if (!hit)
      throw new Refusal(index, `The code has no ${ref.method.join('.')} call between ${ref.on} and ${ref.peer}`);
    if (!hit.editable) throw new Refusal(index, hit.reason ?? `Truss leaves ${hit.text} alone`);
    found.push(hit);
  }
  return found;
}

/** The statement that a call was read from. */
function statementOf(edit: FileEdit, call: CallFacts, index: number): ts.ExpressionStatement {
  const start = offsetOf(edit.text, call.span.start.line, call.span.start.col);
  let found: ts.ExpressionStatement | undefined;
  const visit = (n: ts.Node) => {
    if (ts.isExpressionStatement(n) && n.getStart(edit.sf) === start) found = n;
    if (!found) ts.forEachChild(n, visit);
  };
  visit(edit.sf);
  if (!found || found.getText(edit.sf) !== call.text)
    throw new Refusal(index, `The code at ${call.id} is not the call Truss read`);
  return found;
}

/** The statements of the calls, each once however many paths they were read for. */
function statementsOf(edit: FileEdit, calls: readonly CallFacts[], index: number): ts.ExpressionStatement[] {
  const seen = new Set<number>();
  const out: ts.ExpressionStatement[] = [];
  for (const call of calls) {
    const st = statementOf(edit, call, index);
    if (!seen.has(st.getStart(edit.sf))) {
      seen.add(st.getStart(edit.sf));
      out.push(st);
    }
  }
  return out;
}

/** Deletes the statements that make `calls`, unless this plan has already deleted them. */
function deleteCalls(edit: FileEdit, calls: readonly CallFacts[], index: number): void {
  for (const st of statementsOf(edit, calls, index)) {
    if (edit.removed.has(st.getStart(edit.sf))) continue;
    edit.removed.add(st.getStart(edit.sf));
    const r = removalRange(edit, st);
    edit.change(r.start, r.end, '', 'remove');
  }
}

/** The ranges of the statements of `calls`, which a Node's deletion takes with it. */
function callRanges(edit: FileEdit, calls: readonly CallFacts[], index: number): { start: number; end: number }[] {
  return statementsOf(edit, calls, index).map((st) => removalRange(edit, st));
}

/** What the code calls the two Nodes of a Connection where a call can be written, and the block that call goes in. */
interface Bindings {
  self: string;
  peer: string;
  /** The statement the new calls follow. */
  anchor: ts.Statement;
}

function bindingsOf(edit: FileEdit, selfFacts: NodeFacts, peerFacts: NodeFacts, index: number): Bindings {
  const holder = (f: NodeFacts): Holder => {
    const name = f.literalId ?? f.className;
    if (f.span.file !== edit.file)
      throw new Refusal(
        index,
        `${name} is made in ${f.span.file}, not in ${edit.file}, so the code has no scope in common to call it from`,
      );
    const made = madeAt(edit, f);
    const h = made && holderOf(made);
    if (!h) throw new Refusal(index, `${name} isn't kept in a variable or a field, so there is nothing to call it by`);
    return h;
  };
  const s = holder(selfFacts);
  const p = holder(peerFacts);
  const ctorBody = (h: Holder): ts.Block | undefined => {
    if (ts.isClassLike(h.container)) return h.container.members.find(ts.isConstructorDeclaration)?.body;
    return ts.isBlock(h.container) && ts.isConstructorDeclaration(h.container.parent) ? h.container : undefined;
  };
  const names = `${selfFacts.literalId ?? selfFacts.className} and ${peerFacts.literalId ?? peerFacts.className}`;
  if (s.container === p.container && !ts.isClassLike(s.container)) {
    const list = (s.container as ts.Block | ts.SourceFile | ts.ModuleBlock).statements;
    const later = list.indexOf(s.site as ts.Statement) > list.indexOf(p.site as ts.Statement) ? s : p;
    return { self: s.text, peer: p.text, anchor: later.site as ts.Statement };
  }
  const body = ctorBody(s);
  if (!body || body !== ctorBody(p))
    throw new Refusal(
      index,
      `${names} are not made in the same block of code, so there is no scope in common to connect them in`,
    );
  const inBody = [s, p].filter((h) => h.container === body).map((h) => h.site as ts.Statement);
  const anchor =
    inBody.length > 0
      ? inBody.reduce((a, b) => (body.statements.indexOf(b) > body.statements.indexOf(a) ? b : a))
      : body.statements.at(-1);
  if (!anchor) throw new Refusal(index, `The constructor that makes ${names} is empty, so there is nothing to follow`);
  return { self: s.text, peer: p.text, anchor };
}

/** A string in a template, in the quote the file uses. */
function requote(code: string, quote: string): string {
  return quote === "'" ? code : code.replace(/'([^'"\\]*)'/g, `${quote}$1${quote}`);
}

/** The statements of `plans`, written the way the file writes. */
function renderCalls(
  edit: FileEdit,
  index: number,
  plans: readonly CallPlan[],
  names: { self: string; peer: string },
  semicolon: string,
): string[] {
  return plans.map((plan) => {
    if (!plan.method.every((m) => IDENTIFIER.test(m)))
      throw new Refusal(index, `${plan.method.join('.')} is not a method name`);
    const args = plan.args.map((a) =>
      requote(a.split('{self}').join(names.self).split('{peer}').join(names.peer), edit.quote),
    );
    return `${plan.on === 'self' ? names.self : names.peer}.${plan.method.join('.')}(${importing(edit, index, args.join(', '), plan.uses)})${semicolon}`;
  });
}

function connect(
  { index, intent }: Connecting,
  world: Facts,
  editOf: (file: string, intent: number) => FileEdit,
): void {
  const selfFacts = world.nodes[intent.path]!;
  const peerFacts = world.nodes[intent.peer.path]!;
  const edit = editOf(selfFacts.span.file, index);
  if (intent.type === 'removeConnection') {
    deleteCalls(edit, callsNamed(world, intent.calls, index), index);
    return;
  }
  if (intent.calls.length === 0) throw new Refusal(index, 'There is no call to write');
  const names = bindingsOf(edit, selfFacts, peerFacts, index);
  if (intent.type === 'addConnection') {
    const semicolon = names.anchor.getText(edit.sf).endsWith(';') ? ';' : '';
    insertAfter(
      edit,
      names.anchor,
      renderCalls(edit, index, intent.calls, names, semicolon).join(`${edit.newline}${edit.indentOf(names.anchor)}`),
    );
    return;
  }
  // The new calls go where the first of the old ones was, the rest of which are deleted.
  const old = callsNamed(world, intent.was, index);
  const [first, ...rest] = statementsOf(edit, old, index);
  if (!first) throw new Refusal(index, 'There is no call to replace');
  const semicolon = first.getText(edit.sf).endsWith(';') ? ';' : '';
  edit.removed.add(first.getStart(edit.sf));
  edit.change(
    first.getStart(edit.sf),
    first.getEnd(),
    renderCalls(edit, index, intent.calls, names, semicolon).join(`${edit.newline}${edit.indentOf(first)}`),
    'add',
  );
  for (const st of rest) {
    if (edit.removed.has(st.getStart(edit.sf))) continue;
    edit.removed.add(st.getStart(edit.sf));
    const r = removalRange(edit, st);
    edit.change(r.start, r.end, '', 'remove');
  }
}

const key = (f: NodeFacts) => `${f.span.file}:${f.span.start.line}:${f.span.start.col}`;

/** Plans `intents` against `files`, which `facts` were read from. Every intent is checked, and the changes it makes are confined to the `new` call it names (and the file's imports). */
export function planIntents(
  files: FileSet,
  facts: Facts,
  intents: readonly Intent[],
  parse: (file: string) => ts.SourceFile | undefined,
): PlanResult {
  try {
    // Edits of one `new` call are planned together, because a later edit may land in an object an earlier one created.
    const targets = new Map<string, Target>();
    const creations: Creation[] = [];
    const removals = new Map<string, Removal>();
    const connections: Connecting[] = [];
    for (const [i, intent] of onBase(intents).entries()) {
      const f = facts.nodes[intent.path];
      if (!f) throw new Refusal(i, `There is no construct at ${intent.path} in the code`);
      if (f.external) throw new Refusal(i, `${intent.path} refers to an existing resource; the code doesn't create it`);
      if (f.className !== intent.expect.className || (f.literalId ?? '') !== intent.expect.literalId) {
        throw new Refusal(
          i,
          `${intent.path} is no longer ${intent.expect.className} "${intent.expect.literalId}" in the code`,
        );
      }
      if (intent.type === 'addNode') {
        creations.push({ index: i, intent, scopePath: intent.path, scope: f });
        continue;
      }
      if (isConnectionIntent(intent)) {
        const peer = facts.nodes[intent.peer.path];
        if (!peer) throw new Refusal(i, `There is no construct at ${intent.peer.path} in the code`);
        if (peer.external)
          throw new Refusal(i, `${intent.peer.path} refers to an existing resource; the code doesn't create it`);
        if (peer.className !== intent.peer.className || (peer.literalId ?? '') !== intent.peer.literalId) {
          throw new Refusal(
            i,
            `${intent.peer.path} is no longer ${intent.peer.className} "${intent.peer.literalId}" in the code`,
          );
        }
        connections.push({ index: i, intent });
        continue;
      }
      if (intent.type === 'removeNode') {
        const nodeProblem = nodeEditability(intent.path, f);
        if (!nodeProblem.editable) throw new Refusal(i, nodeProblem.reason);
        if (f.pathsOnSpan > 1)
          throw new Refusal(
            i,
            `${intent.path} is one of ${f.pathsOnSpan} constructs made by the same \`new\` call, so it can't be removed for one of them alone`,
          );
        removals.set(key(f), { index: i, intent, facts: f });
        continue;
      }
      if (intent.type === 'duplicate') {
        const nodeProblem = nodeEditability(intent.path, f);
        if (!nodeProblem.editable) throw new Refusal(i, nodeProblem.reason);
        if (f.pathsOnSpan > 1)
          throw new Refusal(
            i,
            `${intent.path} is one of ${f.pathsOnSpan} constructs made by the same \`new\` call, so it can't be copied for one of them alone`,
          );
        const scopePath = parentPath(intent.path);
        const scope = facts.nodes[scopePath];
        if (!scope) throw new Refusal(i, `There is no Stack at ${scopePath} in the code to put the copy in`);
        creations.push({ index: i, intent, scopePath, scope, source: f });
        continue;
      }
      const target: Target = targets.get(key(f)) ?? {
        file: f.span.file,
        facts: f,
        assigns: new Map<string, Assign>(),
        refs: new Map(),
        world: facts,
        intent: i,
      };
      if (isReferenceIntent(intent)) {
        if (!intent.prop || !IDENTIFIER.test(intent.prop)) throw new Refusal(i, `${intent.prop} is not a prop name`);
        const nodeProblem = nodeEditability(intent.path, f);
        if (!nodeProblem.editable) throw new Refusal(i, nodeProblem.reason);
        if (f.props?.form === 'other')
          throw new Refusal(i, `The props are passed as ${f.props.text}, not written out in the call`);
        for (const n of intent.type === 'repointReference' ? [intent.was, intent.to] : [intent.to]) {
          const t = facts.nodes[n.path];
          if (!t) throw new Refusal(i, `There is no construct at ${n.path} in the code`);
          if (t.className !== n.className || (t.literalId ?? '') !== n.literalId)
            throw new Refusal(i, `${n.path} is no longer ${n.className} "${n.literalId}" in the code`);
        }
        const there = target.refs.get(intent.prop) ?? { many: false, ops: [], intent: i, from: intent.path };
        if (intent.type === 'addReference' && intent.many) there.many = true;
        if (
          !(intent.type === 'addReference') &&
          (facts.references ?? []).some(
            (e) => e.from === intent.path && e.prop === intent.prop && e.index !== undefined,
          )
        )
          there.many = true;
        there.ops.push(refOpOf(intent, i));
        target.refs.set(intent.prop, there);
      } else if (intent.type === 'renameId') {
        // Only the literal is rewritten, so a construct that is one of several made by the same `new` would be renamed in all of them.
        if (f.pathsOnSpan > 1)
          throw new Refusal(
            i,
            `${intent.path} is one of ${f.pathsOnSpan} constructs made by the same \`new\` call, so its ID can't be changed for it alone`,
          );
        const problem = constructIdProblem(intent.newId, []);
        if (problem) throw new Refusal(i, problem);
        target.rename = { id: intent.newId, intent: i };
      } else {
        if (intent.prop.length === 0 || !intent.prop.every((p) => IDENTIFIER.test(p)))
          throw new Refusal(i, `${intent.prop.join('.')} is not a prop name`);
        assign(target.assigns, intent.prop, intent.value, i);
      }
      targets.set(key(f), target);
    }

    const edits = new Map<string, FileEdit>();
    const editOf = (file: string, intent: number): FileEdit => {
      let edit = edits.get(file);
      if (!edit) {
        const text = files.get(file);
        const sf = parse(file);
        if (text === undefined || !sf) throw new Refusal(intent, `${file} is not among the app's files`);
        edit = new FileEdit(file, text, sf);
        edits.set(file, edit);
      }
      return edit;
    };
    // What is removed is not also edited: the whole statement goes, so an edit of it earlier in the Draft has nothing left to change.
    for (const [span, target] of targets) if (!removals.has(span)) editNew(editOf(target.file, target.intent), target);
    for (const c of creations) create(c, facts, editOf, files, parse);
    for (const c of connections) connect(c, facts, editOf);
    if (removals.size > 0) {
      const service = languageServiceOver(files);
      for (const r of removals.values()) removeNode(r, editOf, files, service, facts);
    }

    const changes: Record<string, TextChange[]> = {};
    for (const [file, edit] of edits) {
      const sorted = edit.finish();
      if (sorted.length === 0) continue;
      const blame =
        [...targets.values()].find((t) => t.file === file)?.intent ?? creations[0]?.index ?? connections[0]?.index ?? 0;
      let after: string;
      try {
        after = applyChanges(edit.text, sorted);
      } catch {
        throw new Refusal(blame, `Two of the edits to ${file} touch the same text`);
      }
      const bad = ts.transpileModule(after, {
        fileName: file,
        reportDiagnostics: true,
        compilerOptions: { target: ts.ScriptTarget.Latest },
      }).diagnostics?.[0];
      if (bad)
        throw new Refusal(
          blame,
          `The edit would leave ${file} with a syntax error: ${ts.flattenDiagnosticMessageText(bad.messageText, '\n')}`,
        );
      changes[file] = sorted;
    }
    return { ok: true, changes };
  } catch (err) {
    if (err instanceof Refusal)
      return { ok: false, intent: err.intent, reason: err.message, ...(err.uses ? { uses: err.uses } : {}) };
    throw err;
  }
}
