import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  FiberGraphStore,
  type GraphEdgeInput,
  type GraphNodeInput,
} from '../db/fiber-store.ts';
import { TsAstExtractor } from '../parser/ts-extractor.ts';

export interface IndexBaselineResult {
  filesIndexed: number;
  nodesIndexed: number;
  edgesIndexed: number;
  durationMs: number;
}

export interface SyncWipResult {
  syncedFiles: string[];
  upsertedNodes: number;
  tombstonedNodes: number;
  upsertedEdges: number;
  tombstonedEdges: number;
  durationMs: number;
}

const IGNORED_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  '.next',
  'out',
  'coverage',
  '.sdd-graph',
  '.turbo',
]);

function isSupportedSourceFile(filePath: string): boolean {
  if (filePath.endsWith('.d.ts')) return false;
  return filePath.endsWith('.ts') || filePath.endsWith('.tsx');
}

function walkTsFiles(rootDir: string, currentDir: string = rootDir): string[] {
  const results: string[] = [];
  if (!fs.existsSync(currentDir)) return results;

  const entries = fs.readdirSync(currentDir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name.startsWith('.') && entry.name !== '.') {
      if (IGNORED_DIRS.has(entry.name)) continue;
    }
    const fullPath = path.join(currentDir, entry.name);
    if (entry.isDirectory()) {
      if (IGNORED_DIRS.has(entry.name)) continue;
      results.push(...walkTsFiles(rootDir, fullPath));
    } else if (entry.isFile() && isSupportedSourceFile(entry.name)) {
      results.push(fullPath);
    }
  }

  return results.sort();
}

/**
 * Incremental Synchronization Service for CURRENT and WIP Graph Layers.
 * Orchestrates full project baseline indexing into CURRENT and targeted delta indexing
 * (from explicit file lists or `git status`) into WIP with automatic tombstone management.
 */
export class GraphIndexer {
  public readonly projectRoot: string;
  public readonly store: FiberGraphStore;
  public readonly extractor: TsAstExtractor;

  constructor(
    projectRoot: string,
    store: FiberGraphStore,
    tsconfigPath?: string
  ) {
    const resolvedRoot = path.resolve(projectRoot);
    this.projectRoot = fs.existsSync(resolvedRoot)
      ? fs.realpathSync(resolvedRoot)
      : resolvedRoot;
    this.store = store;
    this.extractor = new TsAstExtractor(this.projectRoot, tsconfigPath);
  }

  /**
   * Full baseline scan of the project directory into the CURRENT layer.
   * Resets existing CURRENT and WIP records before populating the fresh baseline.
   */
  public async indexCurrent(subDir?: string): Promise<IndexBaselineResult> {
    const startTime = performance.now();
    await this.extractor.init();
    this.extractor.clearResolverCache();

    const targetRoot = subDir
      ? path.resolve(this.projectRoot, subDir)
      : this.projectRoot;
    const files = walkTsFiles(this.projectRoot, targetRoot);

    const extracted = await this.extractor.extractProject(files, 'CURRENT');

    this.store.clearAll();
    this.store.upsertNodes(extracted.nodes);
    this.store.upsertEdges(extracted.edges);

    return {
      filesIndexed: files.length,
      nodesIndexed: extracted.nodes.length,
      edgesIndexed: extracted.edges.length,
      durationMs: Math.round((performance.now() - startTime) * 100) / 100,
    };
  }

  /**
   * Inspects `git status --porcelain -uall` to discover modified, added, deleted,
   * or renamed .ts/.tsx files relative to the project root.
   * Porcelain paths are always relative to the git top-level, so they are re-based onto
   * `projectRoot` (which may be a monorepo sub-package such as `apps/web`).
   */
  public getGitModifiedFiles(): string[] {
    try {
      const gitOpts = {
        cwd: this.projectRoot,
        encoding: 'utf8' as const,
        stdio: ['ignore', 'pipe', 'ignore'] as ['ignore', 'pipe', 'ignore'],
      };
      const topLevel = execFileSync('git', ['rev-parse', '--show-toplevel'], gitOpts).trim();
      // `-- .` restricts the status to projectRoot; paths stay top-level-relative
      const stdout = execFileSync('git', ['status', '--porcelain', '-uall', '--', '.'], gitOpts);

      const changedFiles = new Set<string>();
      const addPath = (gitRelPath: string) => {
        if (!gitRelPath || !isSupportedSourceFile(gitRelPath)) return;
        const projectRel = this.extractor.toPosixPath(path.resolve(topLevel, gitRelPath));
        if (!projectRel.startsWith('../')) changedFiles.add(projectRel);
      };
      const lines = stdout.split('\n');

      for (const rawLine of lines) {
        if (rawLine.length < 4) continue;
        const pathPart = rawLine.slice(3).trim();
        if (!pathPart) continue;

        // Handle renames: `R  old/path.ts -> new/path.ts`
        if (pathPart.includes(' -> ')) {
          const [oldPath, newPath] = pathPart
            .split(' -> ')
            .map((s) => s.replace(/^"|"$/g, '').trim());
          addPath(oldPath);
          addPath(newPath);
        } else {
          addPath(pathPart.replace(/^"|"$/g, '').trim());
        }
      }

      return Array.from(changedFiles).sort();
    } catch {
      return [];
    }
  }

  /**
   * Targeted re-parsing of modified/added/deleted files into the WIP layer.
   * If `filePaths` is omitted, automatically queries `git status` for changed files.
   * Marks deleted symbols and removed edges with `is_tombstone = 1` in WIP.
   */
  public async syncWip(filePaths?: string[]): Promise<SyncWipResult> {
    const startTime = performance.now();
    await this.extractor.init();
    this.extractor.clearResolverCache();

    const targetPaths = filePaths ?? this.getGitModifiedFiles();
    const canonicalPaths = Array.from(
      new Set(
        targetPaths
          .map((fp) => this.extractor.toPosixPath(fp))
          .filter((fp) => isSupportedSourceFile(fp))
      )
    ).sort();

    if (canonicalPaths.length === 0) {
      return {
        syncedFiles: [],
        upsertedNodes: 0,
        tombstonedNodes: 0,
        upsertedEdges: 0,
        tombstonedEdges: 0,
        durationMs: Math.round((performance.now() - startTime) * 100) / 100,
      };
    }

    const existingFiles: string[] = [];
    const deletedFiles: string[] = [];

    for (const relPath of canonicalPaths) {
      const absPath = path.resolve(this.projectRoot, relPath);
      if (fs.existsSync(absPath)) {
        existingFiles.push(relPath);
      } else {
        deletedFiles.push(relPath);
      }
    }

    // Build fallback map of effective nodes (WIP over CURRENT) for unchanged files
    const effectiveByFile = this.store.getEffectiveNodesByFileMap();
    const fallbackNodesByFile = new Map<string, GraphNodeInput[]>();
    const syncingSet = new Set(canonicalPaths);

    for (const [fPath, records] of effectiveByFile) {
      if (!syncingSet.has(fPath)) {
        fallbackNodesByFile.set(fPath, records);
      }
    }

    // Extract AST nodes and edges for all existing modified/added files into WIP
    const extracted =
      existingFiles.length > 0
        ? await this.extractor.extractProject(
            existingFiles,
            'WIP',
            fallbackNodesByFile
          )
        : { nodes: [], edges: [], files: new Map() };

    const newNodesByFile = new Map<string, GraphNodeInput[]>();
    for (const fPath of existingFiles) {
      newNodesByFile.set(fPath, []);
    }
    for (const node of extracted.nodes) {
      let list = newNodesByFile.get(node.file_path);
      if (!list) {
        list = [];
        newNodesByFile.set(node.file_path, list);
      }
      list.push(node);
    }

    const newEdgesBySource = new Map<string, GraphEdgeInput[]>();
    for (const edge of extracted.edges) {
      let list = newEdgesBySource.get(edge.source_id);
      if (!list) {
        list = [];
        newEdgesBySource.set(edge.source_id, list);
      }
      list.push(edge);
    }

    let upsertedNodes = 0;
    let tombstonedNodes = 0;
    let upsertedEdges = 0;
    let tombstonedEdges = 0;

    this.store.db.exec('BEGIN IMMEDIATE TRANSACTION');
    try {
      // 1. Process Deleted Files -> tombstone all CURRENT symbols & their outbound edges in WIP
      for (const delFile of deletedFiles) {
        const currNodes = this.store.getNodesByFileInLayer(delFile, 'CURRENT');
        const wipNodes = this.store.getNodesByFileInLayer(delFile, 'WIP');
        const currNodeIds = new Set(currNodes.map((n) => n.node_id));

        for (const cNode of currNodes) {
          this.store.tombstoneNode(cNode.node_id);
          tombstonedNodes++;

          const currOutEdges = this.store.getOutboundEdgesInLayer(
            cNode.node_id,
            'CURRENT'
          );
          for (const cEdge of currOutEdges) {
            this.store.tombstoneEdge(
              cEdge.source_id,
              cEdge.target_id,
              cEdge.edge_type
            );
            tombstonedEdges++;
          }
        }

        // Clean up any WIP-only symbols/edges that never existed in CURRENT
        for (const wNode of wipNodes) {
          if (!currNodeIds.has(wNode.node_id)) {
            const wipOutEdges = this.store.getOutboundEdgesInLayer(
              wNode.node_id,
              'WIP'
            );
            for (const wEdge of wipOutEdges) {
              this.store.deleteWipRecordForEdge(
                wEdge.source_id,
                wEdge.target_id,
                wEdge.edge_type
              );
            }
            this.store.deleteWipRecordForNode(wNode.node_id);
          }
        }
      }

      // 2. Process Existing Modified / Added Files
      for (const modFile of existingFiles) {
        const freshNodes = newNodesByFile.get(modFile) ?? [];
        const freshNodeIds = new Set(freshNodes.map((n) => n.node_id));

        const currNodes = this.store.getNodesByFileInLayer(modFile, 'CURRENT');
        const prevWipNodes = this.store.getNodesByFileInLayer(modFile, 'WIP');
        const currNodeMap = new Map(currNodes.map((n) => [n.node_id, n]));

        // 2a. Upsert fresh WIP nodes and reconcile their outbound edges
        for (const freshNode of freshNodes) {
          this.store.upsertNode(freshNode);
          upsertedNodes++;

          const freshEdges = newEdgesBySource.get(freshNode.node_id) ?? [];
          const freshEdgeKeys = new Set(
            freshEdges.map((e) => `${e.target_id}|${e.edge_type}`)
          );

          for (const edge of freshEdges) {
            this.store.upsertEdge(edge);
            upsertedEdges++;
          }

          // Tombstone any CURRENT outbound edge from freshNode that was removed in WIP
          const currOutEdges = this.store.getOutboundEdgesInLayer(
            freshNode.node_id,
            'CURRENT'
          );
          const currEdgeKeys = new Set<string>();
          for (const cEdge of currOutEdges) {
            const key = `${cEdge.target_id}|${cEdge.edge_type}`;
            currEdgeKeys.add(key);
            if (!freshEdgeKeys.has(key)) {
              this.store.tombstoneEdge(
                cEdge.source_id,
                cEdge.target_id,
                cEdge.edge_type
              );
              tombstonedEdges++;
            }
          }

          // Delete any prior WIP-only outbound edge from freshNode that is no longer present
          const prevWipOutEdges = this.store.getOutboundEdgesInLayer(
            freshNode.node_id,
            'WIP'
          );
          for (const wEdge of prevWipOutEdges) {
            const key = `${wEdge.target_id}|${wEdge.edge_type}`;
            if (!freshEdgeKeys.has(key) && !currEdgeKeys.has(key)) {
              this.store.deleteWipRecordForEdge(
                wEdge.source_id,
                wEdge.target_id,
                wEdge.edge_type
              );
            }
          }
        }

        // 2b. Tombstone any CURRENT symbol in modFile that was deleted or renamed in WIP
        for (const cNode of currNodes) {
          if (!freshNodeIds.has(cNode.node_id)) {
            this.store.tombstoneNode(cNode.node_id);
            tombstonedNodes++;

            const currOutEdges = this.store.getOutboundEdgesInLayer(
              cNode.node_id,
              'CURRENT'
            );
            for (const cEdge of currOutEdges) {
              this.store.tombstoneEdge(
                cEdge.source_id,
                cEdge.target_id,
                cEdge.edge_type
              );
              tombstonedEdges++;
            }
          }
        }

        // 2c. Delete any prior WIP-only symbol in modFile that was removed before commit
        for (const wNode of prevWipNodes) {
          if (
            !freshNodeIds.has(wNode.node_id) &&
            !currNodeMap.has(wNode.node_id)
          ) {
            const wipOutEdges = this.store.getOutboundEdgesInLayer(
              wNode.node_id,
              'WIP'
            );
            for (const wEdge of wipOutEdges) {
              this.store.deleteWipRecordForEdge(
                wEdge.source_id,
                wEdge.target_id,
                wEdge.edge_type
              );
            }
            this.store.deleteWipRecordForNode(wNode.node_id);
          }
        }
      }

      this.store.db.exec('COMMIT');
    } catch (err) {
      this.store.db.exec('ROLLBACK');
      throw err;
    }

    return {
      syncedFiles: canonicalPaths,
      upsertedNodes,
      tombstonedNodes,
      upsertedEdges,
      tombstonedEdges,
      durationMs: Math.round((performance.now() - startTime) * 100) / 100,
    };
  }
}
