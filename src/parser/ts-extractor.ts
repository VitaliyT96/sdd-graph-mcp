import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import Parser from 'web-tree-sitter';
import {
  computeHash,
  type EdgeType,
  type GraphEdgeInput,
  type GraphLayer,
  type GraphNodeInput,
  type NodeKind,
  type ResolutionMode,
} from '../db/fiber-store.ts';
import { PathResolver } from './path-resolver.ts';

const require = createRequire(import.meta.url);

type SyntaxNode = Parser.SyntaxNode;

export interface ImportBinding {
  localName: string;
  importedName: string; // 'default', '*', or exported identifier
  sourceSpecifier: string;
  resolvedFilePath: string | null;
  importLine: number;
  isTypeOnly: boolean;
}

export interface ReExportEntry {
  exportedName: string; // '*' for export * from '...', or specific exported name
  localOrOriginalName: string; // '*' or original identifier in target module
  sourceSpecifier: string | null; // null if local export clause `export { a as b }`
  resolvedFilePath: string | null;
  exportLine: number;
}

export interface RawSymbolReference {
  kind: 'CALLS' | 'RENDERS_JSX' | 'USES_TYPE';
  identifier: string;
  namespace?: string;
  line: number;
}

export interface ExtractedSymbol {
  node: GraphNodeInput;
  localName: string;
  exportedNames: Set<string>;
  references: RawSymbolReference[];
}

export interface FileExtractionResult {
  filePath: string; // Project-relative POSIX path
  symbols: ExtractedSymbol[];
  imports: ImportBinding[];
  reExports: ReExportEntry[];
}

export interface ProjectExtractionResult {
  nodes: GraphNodeInput[];
  edges: GraphEdgeInput[];
  files: Map<string, FileExtractionResult>;
}

const BUILTIN_TYPES = new Set([
  'string',
  'number',
  'boolean',
  'bigint',
  'symbol',
  'undefined',
  'null',
  'void',
  'any',
  'unknown',
  'never',
  'object',
  'Promise',
  'Array',
  'ReadonlyArray',
  'Record',
  'Partial',
  'Required',
  'Readonly',
  'Pick',
  'Omit',
  'Exclude',
  'Extract',
  'NonNullable',
  'ReturnType',
  'Parameters',
  'InstanceType',
  'Map',
  'Set',
  'WeakMap',
  'WeakSet',
  'Date',
  'RegExp',
  'Error',
  'React',
  'JSX',
  'Element',
  'ReactNode',
  'ReactElement',
  'FC',
  'FunctionComponent',
  'ComponentType',
  'Ref',
  'ForwardedRef',
  'HTMLInputElement',
  'HTMLDivElement',
  'HTMLButtonElement',
  'HTMLElement',
]);

const COMPONENT_WRAPPER_NAMES = new Set([
  'memo',
  'React.memo',
  'forwardRef',
  'React.forwardRef',
]);

let parserInitPromise: Promise<{
  tsLanguage: Parser.Language;
  tsxLanguage: Parser.Language;
}> | null = null;

async function ensureTreeSitterLanguages(): Promise<{
  tsLanguage: Parser.Language;
  tsxLanguage: Parser.Language;
}> {
  if (!parserInitPromise) {
    parserInitPromise = (async () => {
      await Parser.init();
      const wasmsPkgPath = require.resolve('tree-sitter-wasms/package.json');
      const wasmsOutDir = path.join(path.dirname(wasmsPkgPath), 'out');
      const tsWasmPath = path.join(wasmsOutDir, 'tree-sitter-typescript.wasm');
      const tsxWasmPath = path.join(wasmsOutDir, 'tree-sitter-tsx.wasm');

      const [tsLanguage, tsxLanguage] = await Promise.all([
        Parser.Language.load(tsWasmPath),
        Parser.Language.load(tsxWasmPath),
      ]);
      return { tsLanguage, tsxLanguage };
    })();
  }
  return parserInitPromise;
}

/**
 * Strips AST comment ranges from a slice of source text and collapses whitespace.
 */
function normalizeSourceSlice(
  source: string,
  startIndex: number,
  endIndex: number,
  commentRanges: Array<{ start: number; end: number }>
): string {
  let cursor = startIndex;
  const chunks: string[] = [];

  for (const c of commentRanges) {
    if (c.end <= cursor) continue;
    if (c.start >= endIndex) break;
    if (c.start > cursor) {
      chunks.push(source.slice(cursor, Math.min(c.start, endIndex)));
    }
    cursor = Math.max(cursor, c.end);
  }
  if (cursor < endIndex) {
    chunks.push(source.slice(cursor, endIndex));
  }

  return chunks
    .join(' ')
    .replace(/\s+/g, ' ')
    .replace(/\s*;\s*$/, '')
    .trim();
}

/**
 * Contract hash for callables: parameter binding names, destructuring patterns and default
 * values are implementation details (positional typing), so they are cut out before hashing.
 */
function computeContractHash(
  source: string,
  start: number,
  end: number,
  fnNode: SyntaxNode,
  commentRanges: Array<{ start: number; end: number }>
): string {
  const holes = [...commentRanges];
  for (const param of fnNode.childForFieldName('parameters')?.namedChildren ?? []) {
    for (const field of ['pattern', 'value']) {
      const n = param.childForFieldName(field);
      if (n && n.startIndex >= start && n.endIndex <= end) holes.push({ start: n.startIndex, end: n.endIndex });
    }
  }
  holes.sort((a, b) => a.start - b.start);
  const contract = normalizeSourceSlice(source, start, end, holes)
    .replace(/\s*=>\s*$/, '')
    .replace(/,\s*([)\]}>])/g, '$1') // Prettier trailing commas
    .replace(/\s*([(),:<>{}[\]|&])\s*/g, '$1');
  return computeHash(contract);
}

/**
 * Extracts a concise JSDoc summary immediately preceding a declaration node.
 */
function extractJsDocSummary(node: SyntaxNode): string | null {
  const target =
    node.parent?.type === 'export_statement' ? node.parent : node;
  const prev = target.previousNamedSibling;
  if (!prev || prev.type !== 'comment') {
    return null;
  }
  // Ensure the comment is adjacent (within 2 lines above the declaration)
  if (target.startPosition.row - prev.endPosition.row > 2) {
    return null;
  }
  const text = prev.text.trim();
  if (!text.startsWith('/**')) {
    return null;
  }
  const cleaned = text
    .replace(/^\/\*\*/, '')
    .replace(/\*\/$/, '')
    .split('\n')
    .map((line) => line.replace(/^\s*\*\s?/, '').trim())
    .filter((line) => line.length > 0 && !line.startsWith('@'))
    .join(' ');
  return cleaned.length > 0 ? cleaned : null;
}

function unquoteStringNode(node: SyntaxNode | null): string | null {
  if (!node) return null;
  const frag = node.descendantsOfType('string_fragment')[0];
  if (frag) return frag.text;
  return node.text.replace(/^['"`]|['"`]$/g, '');
}

function containsJsxNodes(node: SyntaxNode): boolean {
  const jsxNodes = node.descendantsOfType([
    'jsx_element',
    'jsx_self_closing_element',
    'jsx_fragment',
  ]);
  return jsxNodes.length > 0;
}

function classifyCallableKind(
  name: string,
  signatureText: string,
  astSubtree: SyntaxNode,
  isWrappedComponent: boolean
): 'function' | 'component' | 'hook' {
  if (/^use[A-Z0-9_]/.test(name)) {
    return 'hook';
  }
  if (/^[A-Z]/.test(name)) {
    if (
      isWrappedComponent ||
      containsJsxNodes(astSubtree) ||
      /\b(JSX\.Element|ReactNode|ReactElement|FC|FunctionComponent|Props)\b/.test(
        signatureText
      )
    ) {
      return 'component';
    }
  }
  return 'function';
}

/**
 * Collects CALLS, RENDERS_JSX, and USES_TYPE symbol references within a declaration's AST subtree.
 */
function collectSymbolReferences(
  declarationNode: SyntaxNode,
  selfName: string,
  wrapperCallNodeId?: number
): RawSymbolReference[] {
  const refs: RawSymbolReference[] = [];

  // 1. USES_TYPE: type_identifier and nested_type_identifier
  const typeNodes = declarationNode.descendantsOfType([
    'type_identifier',
    'nested_type_identifier',
  ]);
  for (const tNode of typeNodes) {
    if (tNode.type === 'nested_type_identifier') {
      const modNode = tNode.childForFieldName('module');
      const nameNode = tNode.childForFieldName('name');
      if (modNode && nameNode && !BUILTIN_TYPES.has(modNode.text)) {
        refs.push({
          kind: 'USES_TYPE',
          namespace: modNode.text,
          identifier: nameNode.text,
          line: tNode.startPosition.row + 1,
        });
      }
      continue;
    }

    // Skip if parent is a nested_type_identifier (already handled above)
    if (tNode.parent?.type === 'nested_type_identifier') {
      continue;
    }
    // Skip declaration's own name (e.g. `interface SessionPayload` or `type UserRole`)
    if (
      (tNode.parent?.type === 'interface_declaration' ||
        tNode.parent?.type === 'type_alias_declaration' ||
        tNode.parent?.type === 'type_parameter') &&
      tNode.parent.childForFieldName('name')?.id === tNode.id
    ) {
      continue;
    }
    const typeName = tNode.text;
    if (typeName === selfName || BUILTIN_TYPES.has(typeName)) {
      continue;
    }
    refs.push({
      kind: 'USES_TYPE',
      identifier: typeName,
      line: tNode.startPosition.row + 1,
    });
  }

  // 2. RENDERS_JSX: jsx_opening_element and jsx_self_closing_element
  const jsxElements = declarationNode.descendantsOfType([
    'jsx_opening_element',
    'jsx_self_closing_element',
  ]);
  for (const jsxEl of jsxElements) {
    const nameNode = jsxEl.childForFieldName('name');
    if (!nameNode) continue;

    if (nameNode.type === 'identifier' && /^[A-Z]/.test(nameNode.text)) {
      refs.push({
        kind: 'RENDERS_JSX',
        identifier: nameNode.text,
        line: nameNode.startPosition.row + 1,
      });
    } else if (
      nameNode.type === 'nested_identifier' ||
      nameNode.type === 'member_expression'
    ) {
      const parts = nameNode.text.split('.');
      if (parts.length === 2) {
        refs.push({
          kind: 'RENDERS_JSX',
          namespace: parts[0],
          identifier: parts[1],
          line: nameNode.startPosition.row + 1,
        });
      }
    }
  }

  // 3. CALLS: call_expression
  const callNodes = declarationNode.descendantsOfType('call_expression');
  for (const callNode of callNodes) {
    if (wrapperCallNodeId !== undefined && callNode.id === wrapperCallNodeId) {
      continue;
    }
    const fnNode = callNode.childForFieldName('function');
    if (!fnNode) continue;

    if (fnNode.type === 'identifier') {
      const callee = fnNode.text;
      if (callee !== selfName && !COMPONENT_WRAPPER_NAMES.has(callee)) {
        refs.push({
          kind: 'CALLS',
          identifier: callee,
          line: fnNode.startPosition.row + 1,
        });
      }
    } else if (fnNode.type === 'member_expression') {
      if (COMPONENT_WRAPPER_NAMES.has(fnNode.text)) {
        continue;
      }
      const objNode = fnNode.childForFieldName('object');
      const propNode = fnNode.childForFieldName('property');
      if (objNode?.type === 'identifier' && propNode) {
        refs.push({
          kind: 'CALLS',
          namespace: objNode.text,
          identifier: propNode.text,
          line: propNode.startPosition.row + 1,
        });
      }
    }
  }

  return refs;
}

/**
 * TypeScript / React CST Extractor & Cross-File Graph Linker.
 * Uses `web-tree-sitter` (TS & TSX grammars) + `oxc-resolver`.
 */
export class TsAstExtractor {
  public readonly pathResolver: PathResolver;
  private tsParser: Parser | null = null;
  private tsxParser: Parser | null = null;

  constructor(projectRoot: string, tsconfigPath?: string) {
    this.pathResolver = new PathResolver({ projectRoot, tsconfigPath });
  }

  public clearResolverCache(): void {
    this.pathResolver.clearCache();
  }

  public toPosixPath(filePath: string): string {
    return this.pathResolver.toPosixPath(filePath);
  }

  public async init(): Promise<void> {
    if (this.tsParser && this.tsxParser) return;
    const { tsLanguage, tsxLanguage } = await ensureTreeSitterLanguages();
    this.tsParser = new Parser();
    this.tsParser.setLanguage(tsLanguage);
    this.tsxParser = new Parser();
    this.tsxParser.setLanguage(tsxLanguage);
  }

  /**
   * Pass 1 (Single File): Parses a .ts/.tsx file and extracts symbols, signatures, body hashes,
   * imports (resolved via oxc-resolver), re-exports, and intra-symbol AST references.
   */
  public async parseFile(
    filePath: string,
    content?: string,
    layer: GraphLayer = 'CURRENT'
  ): Promise<FileExtractionResult> {
    await this.init();

    const absPath = path.isAbsolute(filePath)
      ? filePath
      : path.resolve(this.pathResolver.projectRoot, filePath);
    const relPosixPath = this.pathResolver.toPosixPath(absPath);
    const sourceCode = content ?? fs.readFileSync(absPath, 'utf8');

    const isTsx = relPosixPath.endsWith('.tsx') || relPosixPath.endsWith('.jsx');
    const parser = isTsx ? this.tsxParser! : this.tsParser!;
    const tree = parser.parse(sourceCode);
    try {
      const root = tree.rootNode;

      const commentRanges = root
        .descendantsOfType('comment')
        .map((c) => ({ start: c.startIndex, end: c.endIndex }));

      const imports: ImportBinding[] = [];
      const reExports: ReExportEntry[] = [];
      const symbols: ExtractedSymbol[] = [];
      const symbolsByName = new Map<string, ExtractedSymbol>();

      const registerSymbol = (sym: ExtractedSymbol) => {
        symbols.push(sym);
        symbolsByName.set(sym.localName, sym);
      };

      for (const stmt of root.namedChildren) {
        // 1. IMPORT STATEMENTS
        if (stmt.type === 'import_statement') {
          const sourceNode = stmt.childForFieldName('source');
          const specifier = unquoteStringNode(sourceNode);
          if (!specifier) continue;

          const resolvedFilePath = this.pathResolver.resolveImport(
            absPath,
            specifier
          );
          const importLine = stmt.startPosition.row + 1;
          const isStmtTypeOnly = /^import\s+type\b/.test(stmt.text.trim());

          const importClause = stmt.namedChildren.find(
            (c) => c.type === 'import_clause'
          );
          if (!importClause) continue;

          for (const clauseChild of importClause.namedChildren) {
            if (clauseChild.type === 'identifier') {
              // Default import: `import Button from './Button'`
              imports.push({
                localName: clauseChild.text,
                importedName: 'default',
                sourceSpecifier: specifier,
                resolvedFilePath,
                importLine,
                isTypeOnly: isStmtTypeOnly,
              });
            } else if (clauseChild.type === 'namespace_import') {
              // Namespace import: `import * as Auth from './auth'`
              const idNode = clauseChild.namedChildren.find(
                (c) => c.type === 'identifier'
              );
              if (idNode) {
                imports.push({
                  localName: idNode.text,
                  importedName: '*',
                  sourceSpecifier: specifier,
                  resolvedFilePath,
                  importLine,
                  isTypeOnly: isStmtTypeOnly,
                });
              }
            } else if (clauseChild.type === 'named_imports') {
              // Named imports: `import { a, b as c, type T } from './mod'`
              const specs = clauseChild.descendantsOfType('import_specifier');
              for (const spec of specs) {
                const nameNode = spec.childForFieldName('name');
                const aliasNode = spec.childForFieldName('alias');
                if (!nameNode) continue;
                const importedName = nameNode.text;
                const localName = aliasNode ? aliasNode.text : importedName;
                const isSpecTypeOnly =
                  isStmtTypeOnly || /^type\s+/.test(spec.text.trim());
                imports.push({
                  localName,
                  importedName,
                  sourceSpecifier: specifier,
                  resolvedFilePath,
                  importLine: spec.startPosition.row + 1,
                  isTypeOnly: isSpecTypeOnly,
                });
              }
            }
          }
          continue;
        }

        // 2. EXPORT / RE-EXPORT STATEMENTS WITHOUT DECLARATION
        if (stmt.type === 'export_statement') {
          const decl = stmt.childForFieldName('declaration');
          const sourceNode = stmt.childForFieldName('source');
          const exportClause = stmt.namedChildren.find(
            (c) => c.type === 'export_clause'
          );
          const namespaceExport = stmt.namedChildren.find(
            (c) => c.type === 'namespace_export'
          );

          if (!decl) {
            const specifier = unquoteStringNode(sourceNode);
            const resolvedFilePath = specifier
              ? this.pathResolver.resolveImport(absPath, specifier)
              : null;
            const exportLine = stmt.startPosition.row + 1;

            if (exportClause) {
              // `export { a, b as c } from './mod'` or `export { a, b as c }`
              const specs = exportClause.descendantsOfType('export_specifier');
              for (const spec of specs) {
                const nameNode = spec.childForFieldName('name');
                const aliasNode = spec.childForFieldName('alias');
                if (!nameNode) continue;
                const origName = nameNode.text;
                const exportedName = aliasNode ? aliasNode.text : origName;
                reExports.push({
                  exportedName,
                  localOrOriginalName: origName,
                  sourceSpecifier: specifier,
                  resolvedFilePath,
                  exportLine: spec.startPosition.row + 1,
                });
              }
            } else if (specifier) {
              // Barrel wildcard re-export: `export * from './Button'` or `export * as UI from './ui'`
              const nsId = namespaceExport?.namedChildren.find(
                (c) => c.type === 'identifier'
              );
              reExports.push({
                exportedName: nsId ? nsId.text : '*',
                localOrOriginalName: '*',
                sourceSpecifier: specifier,
                resolvedFilePath,
                exportLine,
              });
            } else {
              // `export default Identifier;` or `export default React.memo(Identifier);`
              const valNode = stmt.childForFieldName('value');
              if (valNode?.type === 'identifier') {
                reExports.push({
                  exportedName: 'default',
                  localOrOriginalName: valNode.text,
                  sourceSpecifier: null,
                  resolvedFilePath: null,
                  exportLine,
                });
              } else if (valNode?.type === 'call_expression') {
                const fnCallee = valNode.childForFieldName('function');
                if (fnCallee && COMPONENT_WRAPPER_NAMES.has(fnCallee.text)) {
                  const argId = valNode
                    .childForFieldName('arguments')
                    ?.namedChildren.find((c) => c.type === 'identifier');
                  if (argId) {
                    reExports.push({
                      exportedName: 'default',
                      localOrOriginalName: argId.text,
                      sourceSpecifier: null,
                      resolvedFilePath: null,
                      exportLine,
                    });
                  }
                }
              }
            }
            continue;
          }
        }

        // 3. TOP-LEVEL SYMBOL DECLARATIONS (direct or inside export_statement)
        const isExported = stmt.type === 'export_statement';
        const isDefaultExport =
          isExported && /^export\s+default\b/.test(stmt.text.trim());
        const declNode = isExported
          ? stmt.childForFieldName('declaration')
          : stmt;
        if (!declNode) continue;

        const outerNode = isExported ? stmt : declNode;
        const jsdocSummary = extractJsDocSummary(declNode);

        // 3A. INTERFACE OR TYPE ALIAS
        if (
          declNode.type === 'interface_declaration' ||
          declNode.type === 'type_alias_declaration'
        ) {
          const nameNode = declNode.childForFieldName('name');
          if (!nameNode) continue;
          const name = nameNode.text;
          const kind: NodeKind =
            declNode.type === 'interface_declaration' ? 'interface' : 'type_alias';

          const signature = normalizeSourceSlice(
            sourceCode,
            outerNode.startIndex,
            declNode.endIndex,
            commentRanges
          );
          const signatureHash = computeHash(signature);
          const exportedNames = new Set<string>();
          if (isExported) {
            exportedNames.add(name);
            if (isDefaultExport) exportedNames.add('default');
          }

          registerSymbol({
            localName: name,
            exportedNames,
            references: collectSymbolReferences(declNode, name),
            node: {
              node_id: `${relPosixPath}::${name}#${kind}`,
              layer,
              kind,
              name,
              file_path: relPosixPath,
              start_line: outerNode.startPosition.row + 1,
              end_line: outerNode.endPosition.row + 1,
              signature,
              signature_hash: signatureHash,
              body_hash: null,
              jsdoc_summary: jsdocSummary,
              is_exported: isExported ? 1 : 0,
              is_tombstone: 0,
            },
          });
          continue;
        }

        // 3B. FUNCTION DECLARATION (`function verifyToken(...) { ... }`)
        if (declNode.type === 'function_declaration') {
          const nameNode = declNode.childForFieldName('name');
          if (!nameNode) continue;
          const name = nameNode.text;
          const bodyNode = declNode.childForFieldName('body');
          const sigEndIndex = bodyNode ? bodyNode.startIndex : declNode.endIndex;

          const signature = normalizeSourceSlice(
            sourceCode,
            outerNode.startIndex,
            sigEndIndex,
            commentRanges
          );
          const bodyText = bodyNode
            ? normalizeSourceSlice(
                sourceCode,
                bodyNode.startIndex,
                bodyNode.endIndex,
                commentRanges
              )
            : '';
          const kind = classifyCallableKind(name, signature, declNode, false);
          const exportedNames = new Set<string>();
          if (isExported) {
            exportedNames.add(name);
            if (isDefaultExport) exportedNames.add('default');
          }

          registerSymbol({
            localName: name,
            exportedNames,
            references: collectSymbolReferences(declNode, name),
            node: {
              node_id: `${relPosixPath}::${name}#${kind}`,
              layer,
              kind,
              name,
              file_path: relPosixPath,
              start_line: outerNode.startPosition.row + 1,
              end_line: outerNode.endPosition.row + 1,
              signature,
              signature_hash: computeContractHash(sourceCode, outerNode.startIndex, sigEndIndex, declNode, commentRanges),
              body_hash: bodyNode ? computeHash(bodyText) : null,
              jsdoc_summary: jsdocSummary,
              is_exported: isExported ? 1 : 0,
              is_tombstone: 0,
            },
          });
          continue;
        }

        // 3C. LEXICAL / VARIABLE DECLARATION (`export const UserCard = ...`)
        if (
          declNode.type === 'lexical_declaration' ||
          declNode.type === 'variable_declaration'
        ) {
          const declarators = declNode.descendantsOfType('variable_declarator');
          for (const declarator of declarators) {
            // Only process top-level declarators belonging directly to declNode
            if (declarator.parent?.id !== declNode.id) continue;

            const nameNode = declarator.childForFieldName('name');
            const valueNode = declarator.childForFieldName('value');
            if (!nameNode || nameNode.type !== 'identifier' || !valueNode) {
              continue;
            }
            const name = nameNode.text;

            let fnNode: SyntaxNode | null = null;
            let isWrappedComponent = false;
            let wrapperCallNodeId: number | undefined;

            let currentVal: SyntaxNode | null = valueNode;
            while (currentVal) {
              if (
                currentVal.type === 'arrow_function' ||
                currentVal.type === 'function_expression' ||
                currentVal.type === 'function'
              ) {
                fnNode = currentVal;
                break;
              }
              if (currentVal.type === 'call_expression') {
                const calleeNode = currentVal.childForFieldName('function');
                if (calleeNode && COMPONENT_WRAPPER_NAMES.has(calleeNode.text)) {
                  isWrappedComponent = true;
                  wrapperCallNodeId = wrapperCallNodeId ?? currentVal.id;
                  const argsNode = currentVal.childForFieldName('arguments');
                  const nextArg = argsNode?.namedChildren.find(
                    (c) =>
                      c.type === 'arrow_function' ||
                      c.type === 'function_expression' ||
                      c.type === 'function' ||
                      c.type === 'call_expression'
                  );
                  currentVal = nextArg ?? null;
                  continue;
                }
              }
              break;
            }

            if (!fnNode) continue;

            const bodyNode = fnNode.childForFieldName('body');
            const sigEndIndex = bodyNode
              ? bodyNode.startIndex
              : declarator.endIndex;

            const rawSignature = normalizeSourceSlice(
              sourceCode,
              outerNode.startIndex,
              sigEndIndex,
              commentRanges
            )
              .replace(/\s*=>\s*$/, '')
              .trim();

            const bodyText = bodyNode
              ? normalizeSourceSlice(
                  sourceCode,
                  bodyNode.startIndex,
                  bodyNode.endIndex,
                  commentRanges
                )
              : '';

            const kind = classifyCallableKind(
              name,
              rawSignature,
              declarator,
              isWrappedComponent
            );
            const exportedNames = new Set<string>();
            if (isExported) {
              exportedNames.add(name);
              if (isDefaultExport) exportedNames.add('default');
            }

            registerSymbol({
              localName: name,
              exportedNames,
              references: collectSymbolReferences(
                declarator,
                name,
                wrapperCallNodeId
              ),
              node: {
                node_id: `${relPosixPath}::${name}#${kind}`,
                layer,
                kind,
                name,
                file_path: relPosixPath,
                start_line: outerNode.startPosition.row + 1,
                end_line: outerNode.endPosition.row + 1,
                signature: rawSignature,
                signature_hash: computeContractHash(sourceCode, outerNode.startIndex, sigEndIndex, fnNode, commentRanges),
                body_hash: bodyNode ? computeHash(bodyText) : null,
                jsdoc_summary: jsdocSummary,
                is_exported: isExported ? 1 : 0,
                is_tombstone: 0,
              },
            });
          }
        }
      }

      // Apply local export clauses (`export { foo, bar as baz }`) to symbols in the same file
      for (const reExp of reExports) {
        if (!reExp.sourceSpecifier) {
          const localSym = symbolsByName.get(reExp.localOrOriginalName);
          if (localSym) {
            localSym.exportedNames.add(reExp.exportedName);
            localSym.node.is_exported = 1;
          }
        }
      }

      return {
        filePath: relPosixPath,
        symbols,
        imports,
        reExports,
      };
    } finally {
      // WASM heap is not GC-managed: free the tree even if extraction throws
      tree.delete();
    }
  }

  /**
   * Pass 1 + Pass 2 across a set of files:
   * - Parses each file into symbols, imports, and re-exports.
   * - Unwraps barrel files (`export * from ...`, `export { X as Y } from ...`).
   * - Emits IMPORTS, CALLS, RENDERS_JSX, and USES_TYPE edges with `call_site_line` and `expected_target_hash`.
   * - Optionally accepts `fallbackNodesByFile` (from CURRENT layer in SQLite) to resolve edges when parsing partial WIP deltas.
   */
  public async extractProject(
    fileInputs: Array<string | { filePath: string; content?: string }>,
    layer: GraphLayer = 'CURRENT',
    fallbackNodesByFile?: Map<string, GraphNodeInput[]>
  ): Promise<ProjectExtractionResult> {
    const filesMap = new Map<string, FileExtractionResult>();

    for (const item of fileInputs) {
      const filePath = typeof item === 'string' ? item : item.filePath;
      const content = typeof item === 'string' ? undefined : item.content;
      const parsed = await this.parseFile(filePath, content, layer);
      filesMap.set(parsed.filePath, parsed);
    }

    const onDemandCache = new Map<string, FileExtractionResult | null>();

    // Helper to parse on-demand any barrel/target file on disk that wasn't in fileInputs
    const getOrParseFile = async (
      relPosixPath: string
    ): Promise<FileExtractionResult | null> => {
      const existing = filesMap.get(relPosixPath);
      if (existing) return existing;
      if (onDemandCache.has(relPosixPath)) {
        return onDemandCache.get(relPosixPath) ?? null;
      }

      const absCandidate = path.resolve(
        this.pathResolver.projectRoot,
        relPosixPath
      );
      if (!fs.existsSync(absCandidate)) {
        onDemandCache.set(relPosixPath, null);
        return null;
      }
      const parsed = await this.parseFile(absCandidate, undefined, layer);
      onDemandCache.set(relPosixPath, parsed);
      return parsed;
    };

    // Pass 2A: Recursive Barrel & Export Resolver
    const resolveExport = async (
      targetFilePath: string,
      exportedName: string,
      visited: Set<string> = new Set(),
      traversedBarrel: boolean = false
    ): Promise<{
      node: GraphNodeInput;
      resolutionMode: ResolutionMode;
    } | null> => {
      const visitKey = `${targetFilePath}::${exportedName}`;
      if (visited.has(visitKey)) return null;
      visited.add(visitKey);

      // Fast path during incremental WIP sync: if targetFilePath is not being re-parsed
      // and already has the exported symbol in the effective SQLite store, return it directly.
      if (!filesMap.has(targetFilePath) && fallbackNodesByFile) {
        const fallbackList = fallbackNodesByFile.get(targetFilePath);
        const match = fallbackList?.find(
          (n) => n.name === exportedName && n.is_exported
        );
        if (match) {
          return {
            node: match,
            resolutionMode: traversedBarrel ? 'BARREL_UNWRAPPED' : 'AST',
          };
        }
      }

      const fileData = await getOrParseFile(targetFilePath);
      if (fileData) {
        // 1. Check direct exports in targetFilePath
        for (const sym of fileData.symbols) {
          if (
            sym.exportedNames.has(exportedName) ||
            (exportedName === sym.localName && sym.node.is_exported)
          ) {
            return {
              node: sym.node,
              resolutionMode: traversedBarrel ? 'BARREL_UNWRAPPED' : 'AST',
            };
          }
        }

        // 2. Check explicit named re-exports (`export { Orig as Alias } from './mod'`)
        for (const reExp of fileData.reExports) {
          if (
            reExp.sourceSpecifier &&
            reExp.resolvedFilePath &&
            reExp.exportedName === exportedName
          ) {
            const res = await resolveExport(
              reExp.resolvedFilePath,
              reExp.localOrOriginalName,
              visited,
              true
            );
            if (res) return res;
          }
        }

        // 3. Check wildcard barrel re-exports (`export * from './mod'`)
        for (const reExp of fileData.reExports) {
          if (
            reExp.sourceSpecifier &&
            reExp.resolvedFilePath &&
            reExp.exportedName === '*'
          ) {
            const res = await resolveExport(
              reExp.resolvedFilePath,
              exportedName,
              visited,
              true
            );
            if (res) return res;
          }
        }
      }

      // 4. Fallback to pre-existing nodes from SQLite store if provided
      const fallbackList = fallbackNodesByFile?.get(targetFilePath);
      if (fallbackList) {
        const match = fallbackList.find(
          (n) => n.name === exportedName && n.is_exported
        );
        if (match) {
          return {
            node: match,
            resolutionMode: traversedBarrel ? 'BARREL_UNWRAPPED' : 'AST',
          };
        }
      }

      return null;
    };

    // Pass 2B: Link Nodes & Edges for all input files
    const allNodes: GraphNodeInput[] = [];
    const edgeDedup = new Map<string, GraphEdgeInput>();

    const addEdge = (edge: GraphEdgeInput) => {
      if (edge.source_id === edge.target_id) return;
      const key = `${edge.source_id}|${edge.target_id}|${edge.edge_type}|${edge.layer}`;
      const existing = edgeDedup.get(key);
      if (!existing) {
        edgeDedup.set(key, edge);
      } else if (
        edge.call_site_line !== null &&
        edge.call_site_line !== undefined &&
        (existing.call_site_line === null ||
          existing.call_site_line === undefined ||
          edge.call_site_line < existing.call_site_line)
      ) {
        edgeDedup.set(key, edge);
      }
    };

    for (const [, fileData] of filesMap) {
      const localSymbolMap = new Map<string, GraphNodeInput>();
      for (const sym of fileData.symbols) {
        allNodes.push(sym.node);
        localSymbolMap.set(sym.localName, sym.node);
      }

      // Resolve all imports declared at top of fileData
      const resolvedImports = new Map<
        string,
        {
          binding: ImportBinding;
          target: { node: GraphNodeInput; resolutionMode: ResolutionMode } | null;
        }
      >();

      for (const imp of fileData.imports) {
        let target: {
          node: GraphNodeInput;
          resolutionMode: ResolutionMode;
        } | null = null;
        if (imp.resolvedFilePath && imp.importedName !== '*') {
          target = await resolveExport(imp.resolvedFilePath, imp.importedName);
        }
        resolvedImports.set(imp.localName, { binding: imp, target });
      }

      const usedImportLocals = new Set<string>();

      // Resolve references inside each symbol in fileData
      for (const sym of fileData.symbols) {
        for (const ref of sym.references) {
          let resolvedTarget: {
            node: GraphNodeInput;
            resolutionMode: ResolutionMode;
          } | null = null;
          let matchedImport: ImportBinding | null = null;

          if (ref.namespace) {
            // Namespace access e.g. `Auth.verifyToken()` or `<UI.Button />`
            const nsEntry = resolvedImports.get(ref.namespace);
            if (nsEntry?.binding.resolvedFilePath) {
              matchedImport = nsEntry.binding;
              usedImportLocals.add(ref.namespace);
              resolvedTarget = await resolveExport(
                nsEntry.binding.resolvedFilePath,
                ref.identifier
              );
            }
          } else {
            // 1. Check local file symbols first
            const localTarget = localSymbolMap.get(ref.identifier);
            if (localTarget) {
              resolvedTarget = { node: localTarget, resolutionMode: 'AST' };
            } else {
              // 2. Check imported bindings
              const impEntry = resolvedImports.get(ref.identifier);
              if (impEntry?.target) {
                matchedImport = impEntry.binding;
                usedImportLocals.add(ref.identifier);
                resolvedTarget = impEntry.target;
              }
            }
          }

          if (!resolvedTarget) continue;

          const targetNode = resolvedTarget.node;
          const targetSigHash =
            targetNode.signature_hash ?? computeHash(targetNode.signature);

          // Emit the semantic usage edge (CALLS | RENDERS_JSX | USES_TYPE)
          addEdge({
            source_id: sym.node.node_id,
            target_id: targetNode.node_id,
            edge_type: ref.kind as EdgeType,
            layer,
            call_site_line: ref.line,
            resolution_mode: resolvedTarget.resolutionMode,
            expected_target_hash: targetSigHash,
            is_tombstone: 0,
          });

          // If resolved via an import, also emit the IMPORTS edge with the import statement's line
          if (matchedImport) {
            addEdge({
              source_id: sym.node.node_id,
              target_id: targetNode.node_id,
              edge_type: 'IMPORTS',
              layer,
              call_site_line: matchedImport.importLine,
              resolution_mode: resolvedTarget.resolutionMode,
              expected_target_hash: targetSigHash,
              is_tombstone: 0,
            });
          }
        }
      }

      // Attach any remaining resolved imports in the file (not directly called in a body yet)
      // to the primary symbol of the file so no IMPORTS edge is lost.
      const primarySymbol = fileData.symbols[0];
      if (primarySymbol) {
        for (const [localName, entry] of resolvedImports) {
          if (!usedImportLocals.has(localName) && entry.target) {
            const targetNode = entry.target.node;
            const targetSigHash =
              targetNode.signature_hash ?? computeHash(targetNode.signature);
            addEdge({
              source_id: primarySymbol.node.node_id,
              target_id: targetNode.node_id,
              edge_type: 'IMPORTS',
              layer,
              call_site_line: entry.binding.importLine,
              resolution_mode: entry.target.resolutionMode,
              expected_target_hash: targetSigHash,
              is_tombstone: 0,
            });
          }
        }
      }
    }

    return {
      nodes: allNodes,
      edges: Array.from(edgeDedup.values()),
      files: filesMap,
    };
  }
}
