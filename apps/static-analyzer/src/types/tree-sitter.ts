/**
 * Tree-sitter position (0-based row/column).
 */
export interface TreeSitterPosition {
  readonly row: number;
  readonly column: number;
}

/**
 * Tree-sitter AST node. All properties are optional because tree-sitter's
 * runtime guarantees only `type`; the rest may be absent on anonymous /
 * error nodes. Callers already use optional-chaining (`?.`) or fallbacks
 * (`|| []`), so this matches the existing defensive patterns.
 */
export interface TreeSitterNode {
  readonly type: string;
  readonly text?: string;
  readonly startPosition?: TreeSitterPosition;
  readonly endPosition?: TreeSitterPosition;
  readonly startIndex?: number;
  readonly endIndex?: number;
  readonly children?: readonly TreeSitterNode[];
  readonly namedChildren?: readonly TreeSitterNode[];
  childForFieldName?(name: string): TreeSitterNode | null;
}

/**
 * A parsed tree-sitter tree — the result of `parser.parse(content)`.
 */
export interface TreeSitterTree {
  readonly rootNode: TreeSitterNode;
}

/**
 * A tree-sitter parser instance. Covers `tree-sitter`'s JS API surface
 * actually used by CParserService (`setLanguage`, `parse`).
 */
export interface TreeSitterParser {
  setLanguage(language: unknown): void;
  parse(content: string): TreeSitterTree;
}
