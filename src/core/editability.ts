import type { NodeFacts } from './facts.ts';

/** Whether Truss can write a change to a Node's code, and if not, why. */
export type Editability = { editable: true } | { editable: false; reason: string };

const locked = (reason: string): Editability => ({ editable: false, reason });

/**
 * The Node-level lock rules (ADR 0007). A Node is editable when one `new` span makes it, its ID is a
 * literal that matches its path, and no loop, helper or construct class of the app sits between the
 * code and the Node. The reasons are what the canvas shows beside the lock.
 */
export function nodeEditability(path: string, facts: NodeFacts): Editability {
  const { enclosingClass, surround, literalId, pathsOnSpan, external } = facts;
  if (external) return locked('Refers to an existing resource; the app does not create it');
  if (enclosingClass?.kind === 'construct') {
    return locked(`Created inside ${enclosingClass.name}, a construct class of your own`);
  }
  if (surround?.kind === 'loop') return locked('Created in a loop');
  if (surround?.kind === 'helper') return locked(`Created by the helper ${surround.name}`);
  if (literalId === undefined) return locked('Its Construct ID is not a string literal');
  if (path.split('/').at(-1) !== literalId) {
    return locked(`Its Construct ID in the code, "${literalId}", is not the end of its path ${path}`);
  }
  // A Stack or Stage class created more than once puts one path per instance on every span inside it,
  // and an edit in the class body applies to all of them (ADR 0008).
  if (pathsOnSpan > 1 && enclosingClass === undefined) return locked(`The same \`new\` call creates ${pathsOnSpan} constructs`);
  return { editable: true };
}
