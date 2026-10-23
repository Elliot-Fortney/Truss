export interface Position {
  line: number;
  col: number;
}

export interface Span {
  file: string;
  start: Position;
  end: Position;
}

/** Whether the `new` is assigned to something the code can refer to later. */
export type Binding = 'const' | 'field' | 'none';

/** A class of the app's own whose body holds a `new`. */
export interface EnclosingClass {
  name: string;
  /** `construct` is any other class that ends up extending `Construct`. */
  kind: 'stack' | 'stage' | 'construct';
}

/** The nearest loop or function around a `new`, when it isn't the body of a class constructor. */
export type Surround = { kind: 'loop' } | { kind: 'helper'; name: string };

export interface PropFacts {
  name: string;
  /** `literal` is a string, number, boolean, `null` or plain template; anything else is an `expression`. */
  kind: 'literal' | 'expression';
  /** The prop's value exactly as written. */
  text: string;
}

/** The props argument: an object literal Truss can read prop by prop, or anything else (a variable, a call). */
export type PropsFacts = { form: 'object'; props: PropFacts[] } | { form: 'other'; text: string };

/** What the TypeScript source says about one construct path (ADR 0007). */
export interface NodeFacts {
  span: Span;
  /** The class as written, e.g. `s3.Bucket`. */
  className: string;
  /** The Construct ID when it is a string literal. */
  literalId?: string;
  /** How many construct paths were created by this one `new` span. */
  pathsOnSpan: number;
  binding: Binding;
  /** Absent when the `new` is outside any class, as a Stack is in `bin/app.ts`. */
  enclosingClass?: EnclosingClass;
  surround?: Surround;
  /** Absent when the `new` passes no props. */
  props?: PropsFacts;
}

/** Facts per construct path. Nothing in here is a syntax tree. */
export interface Facts {
  nodes: Record<string, NodeFacts>;
}
