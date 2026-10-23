export interface Position {
  line: number;
  col: number;
}

export interface Span {
  file: string;
  start: Position;
  end: Position;
}

/** What the TypeScript source says about one construct path (ADR 0007). */
export interface NodeFacts {
  span: Span;
  /** The class as written, e.g. `s3.Bucket`. */
  className: string;
  /** The Construct ID when it is a string literal. */
  literalId?: string;
  /** How many construct paths were created by this one `new` span. */
  pathsOnSpan: number;
}

/** Facts per construct path. Nothing in here is a syntax tree. */
export interface Facts {
  nodes: Record<string, NodeFacts>;
}
