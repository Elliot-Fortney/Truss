// Turns intents into text changes in the file's own style (ADR 0007). It edits the text and leaves everything else alone.
import ts from '@typescript/typescript6';
import { applyChanges, offsetOf, type TextChange } from '../../core/diff.ts';
import type { Facts, NodeFacts } from '../../core/facts.ts';
import { constructIdProblem, parentPath } from '../../core/construct-id.ts';
import { nodeEditability } from '../../core/editability.ts';
import { onBase, type AddNodeIntent, type AddedProp, type DuplicateIntent, type Intent, type PropValue, type RemoveNodeIntent } from '../../core/intents.ts';
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

/** The value to set at a path of props, or the props to set inside one. */
type Assign = { leaf: PropValue; intent: number } | { fields: Map<string, Assign>; intent: number };

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
}

/** Everything the planner learns about one file, and the changes it has made to it so far. */
class FileEdit {
  readonly changes: TextChange[] = [];
  readonly newline: string;
  readonly quote: string;
  private identifiers: Set<string> | undefined;
  private readonly namedAdds = new Map<ts.ImportDeclaration, string[]>();
  /** The imports this plan adds, by module: one line each, however many of its names are used. */
  private readonly newImports = new Map<string, { named: string[] } | { alias: string }>();
  private readonly refs = new Map<string, string>();

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

  /** The text after the changes so far, with imports. */
  finish(): TextChange[] {
    for (const [decl, names] of this.namedAdds) {
      const elements = (decl.importClause!.namedBindings as ts.NamedImports).elements;
      const last = elements[elements.length - 1]!;
      const between = this.text.slice((decl.importClause!.namedBindings as ts.NamedImports).getStart(this.sf), last.getStart(this.sf));
      const separator = between.includes('\n') ? `,${this.newline}${this.indentOf(last)}` : ', ';
      this.changes.push({ start: last.getEnd(), end: last.getEnd(), text: names.map((n) => separator + n).join(''), purpose: 'import' });
    }
    if (this.newImports.size > 0) {
      const imports = this.sf.statements.filter(ts.isImportDeclaration);
      const lastImport = imports.at(-1);
      const at = lastImport ? lastImport.getEnd() : 0;
      const quoted = (m: string) => `${this.importQuote()}${m}${this.importQuote()}`;
      const semi = this.importSemicolon();
      const lines = [...this.newImports]
        .map(([module, i]) => ('alias' in i ? `import * as ${i.alias} from ${quoted(module)}${semi}` : `import { ${i.named.join(', ')} } from ${quoted(module)}${semi}`))
        .join(this.newline);
      this.changes.push({ start: at, end: at, text: lastImport ? this.newline + lines : lines + this.newline, purpose: 'import' });
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
    if (this.used(bound) && !(added && 'alias' in added)) throw new Refusal(intent, `The file already uses the name ${bound} for something else, so ${type} can't be imported as it`);
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
      if (ts.isImportEqualsDeclaration(s) && ts.isExternalModuleReference(s.moduleReference) && ts.isStringLiteral(s.moduleReference.expression) && s.moduleReference.expression.text === module) {
        return `${s.name.text}.${type}`;
      }
      if (!ts.isImportDeclaration(s) || !ts.isStringLiteral(s.moduleSpecifier) || s.moduleSpecifier.text !== module) continue;
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
      if (!ts.isImportDeclaration(s) || !ts.isStringLiteral(s.moduleSpecifier) || s.moduleSpecifier.text !== module) continue;
      const bindings = s.importClause?.namedBindings;
      if (s.importClause && !s.importClause.isTypeOnly && bindings && ts.isNamedImports(bindings) && bindings.elements.length > 0) {
        if (this.used(type)) return undefined;
        this.namedAdds.set(s, [...(this.namedAdds.get(s) ?? []), type]);
        return type;
      }
    }
    return undefined;
  }

  private cdkImports(): ts.ImportDeclaration[] {
    return this.sf.statements.filter((s): s is ts.ImportDeclaration => ts.isImportDeclaration(s) && ts.isStringLiteral(s.moduleSpecifier) && s.moduleSpecifier.text.startsWith(`${CDK_LIB}/`));
  }

  /** The file imports CDK modules by name, and none as a namespace. */
  private namedStyle(): boolean {
    const imports = this.cdkImports();
    return imports.length > 0 && imports.every((s) => s.importClause?.namedBindings !== undefined && ts.isNamedImports(s.importClause.namedBindings));
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
    if (ts.isStringLiteral(n)) n.getText(sf)[0] === '"' ? double++ : single++;
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
  if (parts[0] !== CDK_LIB || parts.length < 2 || parts.length > 3) throw new Refusal(intent, `Truss only writes enums and constructs of ${CDK_LIB}, not ${fqn}`);
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
      if (existing && quantityOf(existing)?.type === type) return `${((existing as ts.CallExpression).expression as ts.PropertyAccessExpression).expression.getText(edit.sf)}.${call}`;
      return `${edit.ref(intent, CDK_LIB, type, 'cdk')}.${call}`;
    }
    case 'enum': {
      const home = enumHome(intent, value.type);
      if (existing && memberOf(existing)?.type === home.type) return `${(existing as ts.PropertyAccessExpression).expression.getText(edit.sf)}.${value.member}`;
      return `${edit.ref(intent, home.module, home.type, home.alias)}.${value.member}`;
    }
  }
}

function render(edit: FileEdit, name: string, a: Assign): string {
  return `${name}: ${'leaf' in a ? emit(edit, a.intent, a.leaf, undefined) : renderObject(edit, a.fields)}`;
}

const renderObject = (edit: FileEdit, fields: Map<string, Assign>): string => `{ ${[...fields].map(([name, a]) => render(edit, name, a)).join(', ')} }`;

/** What may be replaced by a value from the canvas: a value of the same kind as the ones the canvas writes. */
const isReplaceable = (e: ts.Expression) => literalValue(e) !== undefined || memberOf(e) !== undefined || quantityOf(e) !== undefined;

function propNamed(obj: ts.ObjectLiteralExpression, name: string): ts.ObjectLiteralElementLike | undefined {
  return obj.properties.findLast((p) => p.name !== undefined && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) && p.name.text === name);
}

function editObject(edit: FileEdit, obj: ts.ObjectLiteralExpression, fields: Map<string, Assign>): void {
  const added: string[] = [];
  for (const [name, a] of fields) {
    const existing = propNamed(obj, name);
    if (!existing) {
      added.push(render(edit, name, a));
      continue;
    }
    if (!ts.isPropertyAssignment(existing)) throw new Refusal(a.intent, `${name} is not written as \`${name}: value\` in the code`);
    const init = existing.initializer;
    if ('leaf' in a) {
      if (!isReplaceable(init)) throw new Refusal(a.intent, `${name} is an expression in the code (${init.getText(edit.sf)}), which Truss leaves alone`);
      const text = emit(edit, a.intent, a.leaf, init);
      if (text !== init.getText(edit.sf)) edit.change(init.getStart(edit.sf), init.getEnd(), text);
    } else {
      if (!ts.isObjectLiteralExpression(init)) throw new Refusal(a.intent, `${name} is ${init.getText(edit.sf)} in the code, not an object Truss can edit field by field`);
      editObject(edit, init, a.fields);
    }
  }
  if (added.length > 0) append(edit, obj, added);
}

/** Adds props after the last one (so after any spread, where they win), laid out the way the object is. */
function append(edit: FileEdit, obj: ts.ObjectLiteralExpression, entries: string[]): void {
  const { sf, text, newline } = edit;
  const props = obj.properties;
  const last = props.at(-1);
  if (!last) return edit.change(obj.getStart(sf), obj.getEnd(), `{ ${entries.join(', ')} }`);
  const open = sf.getLineAndCharacterOfPosition(obj.getStart(sf)).line;
  const multiline = sf.getLineAndCharacterOfPosition(props[0]!.getStart(sf)).line !== open;
  const comma = props.hasTrailingComma ? obj.getChildren(sf).find((c) => c.kind === ts.SyntaxKind.SyntaxList)!.getChildren(sf).at(-1)! : undefined;
  const afterLast = comma ? comma.getEnd() : last.getEnd();
  if (!multiline) {
    return comma
      ? edit.change(afterLast, afterLast, ` ${entries.join(', ')},`)
      : edit.change(afterLast, afterLast, `, ${entries.join(', ')}`);
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
  if (!found || found.expression.getText(edit.sf) !== facts.className || !id || !isStringLike(id) || id.text !== facts.literalId) {
    throw new Refusal(intent, `The code at ${facts.span.file}:${facts.span.start.line} is not the \`new ${facts.className}\` Truss read`);
  }
  if (target.rename && target.rename.id !== facts.literalId) {
    const quote = id.getText(edit.sf)[0]!;
    edit.change(id.getStart(edit.sf), id.getEnd(), quoted(target.rename.id, quote));
  }
  const props = found.arguments![2];
  if (target.assigns.size === 0) return;
  if (!props) return edit.change(id.getEnd(), id.getEnd(), `, ${renderObject(edit, target.assigns)}`);
  if (!ts.isObjectLiteralExpression(props)) throw new Refusal(intent, `The props are passed as ${props.getText(edit.sf)}, not written out in the call`);
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
  'break case catch class const continue debugger default delete do else enum export extends false finally for function if import in instanceof new null return super switch this throw true try typeof var void while with yield let static implements interface package private protected public await async of type'.split(' '),
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
  for (let at: ts.Node | undefined = n; at?.parent; at = at.parent) if (at.parent === body && ts.isStatement(at)) return at;
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
function place(c: Creation, facts: Facts, edits: (file: string, intent: number) => FileEdit, files: FileSet, parse: (file: string) => ts.SourceFile | undefined): Placement {
  const { scope, scopePath, index } = c;
  const className = scope.className.split('.').at(-1)!;
  let cls: { edit: FileEdit; decl: ts.ClassDeclaration } | undefined;
  for (const file of files.keys()) {
    const sf = parse(file);
    const decl = sf?.statements.find((st): st is ts.ClassDeclaration => ts.isClassDeclaration(st) && st.name?.text === className);
    if (decl) {
      cls = { edit: edits(file, index), decl };
      break;
    }
  }
  if (cls) {
    const ctor = cls.decl.members.find(ts.isConstructorDeclaration);
    if (!ctor?.body || ctor.body.statements.length === 0) throw new Refusal(index, `${className} has no constructor body to add the construct to`);
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
    return { edit: cls.edit, anchor, scopeArg: 'this', cls: cls.decl, fields: siblings.some(([, f]) => f.binding === 'field') };
  }
  if (scope.surround) throw new Refusal(index, `${scopePath} is made in a ${scope.surround.kind === 'loop' ? 'loop' : `helper, ${scope.surround.name}`}, so Truss can't tell where to add to it`);
  const edit = edits(scope.span.file, index);
  const made = newAt(edit, scope);
  let decl: ts.Node | undefined = made;
  while (decl && !ts.isVariableDeclaration(decl)) decl = decl.parent;
  const statement = decl?.parent?.parent;
  if (!decl || !ts.isVariableDeclaration(decl) || !ts.isIdentifier(decl.name) || !statement || !ts.isVariableStatement(statement) || !(ts.isSourceFile(statement.parent) || ts.isBlock(statement.parent))) {
    throw new Refusal(index, `${scopePath} isn't kept in a variable, so there is nothing to add the construct to`);
  }
  const list = statement.parent.statements;
  const name = decl.name.text;
  const after = list.slice(list.indexOf(statement));
  const anchor = after.findLast((st) => mentions(st, name)) ?? statement;
  return { edit, anchor, scopeArg: name, fields: false };
}

/** The code of the added construct's props, as the object literal it goes in; empty when it has none. */
function addedProps(edit: FileEdit, index: number, props: readonly AddedProp[]): string {
  const parts = props.map((p) => {
    if (!IDENTIFIER.test(p.name)) throw new Refusal(index, `${p.name} is not a prop name`);
    if ('value' in p) return render(edit, p.name, { leaf: p.value, intent: index });
    let code = p.snippet.code;
    for (const fqn of p.snippet.uses ?? []) {
      const home = enumHome(index, fqn);
      const ref = edit.ref(index, home.module, home.type, home.alias);
      if (ref !== home.type) code = code.replace(new RegExp(`(?<![\\w$.'"])${home.type}\\b`, 'g'), ref);
    }
    return `${p.name}: ${code}`;
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
  const modifiers = properties.at(-1)?.modifiers?.map((m) => m.getText(edit.sf)).join(' ') ?? 'readonly';
  const declaration = `${modifiers ? modifiers + ' ' : ''}${name}: ${type};`;
  const last = properties.at(-1);
  if (last) return insertAfter(edit, last, declaration);
  const ctor = cls.members.find(ts.isConstructorDeclaration)!;
  const at = ctor.getStart(edit.sf);
  edit.change(at, at, `${declaration}${edit.newline}${edit.newline}${edit.indentOf(ctor)}`, 'add');
}

function create(c: Creation, facts: Facts, edits: (file: string, intent: number) => FileEdit, files: FileSet, parse: (file: string) => ts.SourceFile | undefined): void {
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
      return insertAfter(edit, anchor, `this.${name} = ${made}${semicolon}`);
    }
    return insertAfter(edit, anchor, `const ${name} = ${made}${semicolon}`);
  }
  copy(c as Creation & { intent: DuplicateIntent; source: NodeFacts }, placed, semicolon);
}

/** Writes a copy of the statement that makes the construct, with the ID and the name it is bound to changed. */
function copy(c: Creation & { intent: DuplicateIntent; source: NodeFacts }, placed: Placement, semicolon: string): void {
  const { intent, index, source } = c;
  const { edit } = placed;
  const problem = constructIdProblem(intent.newId, []);
  if (problem) throw new Refusal(index, problem);
  if (edit.file !== source.span.file) throw new Refusal(index, `${intent.path} is in ${source.span.file}, not in the file the copy goes in`);
  const found = newAt(edit, source);
  const id = found?.arguments?.[1];
  if (!found || !id || !isStringLike(id)) throw new Refusal(index, `The code at ${source.span.file}:${source.span.start.line} is not the \`new\` Truss read`);
  let statement: ts.Node | undefined = found;
  while (statement && !ts.isStatement(statement)) statement = statement.parent;
  if (!statement || !ts.isStatement(statement)) throw new Refusal(index, `${intent.path} isn't made by a statement of its own, so it can't be copied`);
  const replacements: Array<{ start: number; end: number; text: string }> = [{ start: id.getStart(edit.sf), end: id.getEnd(), text: quoted(intent.newId, id.getText(edit.sf)[0]!) }];
  let declared: { old: string; name: string } | undefined;
  if (ts.isVariableStatement(statement)) {
    const [only, ...more] = statement.declarationList.declarations;
    if (!only || more.length > 0 || !ts.isIdentifier(only.name) || only.initializer !== found) throw new Refusal(index, `${intent.path} is made in a statement Truss can't copy`);
    const name = bindingFor(edit, intent.newId);
    replacements.push({ start: only.name.getStart(edit.sf), end: only.name.getEnd(), text: name });
  } else if (ts.isExpressionStatement(statement)) {
    const e = statement.expression;
    if (ts.isBinaryExpression(e) && e.right === found && ts.isPropertyAccessExpression(e.left) && e.left.expression.kind === ts.SyntaxKind.ThisKeyword) {
      const name = bindingFor(edit, intent.newId);
      replacements.push({ start: e.left.name.getStart(edit.sf), end: e.left.name.getEnd(), text: name });
      declared = { old: e.left.name.text, name };
    } else if (e !== found) throw new Refusal(index, `${intent.path} is made in a statement Truss can't copy`);
  } else throw new Refusal(index, `${intent.path} is made in a statement Truss can't copy`);

  const from = statement.getStart(edit.sf);
  let text = edit.text.slice(from, statement.getEnd());
  for (const r of replacements.sort((a, b) => b.start - a.start)) text = text.slice(0, r.start - from) + r.text + text.slice(r.end - from);
  if (!semicolon && text.endsWith(';')) text = text.slice(0, -1);
  if (declared && placed.cls) {
    const property = placed.cls.members.find((m): m is ts.PropertyDeclaration => ts.isPropertyDeclaration(m) && ts.isIdentifier(m.name) && m.name.text === declared.old);
    if (property) {
      const start = property.getStart(edit.sf);
      const name = property.name.getStart(edit.sf) - start;
      insertAfter(edit, property, edit.text.slice(start, property.getEnd()).slice(0, name) + declared.name + edit.text.slice(property.name.getEnd(), property.getEnd()));
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
  end += text.slice(end).match(LINE_END)![0].length;
  if (/(\n[ \t]*\r?\n|\{[ \t]*\r?\n)$/.test(text.slice(0, start)) || start === 0) end += text.slice(end).match(/^[ \t]*\r?\n/)?.[0].length ?? 0;
  return { start, end };
}

/** Deletes the statement that makes a construct, and the field it is kept in, unless code other than that still uses it. */
function removeNode(r: Removal, edits: (file: string, intent: number) => FileEdit, files: FileSet, service: ts.LanguageService): void {
  const { index, intent, facts } = r;
  const edit = edits(facts.span.file, index);
  const found = newAt(edit, facts);
  let statement: ts.Node | undefined = found;
  while (statement && !ts.isStatement(statement)) statement = statement.parent;
  if (!found || !statement || !ts.isStatement(statement)) throw new Refusal(index, `The code at ${facts.span.file}:${facts.span.start.line} is not the \`new\` Truss read`);
  // What the construct is called in the code: a variable, or a field of the class.
  let name: ts.Node | undefined;
  let property: ts.PropertyDeclaration | undefined;
  if (ts.isVariableStatement(statement)) {
    const [only, ...more] = statement.declarationList.declarations;
    if (!only || more.length > 0 || !ts.isIdentifier(only.name) || only.initializer !== found) throw new Refusal(index, `${intent.path} is made in a statement Truss can't remove`);
    name = only.name;
  } else if (ts.isExpressionStatement(statement)) {
    const e = statement.expression;
    if (ts.isBinaryExpression(e) && e.right === found && ts.isPropertyAccessExpression(e.left) && e.left.expression.kind === ts.SyntaxKind.ThisKeyword) {
      name = e.left.name;
      let cls: ts.Node | undefined = statement;
      while (cls && !ts.isClassLike(cls)) cls = cls.parent;
      property = cls && ts.isClassLike(cls) ? cls.members.find((m): m is ts.PropertyDeclaration => ts.isPropertyDeclaration(m) && ts.isIdentifier(m.name) && m.name.text === (name as ts.Identifier).text) : undefined;
    } else if (e !== found) throw new Refusal(index, `${intent.path} is made in a statement Truss can't remove`);
  } else throw new Refusal(index, `${intent.path} isn't made by a statement of its own, so it can't be removed`);

  const gone = [removalRange(edit, statement), ...(property ? [removalRange(edit, property)] : [])];
  if (name) {
    const at = (property?.name ?? name).getStart(edit.sf);
    const uses = referencesTo(service, edit.file, at).filter((u) => u.file !== edit.file || !gone.some((g) => u.start >= g.start && u.end <= g.end));
    if (uses.length > 0) {
      const places = uses.sort((a, b) => a.file.localeCompare(b.file) || a.start - b.start).map((u) => useAt(files, u.file, u.start));
      throw new Refusal(index, `${intent.expect.literalId} is still used in ${places.length === 1 ? 'one place' : `${places.length} places`}: ${places.map((p) => `${p.file}:${p.line}`).join(', ')}`, places);
    }
  }
  for (const g of gone) edit.change(g.start, g.end, '', 'remove');
}

const key = (f: NodeFacts) => `${f.span.file}:${f.span.start.line}:${f.span.start.col}`;

/** Plans `intents` against `files`, which `facts` were read from. Every intent is checked, and the changes it makes are confined to the `new` call it names (and the file's imports). */
export function planIntents(files: FileSet, facts: Facts, intents: readonly Intent[], parse: (file: string) => ts.SourceFile | undefined): PlanResult {
  try {
    // Edits of one `new` call are planned together, because a later edit may land in an object an earlier one created.
    const targets = new Map<string, Target>();
    const creations: Creation[] = [];
    const removals = new Map<string, Removal>();
    for (const [i, intent] of onBase(intents).entries()) {
      const f = facts.nodes[intent.path];
      if (!f) throw new Refusal(i, `There is no construct at ${intent.path} in the code`);
      if (f.external) throw new Refusal(i, `${intent.path} refers to an existing resource; the code doesn't create it`);
      if (f.className !== intent.expect.className || (f.literalId ?? '') !== intent.expect.literalId) {
        throw new Refusal(i, `${intent.path} is no longer ${intent.expect.className} "${intent.expect.literalId}" in the code`);
      }
      if (intent.type === 'addNode') {
        creations.push({ index: i, intent, scopePath: intent.path, scope: f });
        continue;
      }
      if (intent.type === 'removeNode') {
        const nodeProblem = nodeEditability(intent.path, f);
        if (!nodeProblem.editable) throw new Refusal(i, nodeProblem.reason);
        if (f.pathsOnSpan > 1) throw new Refusal(i, `${intent.path} is one of ${f.pathsOnSpan} constructs made by the same \`new\` call, so it can't be removed for one of them alone`);
        removals.set(key(f), { index: i, intent, facts: f });
        continue;
      }
      if (intent.type === 'duplicate') {
        const nodeProblem = nodeEditability(intent.path, f);
        if (!nodeProblem.editable) throw new Refusal(i, nodeProblem.reason);
        if (f.pathsOnSpan > 1) throw new Refusal(i, `${intent.path} is one of ${f.pathsOnSpan} constructs made by the same \`new\` call, so it can't be copied for one of them alone`);
        const scopePath = parentPath(intent.path);
        const scope = facts.nodes[scopePath];
        if (!scope) throw new Refusal(i, `There is no Stack at ${scopePath} in the code to put the copy in`);
        creations.push({ index: i, intent, scopePath, scope, source: f });
        continue;
      }
      const target = targets.get(key(f)) ?? { file: f.span.file, facts: f, assigns: new Map<string, Assign>(), intent: i };
      if (intent.type === 'renameId') {
        // Only the literal is rewritten, so a construct that is one of several made by the same `new` would be renamed in all of them.
        if (f.pathsOnSpan > 1) throw new Refusal(i, `${intent.path} is one of ${f.pathsOnSpan} constructs made by the same \`new\` call, so its ID can't be changed for it alone`);
        const problem = constructIdProblem(intent.newId, []);
        if (problem) throw new Refusal(i, problem);
        target.rename = { id: intent.newId, intent: i };
      } else {
        if (intent.prop.length === 0 || !intent.prop.every((p) => IDENTIFIER.test(p))) throw new Refusal(i, `${intent.prop.join('.')} is not a prop name`);
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
    if (removals.size > 0) {
      const service = languageServiceOver(files);
      for (const r of removals.values()) removeNode(r, editOf, files, service);
    }

    const changes: Record<string, TextChange[]> = {};
    for (const [file, edit] of edits) {
      const sorted = edit.finish();
      if (sorted.length === 0) continue;
      const blame = [...targets.values()].find((t) => t.file === file)?.intent ?? creations[0]?.index ?? 0;
      let after: string;
      try {
        after = applyChanges(edit.text, sorted);
      } catch {
        throw new Refusal(blame, `Two of the edits to ${file} touch the same text`);
      }
      const bad = ts.transpileModule(after, { fileName: file, reportDiagnostics: true, compilerOptions: { target: ts.ScriptTarget.Latest } }).diagnostics?.[0];
      if (bad) throw new Refusal(blame, `The edit would leave ${file} with a syntax error: ${ts.flattenDiagnosticMessageText(bad.messageText, '\n')}`);
      changes[file] = sorted;
    }
    return { ok: true, changes };
  } catch (err) {
    if (err instanceof Refusal) return { ok: false, intent: err.intent, reason: err.message, ...(err.uses ? { uses: err.uses } : {}) };
    throw err;
  }
}
