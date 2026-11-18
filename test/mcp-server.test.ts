import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createSddMcpServer } from '../src/mcp/server.ts';

describe('SDD MCP Server (4 Core Tools E2E over Model Context Protocol)', () => {
  let repoDir: string;
  let client: Client;
  let closeServer: () => Promise<void>;

  const writeRepoFile = (relPath: string, lines: string[]) => {
    const absPath = path.join(repoDir, relPath);
    fs.mkdirSync(path.dirname(absPath), { recursive: true });
    fs.writeFileSync(absPath, lines.join('\n') + '\n', 'utf8');
  };

  const callToolJson = async (
    name: string,
    args: Record<string, unknown> = {}
  ): Promise<any> => {
    const res = await client.callTool({ name, arguments: args });
    const first = (res.content as Array<{ type: string; text: string }>)[0];
    assert.ok(first && first.type === 'text');
    return JSON.parse(first.text);
  };

  before(async () => {
    repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdd-mcp-e2e-'));

    execFileSync('git', ['init'], { cwd: repoDir, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.email', 'mcp@example.com'], {
      cwd: repoDir,
      stdio: 'ignore',
    });
    execFileSync('git', ['config', 'user.name', 'MCP Test'], {
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

    writeRepoFile('src/api/auth.ts', [
      'export interface AuthSession {', // L1
      '  userId: string;', // L2
      '}', // L3
      '', // L4
      '/**', // L5
      ' * Validates user token.', // L6
      ' */', // L7
      'export function verifyToken(token: string): AuthSession | null {', // L8
      '  return token ? { userId: "u1" } : null;', // L9
      '}', // L10
    ]);

    writeRepoFile('src/components/UserGuard.tsx', [
      'import { verifyToken } from "@/api/auth";', // L1
      '', // L2
      'export interface UserGuardProps {', // L3
      '  token: string;', // L4
      '}', // L5
      '', // L6
      'export const UserGuard = ({ token }: UserGuardProps) => {', // L7
      '  const session = verifyToken(token);', // L8
      '  return <div>{session ? session.userId : "Guest"}</div>;', // L9
      '};', // L10
    ]);

    execFileSync('git', ['add', '.'], { cwd: repoDir, stdio: 'ignore' });
    execFileSync('git', ['commit', '-m', 'Initial commit'], {
      cwd: repoDir,
      stdio: 'ignore',
    });

    const { mcpServer, store } = createSddMcpServer({
      projectRoot: repoDir,
      dbPath: ':memory:',
    });

    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    client = new Client({ name: 'test-sdd-client', version: '0.1.0' });

    await Promise.all([
      mcpServer.connect(serverTransport),
      client.connect(clientTransport),
    ]);

    closeServer = async () => {
      await client.close();
      await mcpServer.close();
      store.close();
    };
  });

  after(async () => {
    await closeServer();
    if (repoDir && fs.existsSync(repoDir)) {
      fs.rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it('1. exposes the exact 4 frozen MCP tools (sdd_query_subgraph, sdd_read_implementation, sdd_reconcile_wip, sdd_lifecycle)', async () => {
    const list1 = await client.listTools();
    const toolNames = list1.tools.map((t) => t.name).sort();

    assert.deepEqual(toolNames, [
      'sdd_lifecycle',
      'sdd_query_subgraph',
      'sdd_read_implementation',
      'sdd_reconcile_wip',
    ]);

    // Verify tool schema JSON is 100% static across calls
    const list2 = await client.listTools();
    assert.equal(JSON.stringify(list1.tools), JSON.stringify(list2.tools));
  });

  it('2. initializes CURRENT via sdd_lifecycle(init_current) and queries subgraph & implementation via sdd_query_subgraph / sdd_read_implementation', async () => {
    const initRes = await callToolJson('sdd_lifecycle', {
      action: 'init_current',
    });
    assert.equal(initRes.action, 'init_current');
    assert.equal(initRes.files_indexed, 2);
    assert.equal(initRes.nodes_indexed, 4); // AuthSession, verifyToken, UserGuardProps, UserGuard

    // Query subgraph by short symbol name 'verifyToken'
    const subRes = await callToolJson('sdd_query_subgraph', {
      symbol_id: 'verifyToken',
      max_hops: 1,
    });
    assert.equal(subRes.status, 'OK');
    assert.equal(subRes.node_count, 3); // verifyToken (hop 0), AuthSession (hop 1), UserGuard (hop 1)
    assert.equal(
      subRes.nodes[0].node_id,
      'src/api/auth.ts::verifyToken#function'
    );
    assert.equal(subRes.nodes[0].jsdoc_summary, 'Validates user token.');

    // Read source implementation for verifyToken
    const implRes = await callToolJson('sdd_read_implementation', {
      node_ids: ['verifyToken'],
    });
    assert.equal(implRes.implementations.length, 1);
    assert.equal(implRes.implementations[0].status, 'OK');
    assert.equal(implRes.implementations[0].start_line, 8);
    assert.equal(implRes.implementations[0].end_line, 10);
    assert.ok(
      implRes.implementations[0].code.includes(
        'L8: export function verifyToken(token: string): AuthSession | null {'
      )
    );
  });

  it('3. enforces Commit Gate via sdd_reconcile_wip & sdd_lifecycle(commit | abort) during WIP contract mutations', async () => {
    // Mutate verifyToken contract on disk
    writeRepoFile('src/api/auth.ts', [
      'export interface AuthSession {',
      '  userId: string;',
      '}',
      '',
      'export function verifyToken(token: string, audience: string): AuthSession | null {',
      '  return token && audience ? { userId: "u1" } : null;',
      '}',
    ]);

    // 1. Run sdd_reconcile_wip (auto-detecting changed file via git status)
    const rec1 = await callToolJson('sdd_reconcile_wip', {});
    assert.equal(rec1.commit_gate, 'BLOCKED_BY_STALE_CONTRACTS');
    assert.deepEqual(rec1.synced_files, ['src/api/auth.ts']);
    assert.equal(rec1.stale_contracts_count, 1);
    assert.equal(
      rec1.stale_contracts[0].stale_node_id,
      'src/components/UserGuard.tsx::UserGuard#component'
    );
    assert.equal(rec1.stale_contracts[0].broken_at_line, 8);

    // 2. Attempt sdd_lifecycle(commit) while STALE_CONTRACT > 0 -> must be blocked by Commit Gate!
    const blockedCommit = await callToolJson('sdd_lifecycle', {
      action: 'commit',
    });
    assert.equal(blockedCommit.committed, false);
    assert.equal(
      blockedCommit.reason,
      'COMMIT_GATE_BLOCKED_BY_STALE_CONTRACTS'
    );

    // 3. Fix UserGuard.tsx on disk to adapt to new verifyToken contract
    writeRepoFile('src/components/UserGuard.tsx', [
      'import { verifyToken } from "@/api/auth";',
      '',
      'export interface UserGuardProps {',
      '  token: string;',
      '}',
      '',
      'export const UserGuard = ({ token }: UserGuardProps) => {',
      '  const session = verifyToken(token, "web-app");',
      '  return <div>{session ? session.userId : "Guest"}</div>;',
      '};',
    ]);

    const rec2 = await callToolJson('sdd_reconcile_wip', {
      files: ['src/components/UserGuard.tsx'],
    });
    assert.equal(rec2.commit_gate, 'PASSED');
    assert.equal(rec2.stale_contracts_count, 0);

    // 4. Commit WIP -> CURRENT now succeeds!
    const successCommit = await callToolJson('sdd_lifecycle', {
      action: 'commit',
    });
    assert.equal(successCommit.committed, true);
    assert.equal(successCommit.result.promotedNodes, 4);
    assert.equal(successCommit.stats.wipLiveNodes, 0);

    // 5. Test abort lifecycle on a new WIP edit
    writeRepoFile('src/api/auth.ts', [
      'export interface AuthSession {',
      '  userId: string;',
      '}',
      '',
      'export function verifyToken(): null {',
      '  return null;',
      '}',
    ]);
    const rec3 = await callToolJson('sdd_reconcile_wip', {
      files: ['src/api/auth.ts'],
    });
    assert.equal(rec3.commit_gate, 'BLOCKED_BY_STALE_CONTRACTS');

    const abortRes = await callToolJson('sdd_lifecycle', { action: 'abort' });
    assert.equal(abortRes.aborted, true);
    assert.equal(abortRes.stats.wipLiveNodes, 0);

    const statusRes = await callToolJson('sdd_lifecycle', { action: 'status' });
    assert.equal(statusRes.commit_gate, 'PASSED');
    assert.equal(statusRes.stale_contracts_count, 0);
  });
});
