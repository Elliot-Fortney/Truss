// The only module that imports `typescript` (ADR 0007). Nothing that leaves it is a syntax tree.
import ts from '@typescript/typescript6';
import type { Assembly, Frame, TreeNode } from '../../core/assembly.ts';
import type { Facts, NodeFacts, Span } from '../../core/facts.ts';
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
   * creation stack (an L2 container) takes the frame its descendants agree on. Only the shallowest
   * path on a frame is kept, because the paths beneath it are that construct's own children.
   */
  private collectFrames(
    node: TreeNode,
    assembly: Assembly,
    stacks: Set<string>,
    parentFrame: Frame | undefined,
    out: Map<string, Frame>,
  ): void {
    // A stack is only ever where its own `new` call is; borrowing its children's frame would hide them.
    const borrowed = node.path === '' || stacks.has(node.path) ? undefined : agreedFrame(node, assembly);
    const frame = assembly.creation[node.path]?.[0] ?? borrowed;
    if (node.path !== '' && frame && (!parentFrame || frameKey(parentFrame) !== frameKey(frame))) {
      out.set(node.path, frame);
    }
    for (const child of node.children) this.collectFrames(child, assembly, stacks, frame, out);
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
    return {
      span: spanOf(sf, found, frame.file),
      className: found.expression.getText(sf),
      ...(literalId !== undefined ? { literalId } : {}),
    };
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

function spanOf(sf: ts.SourceFile, n: ts.Node, file: string): Span {
  const pos = (offset: number) => {
    const { line, character } = sf.getLineAndCharacterOfPosition(offset);
    return { line: line + 1, col: character + 1 };
  };
  return { file, start: pos(n.getStart(sf)), end: pos(n.getEnd()) };
}
