import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { FiberGraphStore } from '../src/db/fiber-store.ts';
import { GraphIndexer } from '../src/indexer/graph-indexer.ts';

describe('GraphIndexer (Full CURRENT Baseline & Incremental WIP Sync via git status / file list)', () => {
  let repoDir: string;
  let store: FiberGraphStore;
  let indexer: GraphIndexer;

  const writeRepoFile = (relPath: string, lines: string[]) => {
    const absPath = path.join(repoDir, relPath);
    fs.mkdirSync(path.dirname(absPath), { recursive: true });
    fs.writeFileSync(absPath, lines.join('\n') + '\n', 'utf8');
  };

  before(() => {
    repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdd-indexer-repo-'));

    // Initialize a real git repository for testing `git status` discovery
    execFileSync('git', ['init'], { cwd: repoDir, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], {
      cwd: repoDir,
      stdio: 'ignore',
    });
    execFileSync('git', ['config', 'user.name', 'SDD Test'], {
      cwd: repoDir,
      stdio: 'ignore',
    });

    writeRepoFile('tsconfig.json', [
      '{',
      '  "compilerOptions": {',
      '    "target": "ES2022",',
      '    "module": "ESNext",',
      '    "moduleResolution": "bundler",',
      '    "jsx": "react-jsx",',
      '    "baseUrl": ".",',
      '    "paths": { "@/*": ["./src/*"] }',
      '  }',
      '}',
    ]);

    writeRepoFile('src/types/session.ts', [
      'export interface Session {',
      '  id: string;',
      '  expiresAt: number;',
      '}',
    ]);

    writeRepoFile('src/api/auth.ts', [
      'import type { Session } from "@/types/session";',
      '',
      'export function verifyToken(token: string): Session | null {',
      '  return token ? { id: "1", expiresAt: 100 } : null;',
      '}',
      '',
      'export function deprecatedCheck(token: string): boolean {',
      '  return token.length > 0;',
      '}',
    ]);

    writeRepoFile('src/hooks/useAuth.ts', [
      'import { verifyToken } from "@/api/auth";',
      'import type { Session } from "@/types/session";',
      '',
      'export function useAuth(token: string): Session | null {',
      '  return verifyToken(token);',
      '}',
    ]);

    writeRepoFile('src/components/LegacyBanner.tsx', [
      'import { deprecatedCheck } from "@/api/auth";',
      '',
      'export const LegacyBanner = ({ token }: { token: string }) => {',
      '  const ok = deprecatedCheck(token);',
      '  return <div>{ok ? "Valid" : "Invalid"}</div>;',
      '};',
    ]);

    execFileSync('git', ['add', '.'], { cwd: repoDir, stdio: 'ignore' });
    execFileSync('git', ['commit', '-m', 'Initial baseline'], {
      cwd: repoDir,
      stdio: 'ignore',
    });

    store = new FiberGraphStore(':memory:');
    indexer = new GraphIndexer(repoDir, store);
  });

  after(() => {
    store.close();
    if (repoDir && fs.existsSync(repoDir)) {
      fs.rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it('1. performs full baseline indexing of the project folder into CURRENT layer', async () => {
    const res = await indexer.indexCurrent();

    assert.equal(res.filesIndexed, 4);
    assert.equal(res.nodesIndexed, 5); // Session, verifyToken, deprecatedCheck, useAuth, LegacyBanner

    const stats = store.getStats();
    assert.equal(stats.currentNodes, 5);
    assert.equal(stats.wipLiveNodes, 0);
    assert.equal(stats.wipTombstoneNodes, 0);
    assert.equal(store.reconcileWip().length, 0);
  });

  it('2. detects modified files via `git status`, updates WIP, marks deleted symbols with is_tombstone = 1, and triggers STALE_CONTRACT', async () => {
    // Modify src/api/auth.ts on disk:
    // 1) Mutate verifyToken signature (add strict parameter)
    // 2) Delete deprecatedCheck symbol completely from the file
    writeRepoFile('src/api/auth.ts', [
      'import type { Session } from "@/types/session";',
      '',
      'export function verifyToken(token: string, strict: boolean): Session | null {',
      '  return token && strict ? { id: "1", expiresAt: 100 } : null;',
      '}',
    ]);

    // Verify git status auto-discovery
    const gitChanged = indexer.getGitModifiedFiles();
    assert.deepEqual(gitChanged, ['src/api/auth.ts']);

    // Run incremental WIP sync (auto-discovering via git status)
    const syncRes = await indexer.syncWip();
    assert.deepEqual(syncRes.syncedFiles, ['src/api/auth.ts']);
    assert.equal(syncRes.upsertedNodes, 1); // verifyToken updated in WIP
    assert.equal(syncRes.tombstonedNodes, 1); // deprecatedCheck tombstoned in WIP!

    // Verify deprecatedCheck has is_tombstone = 1 in WIP, while still alive in CURRENT
    const wipDeprecated = store.getNodeInLayer(
      'src/api/auth.ts::deprecatedCheck#function',
      'WIP'
    );
    const currDeprecated = store.getNodeInLayer(
      'src/api/auth.ts::deprecatedCheck#function',
      'CURRENT'
    );
    assert.ok(wipDeprecated);
    assert.equal(wipDeprecated.is_tombstone, 1);
    assert.ok(currDeprecated);
    assert.equal(currDeprecated.is_tombstone, 0);
    assert.equal(
      store.getEffectiveNode('src/api/auth.ts::deprecatedCheck#function'),
      null
    );

    // Run Reconciliation -> must report 2 STALE_CONTRACT items:
    // 1. LegacyBanner (TOMBSTONED_TARGET on deprecatedCheck @L4)
    // 2. useAuth (DIRECT_SIGNATURE_MUTATION on verifyToken @L5)
    const stale = store.reconcileWip();
    assert.equal(stale.length, 2);

    const bannerStale = stale.find(
      (s) =>
        s.stale_node_id ===
        'src/components/LegacyBanner.tsx::LegacyBanner#component'
    );
    assert.ok(bannerStale);
    assert.equal(bannerStale.mutation_kind, 'TOMBSTONED_TARGET');
    assert.equal(bannerStale.broken_at_line, 4);

    const hookStale = stale.find(
      (s) => s.stale_node_id === 'src/hooks/useAuth.ts::useAuth#hook'
    );
    assert.ok(hookStale);
    assert.equal(hookStale.mutation_kind, 'DIRECT_SIGNATURE_MUTATION');
    assert.equal(hookStale.broken_at_line, 5);
  });

  it('3. incrementally syncs updated consumer files by explicit list, tombstones removed call edges, resolves STALE_CONTRACT, and commits WIP -> CURRENT', async () => {
    // Fix consumer 1: update useAuth.ts to pass `strict`
    writeRepoFile('src/hooks/useAuth.ts', [
      'import { verifyToken } from "@/api/auth";',
      'import type { Session } from "@/types/session";',
      '',
      'export function useAuth(token: string): Session | null {',
      '  return verifyToken(token, true);',
      '}',
    ]);

    // Fix consumer 2: update LegacyBanner.tsx to remove call to deleted deprecatedCheck
    writeRepoFile('src/components/LegacyBanner.tsx', [
      'export const LegacyBanner = ({ token }: { token: string }) => {',
      '  return <div>{token ? "Valid" : "Invalid"}</div>;',
      '};',
    ]);

    // Sync explicit file list into WIP
    const syncRes = await indexer.syncWip([
      'src/hooks/useAuth.ts',
      'src/components/LegacyBanner.tsx',
    ]);
    assert.equal(syncRes.upsertedNodes, 2);
    // LegacyBanner's old CALLS and IMPORTS edges to deprecatedCheck are tombstoned in WIP!
    assert.ok(syncRes.tombstonedEdges >= 2);

    // Reconciliation must now be 100% clean (0 STALE_CONTRACT)
    const staleAfterFix = store.reconcileWip();
    assert.equal(staleAfterFix.length, 0);

    // Commit WIP -> CURRENT
    const commitRes = store.commitWip();
    assert.equal(commitRes.deletedNodes, 1); // deprecatedCheck removed from CURRENT
    assert.equal(commitRes.promotedNodes, 3); // verifyToken, useAuth, LegacyBanner updated in CURRENT

    const stats = store.getStats();
    assert.equal(stats.currentNodes, 4); // 5 initial - 1 deleted
    assert.equal(stats.wipLiveNodes, 0);
    assert.equal(stats.wipTombstoneNodes, 0);
  });
});

describe('Reconciliation acknowledgement semantics (re-parse is NOT healing)', () => {
  let repoDir: string;
  let store: FiberGraphStore;
  let indexer: GraphIndexer;

  const write = (relPath: string, lines: string[]) => {
    const absPath = path.join(repoDir, relPath);
    fs.mkdirSync(path.dirname(absPath), { recursive: true });
    fs.writeFileSync(absPath, lines.join('\n') + '\n', 'utf8');
  };

  const STALE_ID = 'src/u.ts::useIt#hook';

  before(async () => {
    repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdd-ack-repo-'));
    for (const args of [
      ['init'],
      ['config', 'user.email', 'test@example.com'],
      ['config', 'user.name', 'SDD Test'],
    ]) {
      execFileSync('git', args, { cwd: repoDir, stdio: 'ignore' });
    }
    write('tsconfig.json', ['{ "compilerOptions": { "jsx": "react-jsx" } }']);
    write('src/t.ts', [
      'export function verify(token: string): boolean { return !!token; }',
    ]);
    write('src/u.ts', [
      'import { verify } from "./t";',
      'export function useIt(x: string) { return verify(x); }',
      'export function unrelated(): number { return 1; }',
    ]);
    execFileSync('git', ['add', '.'], { cwd: repoDir, stdio: 'ignore' });
    execFileSync('git', ['commit', '-m', 'baseline'], { cwd: repoDir, stdio: 'ignore' });

    store = new FiberGraphStore(':memory:');
    indexer = new GraphIndexer(repoDir, store);
    await indexer.indexCurrent();
  });

  after(() => {
    store.close();
    fs.rmSync(repoDir, { recursive: true, force: true });
  });

  it('1. keeps STALE_CONTRACT when only a sibling symbol in the caller file was edited (false-negative regression)', async () => {
    write('src/t.ts', [
      'export function verify(token: string, strict: boolean): boolean { return !!token && strict; }',
    ]);
    await indexer.syncWip(['src/t.ts']);
    assert.deepEqual(store.reconcileWip().map((s) => s.stale_node_id), [STALE_ID]);

    // Edit ONLY `unrelated()`; the call `verify(x)` is still broken.
    write('src/u.ts', [
      'import { verify } from "./t";',
      'export function useIt(x: string) { return verify(x); }',
      'export function unrelated(): number { return 2; }',
    ]);
    await indexer.syncWip(); // git status picks up both t.ts and u.ts

    // The caller IS in WIP now and its WIP edge already carries the new hash —
    // but its own body/contract did not change, so it must stay stale.
    const callerWip = store.getNodeInLayer(STALE_ID, 'WIP');
    const callerCur = store.getNodeInLayer(STALE_ID, 'CURRENT');
    assert.ok(callerWip && callerCur);
    assert.equal(callerWip.body_hash, callerCur.body_hash);
    assert.equal(callerWip.signature_hash, callerCur.signature_hash);

    const stale = store.reconcileWip();
    assert.deepEqual(stale.map((s) => s.stale_node_id), [STALE_ID]);
    assert.equal(stale[0].mutation_kind, 'DIRECT_SIGNATURE_MUTATION');
    assert.equal(stale[0].broken_at_line, 2);
  });

  it('2. clears STALE_CONTRACT once the caller body is actually adapted (true healing)', async () => {
    write('src/u.ts', [
      'import { verify } from "./t";',
      'export function useIt(x: string) { return verify(x, true); }',
      'export function unrelated(): number { return 2; }',
    ]);
    await indexer.syncWip(['src/u.ts']);

    const callerWip = store.getNodeInLayer(STALE_ID, 'WIP');
    const callerCur = store.getNodeInLayer(STALE_ID, 'CURRENT');
    assert.notEqual(callerWip?.body_hash, callerCur?.body_hash);

    const targetWip = store.getNodeInLayer('src/t.ts::verify#function', 'WIP');
    const edgeWip = store
      .getOutboundEdgesInLayer(STALE_ID, 'WIP')
      .find((e) => e.edge_type === 'CALLS');
    assert.equal(edgeWip?.expected_target_hash, targetWip?.signature_hash);

    assert.deepEqual(store.reconcileWip(), []);
  });
});

describe('git status discovery when projectRoot is a monorepo sub-package', () => {
  let repoDir: string;

  before(() => {
    repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdd-monorepo-'));
    const write = (rel: string, content: string) => {
      fs.mkdirSync(path.dirname(path.join(repoDir, rel)), { recursive: true });
      fs.writeFileSync(path.join(repoDir, rel), content, 'utf8');
    };
    write('apps/web/tsconfig.json', '{ "compilerOptions": { "jsx": "react-jsx" } }');
    write('apps/web/src/t.ts', 'export function verify(token: string): boolean { return !!token; }\n');
    write('apps/web/src/u.ts', 'import { verify } from "./t";\nexport function useIt(x: string) { return verify(x); }\n');
    write('apps/admin/src/other.ts', 'export function other(): void {}\n');
    for (const args of [
      ['init'],
      ['config', 'user.email', 'test@example.com'],
      ['config', 'user.name', 'SDD Test'],
      ['add', '.'],
      ['commit', '-m', 'baseline'],
    ]) {
      execFileSync('git', args, { cwd: repoDir, stdio: 'ignore' });
    }
  });

  after(() => {
    fs.rmSync(repoDir, { recursive: true, force: true });
  });

  it('1. re-bases top-level-relative porcelain paths onto projectRoot and ignores sibling packages', async () => {
    const store = new FiberGraphStore(':memory:');
    const indexer = new GraphIndexer(path.join(repoDir, 'apps/web'), store);
    await indexer.indexCurrent();

    fs.writeFileSync(
      path.join(repoDir, 'apps/web/src/t.ts'),
      'export function verify(token: string, strict: boolean): boolean { return !!token && strict; }\n'
    );
    fs.writeFileSync(path.join(repoDir, 'apps/admin/src/other.ts'), 'export function other(x: number): void {}\n');

    assert.deepEqual(indexer.getGitModifiedFiles(), ['src/t.ts']);
    const sync = await indexer.syncWip();
    assert.equal(sync.upsertedNodes, 1);
    assert.deepEqual(store.reconcileWip().map((s) => s.stale_node_id), ['src/u.ts::useIt#hook']);
    store.close();
  });
});
