import fs from 'node:fs';
import path from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  FiberGraphStore,
  type SubgraphNodeResult,
} from '../db/fiber-store.ts';
import { GraphIndexer } from '../indexer/graph-indexer.ts';

export interface SddMcpServerOptions {
  projectRoot: string;
  dbPath?: string;
  store?: FiberGraphStore;
  indexer?: GraphIndexer;
}

export interface SddMcpServerInstance {
  mcpServer: McpServer;
  store: FiberGraphStore;
  indexer: GraphIndexer;
}

/**
 * Formats an object as deterministic JSON (2-space indent) for MCP tool text output.
 */
function toDeterministicJsonText(payload: unknown): {
  content: Array<{ type: 'text'; text: string }>;
} {
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(payload, null, 2),
      },
    ],
  };
}

/**
 * Creates the SDD Code-Graph MCP Server with 4 frozen-schema tools:
 * 1. sdd_query_subgraph
 * 2. sdd_read_implementation
 * 3. sdd_reconcile_wip
 * 4. sdd_lifecycle
 */
export function createSddMcpServer(
  options: SddMcpServerOptions
): SddMcpServerInstance {
  const resolvedRoot = path.resolve(options.projectRoot);
  const projectRoot = fs.existsSync(resolvedRoot)
    ? fs.realpathSync(resolvedRoot)
    : resolvedRoot;

  let store = options.store;
  if (!store) {
    const dbPath = options.dbPath ?? ':memory:';
    if (dbPath !== ':memory:') {
      fs.mkdirSync(path.dirname(path.resolve(projectRoot, dbPath)), {
        recursive: true,
      });
    }
    store = new FiberGraphStore(
      dbPath === ':memory:' ? ':memory:' : path.resolve(projectRoot, dbPath)
    );
  }

  const indexer = options.indexer ?? new GraphIndexer(projectRoot, store);

  const mcpServer = new McpServer({
    name: 'sdd-graph-mcp',
    version: '0.1.0',
  });

  // ==========================================================================
  // 1. sdd_query_subgraph
  // ==========================================================================
  mcpServer.registerTool(
    'sdd_query_subgraph',
    {
      description:
        'Reads the virtual merged k-hop subgraph (WIP overlaid on CURRENT) for a symbol, returning only normalized signatures, JSDoc summaries, active layers, and edge traces without function bodies.',
      inputSchema: {
        symbol_id: z
          .string()
          .describe(
            "Canonical node_id (e.g. 'src/api/auth.ts::verifyToken#function') or short symbol name (e.g. 'verifyToken')"
          ),
        max_hops: z
          .number()
          .int()
          .min(1)
          .max(5)
          .default(2)
          .describe('Maximum traversal hops k (1..5, default 2)'),
        max_hub_in_degree: z
          .number()
          .int()
          .min(1)
          .default(20)
          .describe(
            'Hub damping threshold: blocks reverse INBOUND expansion from intermediate OUTBOUND hubs with > N callers (default 20)'
          ),
      },
    },
    async ({ symbol_id, max_hops, max_hub_in_degree }) => {
      const candidates = store.resolveEffectiveNodes(symbol_id);
      if (candidates.length === 0) {
        return toDeterministicJsonText({
          status: 'NOT_FOUND',
          symbol_id,
          max_hops,
          nodes: [],
        });
      }

      const mergedById = new Map<string, SubgraphNodeResult>();
      for (const seed of candidates) {
        const sub = store.querySubgraph(
          seed.node_id,
          max_hops,
          max_hub_in_degree
        );
        for (const row of sub) {
          const existing = mergedById.get(row.node_id);
          if (!existing || row.hop_distance < existing.hop_distance) {
            mergedById.set(row.node_id, row);
          }
        }
      }

      const orderedNodes = Array.from(mergedById.values()).sort((a, b) => {
        if (a.hop_distance !== b.hop_distance) {
          return a.hop_distance - b.hop_distance;
        }
        return a.node_id.localeCompare(b.node_id);
      });

      return toDeterministicJsonText({
        status: 'OK',
        seed_symbol: symbol_id,
        resolved_seed_ids: candidates.map((c) => c.node_id),
        max_hops,
        node_count: orderedNodes.length,
        nodes: orderedNodes,
      });
    }
  );

  // ==========================================================================
  // 2. sdd_read_implementation
  // ==========================================================================
  mcpServer.registerTool(
    'sdd_read_implementation',
    {
      description:
        'Retrieves the exact source code implementation (start_line..end_line) for specific AST nodes from disk using their effective (WIP or CURRENT) coordinates.',
      inputSchema: {
        node_ids: z
          .array(z.string())
          .min(1)
          .describe(
            'List of canonical node_ids or short symbol names to read implementation bodies for'
          ),
      },
    },
    async ({ node_ids }) => {
      const resolvedMap = new Map<
        string,
        ReturnType<typeof store.getEffectiveNode>
      >();
      const missingQueries: string[] = [];

      for (const query of node_ids) {
        const matches = store.resolveEffectiveNodes(query);
        if (matches.length === 0) {
          missingQueries.push(query);
        } else {
          for (const m of matches) {
            resolvedMap.set(m.node_id, m);
          }
        }
      }

      const sortedIds = Array.from(resolvedMap.keys()).sort();
      const implementations = sortedIds.map((id) => {
        const node = resolvedMap.get(id)!;
        const absFile = path.resolve(projectRoot, node.file_path);

        if (!fs.existsSync(absFile)) {
          return {
            node_id: node.node_id,
            active_layer: node.layer,
            file_path: node.file_path,
            start_line: node.start_line,
            end_line: node.end_line,
            signature: node.signature,
            status: 'FILE_MISSING_ON_DISK',
            code: null,
          };
        }

        const allLines = fs.readFileSync(absFile, 'utf8').split(/\r?\n/);
        const startIdx = Math.max(0, node.start_line - 1);
        const endIdx = Math.min(allLines.length, node.end_line);
        const numberedLines = allLines
          .slice(startIdx, endIdx)
          .map((line, idx) => `L${startIdx + idx + 1}: ${line}`)
          .join('\n');

        return {
          node_id: node.node_id,
          active_layer: node.layer,
          kind: node.kind,
          file_path: node.file_path,
          start_line: node.start_line,
          end_line: node.end_line,
          signature: node.signature,
          signature_hash: node.signature_hash,
          body_hash: node.body_hash,
          status: 'OK',
          code: numberedLines,
        };
      });

      return toDeterministicJsonText({
        implementations,
        not_found: missingQueries.sort(),
      });
    }
  );

  // ==========================================================================
  // 3. sdd_reconcile_wip
  // ==========================================================================
  mcpServer.registerTool(
    'sdd_reconcile_wip',
    {
      description:
        'Incrementally syncs modified/deleted .ts/.tsx files into the WIP layer (via explicit file list or git status) and executes the SQLite Reconciliation phase to detect all direct and transitive STALE_CONTRACT violations.',
      inputSchema: {
        files: z
          .array(z.string())
          .optional()
          .describe(
            'Optional list of modified/added/deleted .ts/.tsx relative file paths. If omitted, automatically detects modified files via git status.'
          ),
      },
    },
    async ({ files }) => {
      const syncResult = await indexer.syncWip(files);
      const staleContracts = store.reconcileWip();

      return toDeterministicJsonText({
        commit_gate:
          staleContracts.length === 0
            ? 'PASSED'
            : 'BLOCKED_BY_STALE_CONTRACTS',
        synced_files: syncResult.syncedFiles,
        sync_summary: {
          upserted_nodes: syncResult.upsertedNodes,
          tombstoned_nodes: syncResult.tombstonedNodes,
          upserted_edges: syncResult.upsertedEdges,
          tombstoned_edges: syncResult.tombstonedEdges,
        },
        stale_contracts_count: staleContracts.length,
        stale_contracts: staleContracts,
      });
    }
  );

  // ==========================================================================
  // 4. sdd_lifecycle
  // ==========================================================================
  mcpServer.registerTool(
    'sdd_lifecycle',
    {
      description:
        "Manages the React Fiber CoW graph lifecycle: 'init_current' (full project baseline index into CURRENT), 'status' (layer statistics & git dirty state), 'commit' (atomic merge WIP -> CURRENT when STALE_CONTRACT == 0), or 'abort' (instant rollback of WIP).",
      inputSchema: {
        action: z
          .enum(['commit', 'abort', 'status', 'init_current'])
          .describe(
            "Lifecycle command: 'commit' | 'abort' | 'status' | 'init_current'"
          ),
        sub_dir: z
          .string()
          .optional()
          .describe("Optional subdirectory to index when action is 'init_current'"),
        force: z
          .boolean()
          .optional()
          .default(false)
          .describe(
            "When action is 'commit', bypass the STALE_CONTRACT commit gate if true (default false)"
          ),
      },
    },
    async ({ action, sub_dir, force }) => {
      if (action === 'init_current') {
        const res = await indexer.indexCurrent(sub_dir);
        return toDeterministicJsonText({
          action: 'init_current',
          files_indexed: res.filesIndexed,
          nodes_indexed: res.nodesIndexed,
          edges_indexed: res.edgesIndexed,
          stats: store.getStats(),
        });
      }

      if (action === 'status') {
        const stale = store.reconcileWip();
        return toDeterministicJsonText({
          action: 'status',
          commit_gate:
            stale.length === 0 ? 'PASSED' : 'BLOCKED_BY_STALE_CONTRACTS',
          stale_contracts_count: stale.length,
          git_modified_files: indexer.getGitModifiedFiles(),
          stats: store.getStats(),
        });
      }

      if (action === 'abort') {
        const abortResult = store.abortWip();
        return toDeterministicJsonText({
          action: 'abort',
          aborted: true,
          cleared: abortResult,
          stats: store.getStats(),
        });
      }

      // action === 'commit'
      const stale = store.reconcileWip();
      if (stale.length > 0 && !force) {
        return toDeterministicJsonText({
          action: 'commit',
          committed: false,
          reason: 'COMMIT_GATE_BLOCKED_BY_STALE_CONTRACTS',
          stale_contracts_count: stale.length,
          stale_contracts: stale,
        });
      }

      const commitResult = store.commitWip();
      return toDeterministicJsonText({
        action: 'commit',
        committed: true,
        result: commitResult,
        stats: store.getStats(),
      });
    }
  );

  return {
    mcpServer,
    store,
    indexer,
  };
}
