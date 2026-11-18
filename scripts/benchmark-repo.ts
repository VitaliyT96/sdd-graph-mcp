import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  FiberGraphStore,
  computeHash,
  type SubgraphNodeResult,
} from '../src/db/fiber-store.ts';
import { GraphIndexer } from '../src/indexer/graph-indexer.ts';

function generateSyntheticRepo(fileCount: number): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdd-synth-bench-'));
  fs.writeFileSync(
    path.join(dir, 'tsconfig.json'),
    JSON.stringify(
      {
        compilerOptions: {
          target: 'ES2022',
          module: 'ESNext',
          moduleResolution: 'bundler',
          jsx: 'react-jsx',
          baseUrl: '.',
          paths: { '@/*': ['./src/*'] },
        },
      },
      null,
      2
    )
  );

  const write = (rel: string, content: string) => {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content, 'utf8');
  };

  write(
    'src/utils/cn.ts',
    'export function cn(...inputs: Array<string | undefined | false>): string { return inputs.filter(Boolean).join(" "); }\n'
  );

  write(
    'src/components/ui/button/button.tsx',
    [
      'import { cn } from "@/utils/cn";',
      '',
      'export type ButtonProps = {',
      '  variant?: "default" | "outline";',
      '  isLoading?: boolean;',
      '  children?: unknown;',
      '};',
      '',
      'export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(({ variant, isLoading }, ref) => {',
      '  return <button ref={ref} className={cn("btn", variant)} disabled={isLoading} />;',
      '});',
    ].join('\n')
  );

  write('src/components/ui/button/index.ts', 'export * from "./button";\n');

  const count = Math.max(25, fileCount - 3);
  for (let i = 1; i <= count; i++) {
    const rendersButton = i <= 10;
    write(
      `src/features/feat${i}/Widget${i}.tsx`,
      [
        'import { cn } from "@/utils/cn";',
        ...(rendersButton
          ? ['import { Button } from "@/components/ui/button";']
          : []),
        '',
        `export interface Widget${i}Props { title: string }`,
        `export const Widget${i} = ({ title }: Widget${i}Props) => {`,
        '  const cls = cn("widget-box", title);',
        rendersButton
          ? '  return <div className={cls}><Button variant="default">{title}</Button></div>;'
          : '  return <div className={cls}>{title}</div>;',
        '};',
      ].join('\n')
    );
  }

  return dir;
}

function measureSubgraphContext(
  targetDir: string,
  subgraph: SubgraphNodeResult[]
): {
  nodeCount: number;
  fileCount: number;
  sigKb: number;
  rawFilesKb: number;
} {
  const sigBytes = subgraph.reduce(
    (acc, n) =>
      acc +
      Buffer.byteLength(n.signature, 'utf8') +
      Buffer.byteLength(n.jsdoc_summary ?? '', 'utf8'),
    0
  );
  const uniqueFiles = new Set(subgraph.map((n) => n.file_path));
  let rawBytes = 0;
  for (const relFile of uniqueFiles) {
    const abs = path.join(targetDir, relFile);
    if (fs.existsSync(abs)) {
      rawBytes += fs.statSync(abs).size;
    }
  }
  return {
    nodeCount: subgraph.length,
    fileCount: uniqueFiles.size,
    sigKb: Math.round((sigBytes / 1024) * 100) / 100,
    rawFilesKb: Math.round((rawBytes / 1024) * 100) / 100,
  };
}

async function main() {
  const args = process.argv.slice(2);
  let targetDir: string | null = null;
  let cleanupDir = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--repo' && args[i + 1]) {
      targetDir = path.resolve(args[++i]);
    } else if (args[i] === '--clone' && args[i + 1]) {
      const repoUrl = args[++i];
      const cloneDest = fs.mkdtempSync(
        path.join(os.tmpdir(), 'sdd-cloned-repo-')
      );
      console.log(`Cloning ${repoUrl} into ${cloneDest} ...`);
      execFileSync('git', ['clone', '--depth', '1', repoUrl, cloneDest], {
        stdio: 'inherit',
      });
      targetDir = cloneDest;
      cleanupDir = true;
    } else if (args[i] === '--synthetic') {
      const count = Number(args[i + 1] ?? 100) || 100;
      targetDir = generateSyntheticRepo(count);
      cleanupDir = true;
    }
  }

  if (!targetDir) {
    targetDir = generateSyntheticRepo(100);
    cleanupDir = true;
  }

  console.log(`\n=== SDD-Graph-MCP v0.1 Benchmark ===`);
  console.log(`Target Repository: ${targetDir}\n`);

  const store = new FiberGraphStore(':memory:');
  const indexer = new GraphIndexer(targetDir, store);

  try {
    // ========================================================================
    // 1. Cold Baseline Indexing
    // ========================================================================
    const indexRes = await indexer.indexCurrent();
    const byKind = store.db
      .prepare(
        `SELECT kind, COUNT(*) AS count FROM nodes WHERE layer = 'CURRENT' GROUP BY kind ORDER BY count DESC`
      )
      .all() as Array<{ kind: string; count: number }>;

    const byEdge = store.db
      .prepare(
        `SELECT edge_type, resolution_mode, COUNT(*) AS count FROM edges WHERE layer = 'CURRENT' GROUP BY edge_type, resolution_mode ORDER BY count DESC`
      )
      .all() as Array<{
      edge_type: string;
      resolution_mode: string;
      count: number;
    }>;

    console.log(`[1] Cold Baseline Indexing (CURRENT):`);
    console.log(
      `    Files Indexed  : ${indexRes.filesIndexed} (.ts/.tsx)\n` +
        `    Nodes Extracted: ${indexRes.nodesIndexed}\n` +
        `    Edges Linked   : ${indexRes.edgesIndexed}\n` +
        `    Cold Time      : ${indexRes.durationMs} ms (${Math.round((indexRes.filesIndexed / Math.max(indexRes.durationMs, 1)) * 1000)} files/sec)`
    );
    console.log(
      `    Nodes by Kind  : ${byKind.map((k) => `${k.kind}=${k.count}`).join(', ')}`
    );
    console.log(
      `    Edges Breakdown: ${byEdge.map((e) => `${e.edge_type}(${e.resolution_mode})=${e.count}`).join(', ')}`
    );

    // Locate target Button component (prefer react-vite Button in bulletproof-react, or fallback to first Button#component)
    const buttonCandidates = store.resolveEffectiveNodes('Button');
    const targetButton =
      buttonCandidates.find((n) =>
        n.node_id.includes('react-vite/src/components/ui/button/button.tsx::Button#component')
      ) ??
      buttonCandidates.find((n) => n.kind === 'component' && n.file_path.endsWith('button.tsx')) ??
      buttonCandidates[0];

    if (targetButton) {
      // ======================================================================
      // 2. Hub Damping Benchmark on Button#component (2-Hop Subgraph)
      // ======================================================================
      const tUndamped0 = performance.now();
      const subUndamped = store.querySubgraph(targetButton.node_id, 2, 100000);
      const undampedMs = Math.round((performance.now() - tUndamped0) * 100) / 100;
      const mUndamped = measureSubgraphContext(targetDir, subUndamped);

      const tDamped0 = performance.now();
      const subDamped = store.querySubgraph(targetButton.node_id, 2, 20);
      const dampedMs = Math.round((performance.now() - tDamped0) * 100) / 100;
      const mDamped = measureSubgraphContext(targetDir, subDamped);

      const plan = store.explainQuerySubgraph(targetButton.node_id, 2, 20);
      const hasTableScan = plan.some(
        (l) => l.includes('SCAN nodes') || l.includes('SCAN edges')
      );

      console.log(
        `\n[2] Hub Damping Benchmark — 2-Hop Subgraph from ${targetButton.node_id}:`
      );
      console.log(
        `    WITHOUT Hub Damping (via cn hub) : ${mUndamped.nodeCount} nodes across ${mUndamped.fileCount} files | Signatures: ${mUndamped.sigKb} KB (Raw files: ${mUndamped.rawFilesKb} KB) | ${undampedMs} ms`
      );
      console.log(
        `    WITH Hub Damping (maxInDeg = 20) : ${mDamped.nodeCount} nodes across ${mDamped.fileCount} files | Signatures: ${mDamped.sigKb} KB (Raw files: ${mDamped.rawFilesKb} KB) | ${dampedMs} ms`
      );
      console.log(
        `    Noise Reduction                  : -${mUndamped.nodeCount - mDamped.nodeCount} unrelated nodes (-${mUndamped.fileCount - mDamped.fileCount} files), Zero SCAN TABLE: ${!hasTableScan}`
      );
      console.log(`    EXPLAIN QUERY PLAN               :`);
      for (const line of plan) {
        console.log(`      | ${line}`);
      }
    }

    // ========================================================================
    // 3. Transitive Props Drift Benchmark (d=1 & d=2 on ButtonProps)
    // ========================================================================
    const propsCandidates = store.resolveEffectiveNodes('ButtonProps');
    const targetButtonProps =
      propsCandidates.find((n) =>
        n.node_id.includes('react-vite/src/components/ui/button/button.tsx::ButtonProps')
      ) ??
      propsCandidates.find((n) => n.file_path.endsWith('button.tsx')) ??
      propsCandidates[0];

    if (targetButtonProps) {
      const mutatedSig = `${targetButtonProps.signature} & { requiredTrackingId: string }`;
      const tRec0 = performance.now();
      store.upsertNode({
        ...targetButtonProps,
        layer: 'WIP',
        signature: mutatedSig,
        signature_hash: computeHash(mutatedSig),
      });

      const stale = store.reconcileWip();
      const recMs = Math.round((performance.now() - tRec0) * 100) / 100;

      const d1 = stale.filter((s) => s.propagation_depth === 1);
      const d2 = stale.filter((s) => s.propagation_depth === 2);

      console.log(
        `\n[3] Transitive Props Drift Benchmark (Mutated ${targetButtonProps.node_id} in WIP):`
      );
      console.log(
        `    Reconcile Latency : ${recMs} ms\n` +
          `    Total Stale Nodes : ${stale.length} (${d1.length} at d=1 DIRECT_SIGNATURE_MUTATION, ${d2.length} at d=2 TRANSITIVE_TYPE_CONTRACT_DRIFT)`
      );
      console.log(`    --- Depth 1 (Direct USES_TYPE of ButtonProps) ---`);
      for (const item of d1) {
        console.log(
          `      [d=1 ${item.mutation_kind}] ${item.stale_node_id} (${item.dependency_type} @ L${item.broken_at_line})`
        );
      }
      console.log(
        `    --- Depth 2 (Transitive Parent Components rendering <Button /> via RENDERS_JSX) ---`
      );
      for (const item of d2.slice(0, 12)) {
        console.log(
          `      [d=2 ${item.mutation_kind}] ${item.stale_node_id} (${item.dependency_type} @ L${item.broken_at_line})`
        );
      }
      if (d2.length > 12) {
        console.log(`      ... and ${d2.length - 12} more parent components at d=2`);
      }

      store.abortWip();
    }
  } finally {
    store.close();
    if (cleanupDir && targetDir && fs.existsSync(targetDir)) {
      fs.rmSync(targetDir, { recursive: true, force: true });
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
