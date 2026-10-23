// Turns intents into text changes in the file's own style (ADR 0007). It edits the text and leaves everything else alone.
import ts from '@typescript/typescript6';
import { applyChanges, offsetOf, type TextChange } from '../../core/diff.ts';
import type { Facts, NodeFacts } from '../../core/facts.ts';
import { constructIdProblem } from '../../core/construct-id.ts';
import { onBase, type Intent, type PropValue } from '../../core/intents.ts';
import type { FileSet, PlanResult } from '../../core/ports.ts';
import { isStringLike, literalValue, memberOf, quantityOf } from './syntax.ts';

const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const CDK_LIB = 'aws-cdk-lib';

/** An intent Source can't place. Thrown inside the planner and turned into a refusal at its edge. */
class Refusal extends Error {
  constructor(
    readonly intent: number,
    reason: string,
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
  private readonly newImports: string[] = [];
  private readonly refs = new Map<string, string>();

  constructor(
    readonly file: string,
    readonly text: string,
    readonly sf: ts.SourceFile,
  ) {
    this.newline = text.includes('\r\n') ? '\r\n' : '\n';
    this.quote = quoteStyle(sf);
  }

  change(start: number, end: number, text: string): void {
    this.changes.push({ start, end, text });
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
    if (this.newImports.length > 0) {
      const imports = this.sf.statements.filter(ts.isImportDeclaration);
      const lastImport = imports.at(-1);
      const at = lastImport ? lastImport.getEnd() : 0;
      const lines = this.newImports.join(this.newline);
      this.changes.push({ start: at, end: at, text: lastImport ? this.newline + lines : lines + this.newline, purpose: 'import' });
    }
    return this.changes.sort((a, b) => a.start - b.start);
  }

  indentOf(n: ts.Node): string {
    const start = n.getStart(this.sf);
    const lineStart = this.text.lastIndexOf('\n', start - 1) + 1;
    return /^[ \t]*/.exec(this.text.slice(lineStart))![0];
  }

  private used(name: string): boolean {
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
    const quoted = (m: string) => `${this.importQuote()}${m}${this.importQuote()}`;
    const semi = this.importSemicolon();
    // Named when the module is the root or the file's imports of CDK modules are named; a namespace import otherwise.
    const named = module === CDK_LIB || this.namedStyle();
    const bound = named ? type : alias;
    if (this.used(bound)) throw new Refusal(intent, `The file already uses the name ${bound} for something else, so ${type} can't be imported as it`);
    this.newImports.push(named ? `import { ${type} } from ${quoted(module)}${semi}` : `import * as ${alias} from ${quoted(module)}${semi}`);
    const result = named ? type : `${alias}.${type}`;
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

/** Where an enum of `aws-cdk-lib` is imported from, and what its namespace is called when the file has to import it whole. */
function enumHome(intent: number, fqn: string): { module: string; type: string; alias: string } {
  const parts = fqn.split('.');
  const type = parts.at(-1)!;
  const namespace = parts.length === 3 ? parts[1]! : undefined;
  if (parts[0] !== CDK_LIB || parts.length < 2 || parts.length > 3) throw new Refusal(intent, `Truss only writes enums of ${CDK_LIB}, not ${fqn}`);
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

const key = (f: NodeFacts) => `${f.span.file}:${f.span.start.line}:${f.span.start.col}`;

/** Plans `intents` against `files`, which `facts` were read from. Every intent is checked, and the changes it makes are confined to the `new` call it names (and the file's imports). */
export function planIntents(files: FileSet, facts: Facts, intents: readonly Intent[], parse: (file: string) => ts.SourceFile | undefined): PlanResult {
  try {
    // Edits of one `new` call are planned together, because a later edit may land in an object an earlier one created.
    const targets = new Map<string, Target>();
    for (const [i, intent] of onBase(intents).entries()) {
      const f = facts.nodes[intent.path];
      if (!f) throw new Refusal(i, `There is no construct at ${intent.path} in the code`);
      if (f.external) throw new Refusal(i, `${intent.path} refers to an existing resource; the code doesn't create it`);
      if (f.className !== intent.expect.className || f.literalId !== intent.expect.literalId) {
        throw new Refusal(i, `${intent.path} is no longer ${intent.expect.className} "${intent.expect.literalId}" in the code`);
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
    for (const target of targets.values()) {
      let edit = edits.get(target.file);
      if (!edit) {
        const text = files.get(target.file);
        const sf = parse(target.file);
        if (text === undefined || !sf) throw new Refusal(target.intent, `${target.file} is not among the app's files`);
        edit = new FileEdit(target.file, text, sf);
        edits.set(target.file, edit);
      }
      editNew(edit, target);
    }

    const changes: Record<string, TextChange[]> = {};
    for (const [file, edit] of edits) {
      const sorted = edit.finish();
      if (sorted.length === 0) continue;
      const blame = [...targets.values()].find((t) => t.file === file)!.intent;
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
    if (err instanceof Refusal) return { ok: false, intent: err.intent, reason: err.message };
    throw err;
  }
}
