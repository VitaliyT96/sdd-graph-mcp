import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TsAstExtractor } from '../src/parser/ts-extractor.ts';
import { FiberGraphStore } from '../src/db/fiber-store.ts';

describe('TsAstExtractor + PathResolver (web-tree-sitter + oxc-resolver)', () => {
  let fixtureDir: string;
  let extractor: TsAstExtractor;

  const FILES = {
    tsconfig: 'tsconfig.json',
    typesAuth: 'src/types/auth.ts',
    apiAuth: 'src/api/auth.ts',
    useAuth: 'src/hooks/useAuth.ts',
    uiButton: 'src/ui/Button.tsx',
    uiIndex: 'src/ui/index.ts',
    userCard: 'src/components/UserCard.tsx',
  } as const;

  before(async () => {
    fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdd-ast-fixture-'));

    const writeFixture = (relPath: string, content: string) => {
      const fullPath = path.join(fixtureDir, relPath);
      fs.mkdirSync(path.dirname(fullPath), { recursive: true });
      fs.writeFileSync(fullPath, content, 'utf8');
    };

    // 1. tsconfig.json with @/* path alias
    writeFixture(
      FILES.tsconfig,
      JSON.stringify(
        {
          compilerOptions: {
            target: 'ES2022',
            module: 'ESNext',
            moduleResolution: 'bundler',
            jsx: 'react-jsx',
            baseUrl: '.',
            paths: {
              '@/*': ['./src/*'],
            },
          },
        },
        null,
        2
      )
    );

    // 2. src/types/auth.ts (interface + type_alias)
    writeFixture(
      FILES.typesAuth,
      [
        'export type UserRole = "admin" | "member" | "guest";', // L1
        '', // L2
        '/**', // L3
        ' * Authenticated user session payload.', // L4
        ' */', // L5
        'export interface SessionPayload {', // L6
        '  userId: string;', // L7
        '  role: UserRole;', // L8
        '}', // L9
      ].join('\n')
    );

    // 3. src/api/auth.ts (function calling/using types via @/ alias)
    writeFixture(
      FILES.apiAuth,
      [
        'import type { SessionPayload, UserRole } from "@/types/auth";', // L1
        '', // L2
        '/**', // L3
        ' * Verifies raw bearer token and returns decoded SessionPayload.', // L4
        ' */', // L5
        'export function verifyToken(token: string, requiredRole?: UserRole): SessionPayload | null {', // L6
        '  if (!token) return null;', // L7
        '  return { userId: "u_1", role: requiredRole ?? "member" };', // L8
        '}', // L9
      ].join('\n')
    );

    // 4. src/hooks/useAuth.ts (React hook calling verifyToken)
    writeFixture(
      FILES.useAuth,
      [
        'import { verifyToken } from "../api/auth";', // L1
        'import type { SessionPayload } from "@/types/auth";', // L2
        '', // L3
        '/**', // L4
        ' * Custom hook returning verified session state.', // L5
        ' */', // L6
        'export const useAuth = (rawToken: string): SessionPayload | null => {', // L7
        '  const session = verifyToken(rawToken);', // L8
        '  return session;', // L9
        '};', // L10
      ].join('\n')
    );

    // 5. src/ui/Button.tsx (React component wrapped in forwardRef)
    writeFixture(
      FILES.uiButton,
      [
        'export interface ButtonProps {', // L1
        '  label: string;', // L2
        '  disabled?: boolean;', // L3
        '}', // L4
        '', // L5
        'export const ActionButton = forwardRef<HTMLButtonElement, ButtonProps>((props, ref) => {', // L6
        '  return <button ref={ref} disabled={props.disabled}>{props.label}</button>;', // L7
        '});', // L8
      ].join('\n')
    );

    // 6. src/ui/index.ts (Barrel file with export * from './Button')
    writeFixture(
      FILES.uiIndex,
      [
        'export * from "./Button";', // L1
      ].join('\n')
    );

    // 7. src/components/UserCard.tsx (React component importing via @/ui barrel + @/hooks/useAuth)
    writeFixture(
      FILES.userCard,
      [
        'import { useAuth } from "@/hooks/useAuth";', // L1
        'import { ActionButton } from "@/ui";', // L2
        'import type { SessionPayload } from "@/types/auth";', // L3
        '', // L4
        'export interface UserCardProps {', // L5
        '  token: string;', // L6
        '  fallback?: SessionPayload;', // L7
        '}', // L8
        '', // L9
        '/**', // L10
        ' * Displays user profile card and action button.', // L11
        ' */', // L12
        'export const UserCard = React.memo(({ token, fallback }: UserCardProps) => {', // L13
        '  const current = useAuth(token) ?? fallback;', // L14
        '  return (', // L15
        '    <section>', // L16
        '      <ActionButton label={current ? current.userId : "Sign In"} />', // L17
        '    </section>', // L18
        '  );', // L19
        '});', // L20
      ].join('\n')
    );

    extractor = new TsAstExtractor(fixtureDir);
    await extractor.init();
  });

  after(() => {
    if (fixtureDir && fs.existsSync(fixtureDir)) {
      fs.rmSync(fixtureDir, { recursive: true, force: true });
    }
  });

  it('1. extracts all 5 node kinds (function, component, hook, interface, type_alias) with signatures, hashes, and JSDoc', async () => {
    const project = await extractor.extractProject(
      [
        FILES.typesAuth,
        FILES.apiAuth,
        FILES.useAuth,
        FILES.uiButton,
        FILES.uiIndex,
        FILES.userCard,
      ],
      'CURRENT'
    );

    const nodesById = new Map(project.nodes.map((n) => [n.node_id, n]));

    // Check all expected canonical node IDs and kinds
    const userRole = nodesById.get('src/types/auth.ts::UserRole#type_alias');
    assert.ok(userRole, 'Expected UserRole#type_alias');
    assert.equal(userRole.kind, 'type_alias');
    assert.equal(userRole.body_hash, null);

    const sessionPayload = nodesById.get(
      'src/types/auth.ts::SessionPayload#interface'
    );
    assert.ok(sessionPayload, 'Expected SessionPayload#interface');
    assert.equal(sessionPayload.kind, 'interface');
    assert.equal(
      sessionPayload.jsdoc_summary,
      'Authenticated user session payload.'
    );
    assert.equal(sessionPayload.body_hash, null);

    const verifyToken = nodesById.get('src/api/auth.ts::verifyToken#function');
    assert.ok(verifyToken, 'Expected verifyToken#function');
    assert.equal(verifyToken.kind, 'function');
    assert.equal(
      verifyToken.signature,
      'export function verifyToken(token: string, requiredRole?: UserRole): SessionPayload | null'
    );
    assert.ok(verifyToken.body_hash, 'Function must have non-null body_hash');

    const useAuth = nodesById.get('src/hooks/useAuth.ts::useAuth#hook');
    assert.ok(useAuth, 'Expected useAuth#hook');
    assert.equal(useAuth.kind, 'hook');
    assert.equal(
      useAuth.signature,
      'export const useAuth = (rawToken: string): SessionPayload | null'
    );
    assert.ok(useAuth.body_hash, 'Hook must have non-null body_hash');

    const actionBtn = nodesById.get('src/ui/Button.tsx::ActionButton#component');
    assert.ok(actionBtn, 'Expected ActionButton#component (forwardRef)');
    assert.equal(actionBtn.kind, 'component');

    const userCard = nodesById.get(
      'src/components/UserCard.tsx::UserCard#component'
    );
    assert.ok(userCard, 'Expected UserCard#component (React.memo)');
    assert.equal(userCard.kind, 'component');
    assert.equal(
      userCard.jsdoc_summary,
      'Displays user profile card and action button.'
    );
  });

  it('2. resolves tsconfig @/* aliases, unwraps barrel index.ts exports, and records IMPORTS, CALLS, RENDERS_JSX, USES_TYPE with exact call_site_line', async () => {
    const project = await extractor.extractProject(
      [
        FILES.typesAuth,
        FILES.apiAuth,
        FILES.useAuth,
        FILES.uiButton,
        FILES.uiIndex,
        FILES.userCard,
      ],
      'CURRENT'
    );

    const findEdge = (
      sourceId: string,
      targetId: string,
      edgeType: string
    ) =>
      project.edges.find(
        (e) =>
          e.source_id === sourceId &&
          e.target_id === targetId &&
          e.edge_type === edgeType
      );

    // 1. USES_TYPE: SessionPayload -> UserRole @L8
    const payloadUsesRole = findEdge(
      'src/types/auth.ts::SessionPayload#interface',
      'src/types/auth.ts::UserRole#type_alias',
      'USES_TYPE'
    );
    assert.ok(payloadUsesRole, 'Expected SessionPayload USES_TYPE UserRole');
    assert.equal(payloadUsesRole.call_site_line, 8);

    // 2. CALLS + IMPORTS: useAuth -> verifyToken (CALLS @L8, IMPORTS @L1)
    const hookCallsVerify = findEdge(
      'src/hooks/useAuth.ts::useAuth#hook',
      'src/api/auth.ts::verifyToken#function',
      'CALLS'
    );
    assert.ok(hookCallsVerify, 'Expected useAuth CALLS verifyToken');
    assert.equal(hookCallsVerify.call_site_line, 8);

    const hookImportsVerify = findEdge(
      'src/hooks/useAuth.ts::useAuth#hook',
      'src/api/auth.ts::verifyToken#function',
      'IMPORTS'
    );
    assert.ok(hookImportsVerify, 'Expected useAuth IMPORTS verifyToken');
    assert.equal(hookImportsVerify.call_site_line, 1);

    // 3. RENDERS_JSX + IMPORTS through barrel `src/ui/index.ts` (`export * from './Button'`):
    // UserCard -> ActionButton (RENDERS_JSX @L17, IMPORTS @L2, BARREL_UNWRAPPED)
    const cardRendersBtn = findEdge(
      'src/components/UserCard.tsx::UserCard#component',
      'src/ui/Button.tsx::ActionButton#component',
      'RENDERS_JSX'
    );
    assert.ok(
      cardRendersBtn,
      'Expected UserCard RENDERS_JSX ActionButton unwrapped through src/ui/index.ts barrel'
    );
    assert.equal(cardRendersBtn.call_site_line, 17);
    assert.equal(cardRendersBtn.resolution_mode, 'BARREL_UNWRAPPED');

    const cardImportsBtn = findEdge(
      'src/components/UserCard.tsx::UserCard#component',
      'src/ui/Button.tsx::ActionButton#component',
      'IMPORTS'
    );
    assert.ok(cardImportsBtn, 'Expected UserCard IMPORTS ActionButton');
    assert.equal(cardImportsBtn.call_site_line, 2);
    assert.equal(cardImportsBtn.resolution_mode, 'BARREL_UNWRAPPED');

    // 4. CALLS from React.memo component: UserCard -> useAuth @L14
    const cardCallsHook = findEdge(
      'src/components/UserCard.tsx::UserCard#component',
      'src/hooks/useAuth.ts::useAuth#hook',
      'CALLS'
    );
    assert.ok(cardCallsHook, 'Expected UserCard CALLS useAuth');
    assert.equal(cardCallsHook.call_site_line, 14);

    // 5. USES_TYPE from React.memo component: UserCard -> UserCardProps @L13
    const cardUsesProps = findEdge(
      'src/components/UserCard.tsx::UserCard#component',
      'src/components/UserCard.tsx::UserCardProps#interface',
      'USES_TYPE'
    );
    assert.ok(cardUsesProps, 'Expected UserCard USES_TYPE UserCardProps');
    assert.equal(cardUsesProps.call_site_line, 13);
  });

  it('3. separates signature_hash from body_hash on real AST edits and integrates with FiberGraphStore Reconciliation', async () => {
    const store = new FiberGraphStore(':memory:');

    // Seed CURRENT layer from fixture AST
    const baseline = await extractor.extractProject(
      [
        FILES.typesAuth,
        FILES.apiAuth,
        FILES.useAuth,
        FILES.uiButton,
        FILES.uiIndex,
        FILES.userCard,
      ],
      'CURRENT'
    );
    store.upsertNodes(baseline.nodes);
    store.upsertEdges(baseline.edges);

    // Case A: Edit ONLY body & comments of verifyToken in WIP (keep signature identical)
    const bodyEditedRes = await extractor.parseFile(
      FILES.apiAuth,
      [
        'import type { SessionPayload, UserRole } from "@/types/auth";',
        'export function verifyToken(token: string, requiredRole?: UserRole): SessionPayload | null {',
        '  // Added internal comment and changed logic',
        '  const trimmed = token.trim();',
        '  if (trimmed.length < 10) return null;',
        '  return { userId: "u_verified", role: requiredRole ?? "admin" };',
        '}',
      ].join('\n'),
      'WIP'
    );

    const wipBodyOnlyNode = bodyEditedRes.symbols[0].node;
    const currNode = store.getNodeInLayer(wipBodyOnlyNode.node_id, 'CURRENT')!;
    assert.equal(
      wipBodyOnlyNode.signature_hash,
      currNode.signature_hash,
      'signature_hash must stay identical when only function body/comments change'
    );
    assert.notEqual(
      wipBodyOnlyNode.body_hash,
      currNode.body_hash,
      'body_hash must change when implementation body changes'
    );

    store.upsertNode(wipBodyOnlyNode);
    assert.equal(
      store.reconcileWip().length,
      0,
      'Body-only AST edit in WIP must produce 0 STALE_CONTRACT'
    );

    // Case B: Edit signature of verifyToken in WIP (make requiredRole mandatory and return Promise)
    const sigEditedRes = await extractor.parseFile(
      FILES.apiAuth,
      [
        'import type { SessionPayload, UserRole } from "@/types/auth";',
        'export async function verifyToken(token: string, requiredRole: UserRole): Promise<SessionPayload | null> {',
        '  return { userId: "u_verified", role: requiredRole };',
        '}',
      ].join('\n'),
      'WIP'
    );

    store.upsertNode(sigEditedRes.symbols[0].node);

    const stale = store.reconcileWip();
    assert.equal(stale.length, 1);
    assert.equal(stale[0].stale_node_id, 'src/hooks/useAuth.ts::useAuth#hook');
    assert.equal(stale[0].broken_at_line, 8);
    assert.equal(stale[0].dependency_type, 'CALLS');
    assert.equal(stale[0].mutation_kind, 'DIRECT_SIGNATURE_MUTATION');

    store.close();
  });
});

describe('Contract normalization of signature_hash (implementation details do not leak into the contract)', () => {
  let dir: string;
  let ex: TsAstExtractor;

  before(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdd-contract-hash-'));
    fs.writeFileSync(path.join(dir, 'tsconfig.json'), '{ "compilerOptions": { "jsx": "react-jsx" } }');
    ex = new TsAstExtractor(dir);
    await ex.init();
  });

  after(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const hashOf = async (src: string, name: string): Promise<string> => {
    const res = await ex.parseFile('src/x.tsx', src);
    const sym = res.symbols.find((s) => s.localName === name);
    assert.ok(sym, `Expected symbol ${name}`);
    return sym.node.signature_hash!;
  };

  it('1. ignores destructuring patterns, default values, parameter names and Prettier trailing commas', async () => {
    const base = await hashOf('export const Btn = ({ a }: BtnProps) => { return <b>{a}</b>; };', 'Btn');
    const variants = [
      'export const Btn = ({ a, b }: BtnProps) => { return <b>{a}{b}</b>; };',
      "export const Btn = ({ a = 'x' }: BtnProps) => { return <b>{a}</b>; };",
      'export const Btn = ({ a, ...rest }: BtnProps) => { return <b {...rest}>{a}</b>; };',
      'export const Btn = (props: BtnProps) => { return <b>{props.a}</b>; };',
      'export const Btn = (\n  { a }: BtnProps,\n) => { return <b>{a}</b>; };',
    ];
    for (const v of variants) {
      assert.equal(await hashOf(v, 'Btn'), base, `Contract hash must not change for:\n${v}`);
    }

    const fnBase = await hashOf('export function verify(token: string, strict?: boolean): boolean { return !!token; }', 'verify');
    const fnRenamed = await hashOf('export function verify(\n  rawToken: string,\n  isStrict?: boolean,\n): boolean { return !!rawToken; }', 'verify');
    assert.equal(fnRenamed, fnBase);
  });

  it('2. still changes on real contract mutations (types, arity, optionality, return type, generics)', async () => {
    const base = await hashOf('export function verify(token: string): boolean { return !!token; }', 'verify');
    const mutations = [
      'export function verify(token: number): boolean { return !!token; }',
      'export function verify(token: string, strict: boolean): boolean { return !!token; }',
      'export function verify(token?: string): boolean { return !!token; }',
      'export function verify(token: string): Promise<boolean> { return Promise.resolve(!!token); }',
      'export async function verify(token: string): boolean { return !!token; }',
    ];
    for (const m of mutations) {
      assert.notEqual(await hashOf(m, 'verify'), base, `Contract hash must change for:\n${m}`);
    }

    const btn = await hashOf('export const Btn = forwardRef<HTMLButtonElement, BtnProps>(({ a }, ref) => { return <b ref={ref}>{a}</b>; });', 'Btn');
    const btnGeneric = await hashOf('export const Btn = forwardRef<HTMLButtonElement, OtherProps>(({ a }, ref) => { return <b ref={ref}>{a}</b>; });', 'Btn');
    const btnDestructured = await hashOf('export const Btn = forwardRef<HTMLButtonElement, BtnProps>(({ a, b = 1, ...rest }, ref) => { return <b ref={ref}>{a}</b>; });', 'Btn');
    assert.notEqual(btnGeneric, btn, 'forwardRef props generic is part of the contract');
    assert.equal(btnDestructured, btn, 'forwardRef inner destructuring is an implementation detail');
  });
});
