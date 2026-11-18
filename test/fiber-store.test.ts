import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { FiberGraphStore, computeHash } from '../src/db/fiber-store.ts';

describe('FiberGraphStore (React Fiber CoW CURRENT/WIP Pattern)', () => {
  let store: FiberGraphStore;

  const NODE_IDS = {
    sessionPayload: 'src/types/auth.ts::SessionPayload#interface',
    authGuardProps: 'src/components/UserGuard.tsx::AuthGuardProps#interface',
    verifyToken: 'src/api/auth.ts::verifyToken#function',
    userGuard: 'src/components/UserGuard.tsx::UserGuard#component',
    useSession: 'src/hooks/useSession.ts::useSession#hook',
    legacyHelper: 'src/utils/legacy.ts::legacyFormat#function',
  } as const;

  const SIG_V1 = {
    sessionPayload: 'export interface SessionPayload { userId: string; exp: number }',
    authGuardProps: 'export interface AuthGuardProps { session: SessionPayload; fallbackUrl: string }',
    verifyToken: 'export function verifyToken(token: string): SessionPayload | null',
    userGuard: 'export function UserGuard(props: AuthGuardProps): JSX.Element',
    useSession: 'export function useSession(): { verify: typeof verifyToken }',
    legacyHelper: 'export function legacyFormat(val: string): string',
  } as const;

  beforeEach(() => {
    store = new FiberGraphStore(':memory:');

    // Seed baseline CURRENT graph
    store.upsertNodes([
      {
        node_id: NODE_IDS.sessionPayload,
        layer: 'CURRENT',
        kind: 'interface',
        name: 'SessionPayload',
        file_path: 'src/types/auth.ts',
        start_line: 1,
        end_line: 4,
        signature: SIG_V1.sessionPayload,
        signature_hash: computeHash(SIG_V1.sessionPayload),
        body_hash: null,
        jsdoc_summary: 'JWT session payload contract',
        is_exported: 1,
      },
      {
        node_id: NODE_IDS.authGuardProps,
        layer: 'CURRENT',
        kind: 'interface',
        name: 'AuthGuardProps',
        file_path: 'src/components/UserGuard.tsx',
        start_line: 5,
        end_line: 8,
        signature: SIG_V1.authGuardProps,
        signature_hash: computeHash(SIG_V1.authGuardProps),
        body_hash: null,
        jsdoc_summary: 'Props for UserGuard component',
        is_exported: 1,
      },
      {
        node_id: NODE_IDS.verifyToken,
        layer: 'CURRENT',
        kind: 'function',
        name: 'verifyToken',
        file_path: 'src/api/auth.ts',
        start_line: 10,
        end_line: 25,
        signature: SIG_V1.verifyToken,
        signature_hash: computeHash(SIG_V1.verifyToken),
        body_hash: computeHash('return jwt.decode(token);'),
        jsdoc_summary: 'Verifies JWT token and returns payload',
        is_exported: 1,
      },
      {
        node_id: NODE_IDS.userGuard,
        layer: 'CURRENT',
        kind: 'component',
        name: 'UserGuard',
        file_path: 'src/components/UserGuard.tsx',
        start_line: 12,
        end_line: 42,
        signature: SIG_V1.userGuard,
        signature_hash: computeHash(SIG_V1.userGuard),
        body_hash: computeHash('const valid = verifyToken(token); return <div/>;'),
        jsdoc_summary: 'Route guard component protecting private pages',
        is_exported: 1,
      },
      {
        node_id: NODE_IDS.useSession,
        layer: 'CURRENT',
        kind: 'hook',
        name: 'useSession',
        file_path: 'src/hooks/useSession.ts',
        start_line: 4,
        end_line: 18,
        signature: SIG_V1.useSession,
        signature_hash: computeHash(SIG_V1.useSession),
        body_hash: computeHash('return { verify: verifyToken };'),
        jsdoc_summary: 'React hook exposing session verification',
        is_exported: 1,
      },
      {
        node_id: NODE_IDS.legacyHelper,
        layer: 'CURRENT',
        kind: 'function',
        name: 'legacyFormat',
        file_path: 'src/utils/legacy.ts',
        start_line: 1,
        end_line: 5,
        signature: SIG_V1.legacyHelper,
        signature_hash: computeHash(SIG_V1.legacyHelper),
        body_hash: computeHash('return val.trim();'),
        jsdoc_summary: 'Deprecated string formatter',
        is_exported: 1,
      },
    ]);

    // Seed baseline CURRENT edges:
    // 1. verifyToken --[USES_TYPE]--> SessionPayload
    // 2. AuthGuardProps --[USES_TYPE]--> SessionPayload
    // 3. UserGuard --[USES_TYPE]--> AuthGuardProps
    // 4. UserGuard --[CALLS @L24]--> verifyToken
    // 5. useSession --[CALLS @L11]--> verifyToken
    store.upsertEdges([
      {
        source_id: NODE_IDS.verifyToken,
        target_id: NODE_IDS.sessionPayload,
        edge_type: 'USES_TYPE',
        layer: 'CURRENT',
        call_site_line: 10,
        expected_target_hash: computeHash(SIG_V1.sessionPayload),
      },
      {
        source_id: NODE_IDS.authGuardProps,
        target_id: NODE_IDS.sessionPayload,
        edge_type: 'USES_TYPE',
        layer: 'CURRENT',
        call_site_line: 6,
        expected_target_hash: computeHash(SIG_V1.sessionPayload),
      },
      {
        source_id: NODE_IDS.userGuard,
        target_id: NODE_IDS.authGuardProps,
        edge_type: 'USES_TYPE',
        layer: 'CURRENT',
        call_site_line: 12,
        expected_target_hash: computeHash(SIG_V1.authGuardProps),
      },
      {
        source_id: NODE_IDS.userGuard,
        target_id: NODE_IDS.verifyToken,
        edge_type: 'CALLS',
        layer: 'CURRENT',
        call_site_line: 24,
        expected_target_hash: computeHash(SIG_V1.verifyToken),
      },
      {
        source_id: NODE_IDS.useSession,
        target_id: NODE_IDS.verifyToken,
        edge_type: 'CALLS',
        layer: 'CURRENT',
        call_site_line: 11,
        expected_target_hash: computeHash(SIG_V1.verifyToken),
      },
    ]);
  });

  afterEach(() => {
    store.close();
  });

  it('1. queries k-hop virtual subgraph on CURRENT and uses index-only B-Tree lookups (no SCAN TABLE)', () => {
    const subgraph = store.querySubgraph(NODE_IDS.verifyToken, 1);

    // At 1 hop from verifyToken:
    // hop 0: verifyToken
    // hop 1: SessionPayload (OUTBOUND:USES_TYPE), UserGuard (INBOUND:CALLS), useSession (INBOUND:CALLS)
    assert.equal(subgraph.length, 4);
    assert.equal(subgraph[0].node_id, NODE_IDS.verifyToken);
    assert.equal(subgraph[0].hop_distance, 0);
    assert.equal(subgraph[0].active_layer, 'CURRENT');

    const hop1Ids = subgraph.slice(1).map((n) => n.node_id);
    // Deterministic lexicographical ordering within same hop_distance
    assert.deepEqual(hop1Ids, [
      NODE_IDS.userGuard,
      NODE_IDS.useSession,
      NODE_IDS.sessionPayload,
    ]);

    // Verify EXPLAIN QUERY PLAN has zero full table scans on nodes or edges
    const plan = store.explainQuerySubgraph(NODE_IDS.verifyToken, 2);
    const hasTableScan = plan.some(
      (line) => line.includes('SCAN nodes') || line.includes('SCAN edges')
    );
    assert.equal(
      hasTableScan,
      false,
      `Expected index-only lookups without SCAN nodes/edges, got plan:\n${plan.join('\n')}`
    );
  });

  it('2. does NOT trigger STALE_CONTRACT when only body_hash changes in WIP (signature_hash unchanged)', () => {
    // Mutate only the internal implementation body of verifyToken in WIP
    store.upsertNode({
      node_id: NODE_IDS.verifyToken,
      layer: 'WIP',
      kind: 'function',
      name: 'verifyToken',
      file_path: 'src/api/auth.ts',
      start_line: 10,
      end_line: 28,
      signature: SIG_V1.verifyToken, // Same signature!
      signature_hash: computeHash(SIG_V1.verifyToken),
      body_hash: computeHash('return jwt.verify(token, PUBLIC_KEY);'), // Different body_hash!
      jsdoc_summary: 'Verifies JWT token using RS256 public key',
      is_exported: 1,
    });

    const stale = store.reconcileWip();
    assert.equal(
      stale.length,
      0,
      'Body-only mutation must not flag callers as STALE_CONTRACT'
    );
  });

  it('3. detects STALE_CONTRACT in WIP when signature_hash changes, overlays WIP in querySubgraph, and commits cleanly via commitWip()', () => {
    const newVerifySig =
      'export async function verifyToken(token: string, options: { strict: boolean }): Promise<SessionPayload>';
    const oldHash = computeHash(SIG_V1.verifyToken);
    const newHash = computeHash(newVerifySig);

    // Step A: Mutate verifyToken contract in WIP
    store.upsertNode({
      node_id: NODE_IDS.verifyToken,
      layer: 'WIP',
      kind: 'function',
      name: 'verifyToken',
      file_path: 'src/api/auth.ts',
      start_line: 10,
      end_line: 30,
      signature: newVerifySig,
      signature_hash: newHash,
      body_hash: computeHash('return await verifyAsync(token, options.strict);'),
      jsdoc_summary: 'Async verification with strict mode contract',
      is_exported: 1,
    });

    // Baseline CURRENT must remain untouched (Copy-on-Write isolation)
    const currentRecord = store.getNodeInLayer(NODE_IDS.verifyToken, 'CURRENT');
    assert.equal(currentRecord?.signature, SIG_V1.verifyToken);
    assert.equal(currentRecord?.signature_hash, oldHash);

    // Virtual merged subgraph must transparently overlay WIP over CURRENT
    const mergedSubgraph = store.querySubgraph(NODE_IDS.verifyToken, 1);
    const rootNode = mergedSubgraph[0];
    assert.equal(rootNode.node_id, NODE_IDS.verifyToken);
    assert.equal(rootNode.active_layer, 'WIP');
    assert.equal(rootNode.signature, newVerifySig);
    assert.equal(rootNode.signature_hash, newHash);

    // Step B: Run Reconciliation Phase -> must catch both UserGuard (@L24) and useSession (@L11)
    const staleList = store.reconcileWip();
    assert.equal(staleList.length, 2);

    assert.deepEqual(
      staleList.map((s) => ({
        status: s.status,
        stale_node_id: s.stale_node_id,
        broken_at_line: s.broken_at_line,
        dependency_type: s.dependency_type,
        mutated_target_id: s.mutated_target_id,
        mutation_kind: s.mutation_kind,
        propagation_depth: s.propagation_depth,
        old_sig_hash: s.old_sig_hash,
        new_sig_hash: s.new_sig_hash,
      })),
      [
        {
          status: 'STALE_CONTRACT',
          stale_node_id: NODE_IDS.userGuard,
          broken_at_line: 24,
          dependency_type: 'CALLS',
          mutated_target_id: NODE_IDS.verifyToken,
          mutation_kind: 'DIRECT_SIGNATURE_MUTATION',
          propagation_depth: 1,
          old_sig_hash: oldHash,
          new_sig_hash: newHash,
        },
        {
          status: 'STALE_CONTRACT',
          stale_node_id: NODE_IDS.useSession,
          broken_at_line: 11,
          dependency_type: 'CALLS',
          mutated_target_id: NODE_IDS.verifyToken,
          mutation_kind: 'DIRECT_SIGNATURE_MUTATION',
          propagation_depth: 1,
          old_sig_hash: oldHash,
          new_sig_hash: newHash,
        },
      ]
    );

    // Step C: Update the two callers in WIP to adapt to the new contract
    store.upsertNode({
      node_id: NODE_IDS.userGuard,
      layer: 'WIP',
      kind: 'component',
      name: 'UserGuard',
      file_path: 'src/components/UserGuard.tsx',
      start_line: 12,
      end_line: 45,
      signature: SIG_V1.userGuard,
      body_hash: computeHash('const valid = await verifyToken(token, { strict: true });'),
      is_exported: 1,
    });
    store.upsertEdge({
      source_id: NODE_IDS.userGuard,
      target_id: NODE_IDS.verifyToken,
      edge_type: 'CALLS',
      layer: 'WIP',
      call_site_line: 25,
      expected_target_hash: newHash,
    });

    store.upsertNode({
      node_id: NODE_IDS.useSession,
      layer: 'WIP',
      kind: 'hook',
      name: 'useSession',
      file_path: 'src/hooks/useSession.ts',
      start_line: 4,
      end_line: 20,
      signature: SIG_V1.useSession,
      body_hash: computeHash('return { verify: (t: string) => verifyToken(t, { strict: false }) };'),
      is_exported: 1,
    });
    store.upsertEdge({
      source_id: NODE_IDS.useSession,
      target_id: NODE_IDS.verifyToken,
      edge_type: 'CALLS',
      layer: 'WIP',
      call_site_line: 12,
      expected_target_hash: newHash,
    });

    // Also tombstone legacyHelper in WIP to verify tombstone deletion during commit
    store.tombstoneNode(NODE_IDS.legacyHelper);

    // Now Reconciliation must report 0 broken contracts (Commit Gate passed!)
    const staleAfterFix = store.reconcileWip();
    assert.equal(staleAfterFix.length, 0);

    // Step D: Commit WIP -> CURRENT
    const commitStats = store.commitWip();
    assert.equal(commitStats.promotedNodes, 3);
    assert.equal(commitStats.promotedEdges, 2);
    assert.equal(commitStats.deletedNodes, 1);

    // Verify WIP buffer is now completely empty and CURRENT holds the new state
    const statsAfterCommit = store.getStats();
    assert.equal(statsAfterCommit.wipLiveNodes, 0);
    assert.equal(statsAfterCommit.wipTombstoneNodes, 0);
    assert.equal(statsAfterCommit.wipLiveEdges, 0);
    assert.equal(statsAfterCommit.currentNodes, 5); // 6 initial - 1 tombstoned

    const committedVerify = store.getNodeInLayer(NODE_IDS.verifyToken, 'CURRENT');
    assert.equal(committedVerify?.signature, newVerifySig);
    assert.equal(committedVerify?.signature_hash, newHash);

    const deletedLegacy = store.getEffectiveNode(NODE_IDS.legacyHelper);
    assert.equal(deletedLegacy, null);
  });

  it('4. detects TRANSITIVE_TYPE_CONTRACT_DRIFT (depth = 2) across interfaces and components', () => {
    const newPayloadSig =
      'export interface SessionPayload { userId: string; exp: number; tenantId: string }';

    // Mutate SessionPayload interface in WIP
    store.upsertNode({
      node_id: NODE_IDS.sessionPayload,
      layer: 'WIP',
      kind: 'interface',
      name: 'SessionPayload',
      file_path: 'src/types/auth.ts',
      start_line: 1,
      end_line: 5,
      signature: newPayloadSig,
      is_exported: 1,
    });

    const stale = store.reconcileWip();

    // Depth 1: AuthGuardProps (USES_TYPE SessionPayload) & verifyToken (USES_TYPE SessionPayload)
    // Depth 2: UserGuard (USES_TYPE AuthGuardProps -> transitive drift!)
    const depth1 = stale.filter((s) => s.propagation_depth === 1);
    const depth2 = stale.filter((s) => s.propagation_depth === 2);

    assert.equal(depth1.length, 2);
    assert.equal(depth2.length, 1);
    assert.equal(depth2[0].stale_node_id, NODE_IDS.userGuard);
    assert.equal(depth2[0].mutation_kind, 'TRANSITIVE_TYPE_CONTRACT_DRIFT');
    assert.equal(depth2[0].mutated_target_id, NODE_IDS.authGuardProps);
  });

  it('5. rolls back WIP mutations cleanly via abortWip() without affecting CURRENT', () => {
    store.tombstoneNode(NODE_IDS.verifyToken);

    // Before abort: verifyToken is hidden in effective graph and causes TOMBSTONED_TARGET
    assert.equal(store.getEffectiveNode(NODE_IDS.verifyToken), null);
    const stale = store.reconcileWip();
    assert.equal(stale.length, 2);
    assert.equal(stale[0].mutation_kind, 'TOMBSTONED_TARGET');
    assert.equal(stale[0].new_target_signature, '<DELETED_IN_WIP>');

    // Abort WIP
    const abortRes = store.abortWip();
    assert.equal(abortRes.clearedNodes, 1);

    // After abort: verifyToken is back from CURRENT and 0 stale contracts remain
    const restored = store.getEffectiveNode(NODE_IDS.verifyToken);
    assert.notEqual(restored, null);
    assert.equal(restored?.layer, 'CURRENT');
    assert.equal(store.reconcileWip().length, 0);
  });

  it('6. applies Hub Damping on intermediate OUTBOUND hubs and propagates Props -> Component -> JSX Parent drift (d=2)', () => {
    const hubId = 'src/utils/cn.ts::cn#function';
    const parentPageId = 'src/pages/Dashboard.tsx::DashboardPage#component';

    // Seed a parent page rendering <UserGuard /> and a global hub utility `cn` called by 5 unrelated components
    store.upsertNodes([
      {
        node_id: hubId,
        layer: 'CURRENT',
        kind: 'function',
        name: 'cn',
        file_path: 'src/utils/cn.ts',
        start_line: 1,
        end_line: 3,
        signature: 'export function cn(...inputs: string[]): string',
        is_exported: 1,
      },
      {
        node_id: parentPageId,
        layer: 'CURRENT',
        kind: 'component',
        name: 'DashboardPage',
        file_path: 'src/pages/Dashboard.tsx',
        start_line: 1,
        end_line: 20,
        signature: 'export function DashboardPage(): JSX.Element',
        is_exported: 1,
      },
    ]);

    // UserGuard calls cn, and DashboardPage renders <UserGuard /> at line 14
    store.upsertEdges([
      {
        source_id: NODE_IDS.userGuard,
        target_id: hubId,
        edge_type: 'CALLS',
        layer: 'CURRENT',
        call_site_line: 30,
      },
      {
        source_id: parentPageId,
        target_id: NODE_IDS.userGuard,
        edge_type: 'RENDERS_JSX',
        layer: 'CURRENT',
        call_site_line: 14,
      },
    ]);

    // Add 5 unrelated callers to `cn` so its in-degree is 6
    for (let i = 1; i <= 5; i++) {
      const compId = `src/components/Unrelated${i}.tsx::Unrelated${i}#component`;
      store.upsertNode({
        node_id: compId,
        layer: 'CURRENT',
        kind: 'component',
        name: `Unrelated${i}`,
        file_path: `src/components/Unrelated${i}.tsx`,
        start_line: 1,
        end_line: 10,
        signature: `export const Unrelated${i} = () => JSX.Element`,
        is_exported: 1,
      });
      store.upsertEdge({
        source_id: compId,
        target_id: hubId,
        edge_type: 'CALLS',
        layer: 'CURRENT',
        call_site_line: 5,
      });
    }

    // Without Hub Damping (maxHubInDegree = 100), 2-hop query from UserGuard pulls in all 5 Unrelated components via cn
    const undamped = store.querySubgraph(NODE_IDS.userGuard, 2, 100);
    assert.ok(
      undamped.some((n) => n.name === 'Unrelated1'),
      'Undamped 2-hop query should pull in Unrelated1 through cn'
    );

    // With Hub Damping (maxHubInDegree = 3), 2-hop query from UserGuard includes `cn` at hop=1,
    // but blocks reverse INBOUND expansion from `cn` at hop=2!
    const damped = store.querySubgraph(NODE_IDS.userGuard, 2, 3);
    assert.ok(
      damped.some((n) => n.node_id === hubId && n.hop_distance === 1),
      'Damped query must still include the hub itself at hop=1'
    );
    assert.equal(
      damped.some((n) => n.name.startsWith('Unrelated')),
      false,
      'Damped query must NOT expand reverse INBOUND callers of hub cn at hop=2'
    );

    // Meanwhile, querying `cn` directly as the root seed (hop=0) returns all its callers without restriction
    const directHubQuery = store.querySubgraph(hubId, 1, 3);
    assert.equal(directHubQuery.length, 7); // cn + UserGuard + 5 Unrelated

    // Test Task 2: Mutate AuthGuardProps in WIP -> catches UserGuard at d=1 AND DashboardPage at d=2 (via RENDERS_JSX)
    store.upsertNode({
      node_id: NODE_IDS.authGuardProps,
      layer: 'WIP',
      kind: 'interface',
      name: 'AuthGuardProps',
      file_path: 'src/components/UserGuard.tsx',
      start_line: 5,
      end_line: 9,
      signature:
        'export interface AuthGuardProps { session: SessionPayload; fallbackUrl: string; requiredPerm: string }',
      is_exported: 1,
    });

    const stale = store.reconcileWip();
    const d1 = stale.find((s) => s.propagation_depth === 1);
    const d2 = stale.find((s) => s.propagation_depth === 2);

    assert.ok(d1);
    assert.equal(d1.stale_node_id, NODE_IDS.userGuard);
    assert.equal(d1.dependency_type, 'USES_TYPE');

    assert.ok(d2);
    assert.equal(d2.stale_node_id, parentPageId);
    assert.equal(d2.dependency_type, 'RENDERS_JSX');
    assert.equal(d2.mutation_kind, 'TRANSITIVE_TYPE_CONTRACT_DRIFT');
    assert.equal(d2.broken_at_line, 14);
  });
});

describe('Hub Damping cost is bounded by maxHubInDegree, not by hub in-degree', () => {
  it('1. damps a 3,000-caller hub in well under the unbounded O(in_degree^2) cost', () => {
    const store = new FiberGraphStore(':memory:');
    const N = 3000;
    const fn = (id: string) => ({
      node_id: id,
      layer: 'CURRENT' as const,
      kind: 'function' as const,
      name: id,
      file_path: `${id}.ts`,
      start_line: 1,
      end_line: 2,
      signature: `export function ${id}(): void`,
    });
    store.upsertNodes([fn('hub'), fn('seed'), ...Array.from({ length: N }, (_, i) => fn(`c${i}`))]);
    store.upsertEdges(
      [{ s: 'seed' }, ...Array.from({ length: N }, (_, i) => ({ s: `c${i}` }))].map(({ s }) => ({
        source_id: s,
        target_id: 'hub',
        edge_type: 'CALLS' as const,
        layer: 'CURRENT' as const,
      }))
    );

    const t0 = performance.now();
    const damped = store.querySubgraph('seed', 2, 20);
    const ms = performance.now() - t0;

    assert.deepEqual(damped.map((n) => n.node_id), ['seed', 'hub']);
    // Unbounded COUNT(DISTINCT) took ~800 ms here; the bounded variant takes a few ms.
    assert.ok(ms < 250, `Expected bounded hub check, took ${ms.toFixed(1)} ms`);
    store.close();
  });
});
