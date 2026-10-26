// Reads the escape-hatch calls made on a Node's L1 child (CONTEXT.md: Override). Part of `analyse` (ADR 0007).
import ts from '@typescript/typescript6';
import type { NodeFacts, OverrideFacts } from '../../core/facts.ts';
import { bare, type ReferenceReader } from './references.ts';

const OVERRIDE_METHODS = new Set(['addPropertyOverride', 'addOverride', 'addDeletionOverride']);
const MAX_ALIAS_DEPTH = 8;

const isNodeOf = (e: ts.Expression): e is ts.PropertyAccessExpression =>
  ts.isPropertyAccessExpression(e) && e.name.text === 'node';

/** The span key of the Node whose child an expression is: `x.node.defaultChild`, `x.node.findChild('Id')`, or a variable or field set to one of them. */
function ownerOf(e: ts.Expression, reader: ReferenceReader, depth = 0): string | undefined {
  if (depth > MAX_ALIAS_DEPTH) return undefined;
  e = bare(e);
  if (ts.isPropertyAccessExpression(e) && e.name.text === 'defaultChild' && isNodeOf(bare(e.expression)))
    return reader.valueOf((bare(e.expression) as ts.PropertyAccessExpression).expression, 0);
  if (ts.isCallExpression(e)) {
    const callee = bare(e.expression);
    if (
      ts.isPropertyAccessExpression(callee) &&
      (callee.name.text === 'findChild' || callee.name.text === 'tryFindChild') &&
      isNodeOf(bare(callee.expression))
    )
      return reader.valueOf((bare(callee.expression) as ts.PropertyAccessExpression).expression, 0);
    return undefined;
  }
  const init = reader.initOf(e);
  return init ? ownerOf(init, reader, depth + 1) : undefined;
}

/** The override calls in `files` whose receiver traces to the default child, or a child found by ID, of a Node of the code. */
export function readOverrides(
  nodes: Readonly<Record<string, NodeFacts>>,
  files: Iterable<string>,
  parse: (file: string) => ts.SourceFile | undefined,
  reader: ReferenceReader,
): OverrideFacts[] {
  const out: OverrideFacts[] = [];
  for (const file of files) {
    const sf = parse(file);
    if (!sf) continue;
    const visit = (n: ts.Node) => {
      if (ts.isExpressionStatement(n)) read(sf, file, n);
      ts.forEachChild(n, visit);
    };
    const read = (sf: ts.SourceFile, file: string, st: ts.ExpressionStatement) => {
      const call = bare(st.expression);
      if (!ts.isCallExpression(call)) return;
      const callee = bare(call.expression);
      if (!ts.isPropertyAccessExpression(callee) || !OVERRIDE_METHODS.has(callee.name.text)) return;
      const owner = ownerOf(callee.expression, reader);
      if (owner === undefined) return;
      const start = sf.getLineAndCharacterOfPosition(st.getStart(sf));
      const end = sf.getLineAndCharacterOfPosition(st.getEnd());
      for (const node of (reader.bySpan.get(owner) ?? []).filter((p) => nodes[p])) {
        out.push({
          node,
          method: callee.name.text,
          text: st.getText(sf),
          span: {
            file,
            start: { line: start.line + 1, col: start.character + 1 },
            end: { line: end.line + 1, col: end.character + 1 },
          },
        });
      }
    };
    visit(sf);
  }
  return out;
}
