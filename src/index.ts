#!/usr/bin/env node
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createSddMcpServer } from './mcp/server.ts';

export * from './db/fiber-store.ts';
export * from './parser/path-resolver.ts';
export * from './parser/ts-extractor.ts';
export * from './indexer/graph-indexer.ts';
export * from './mcp/server.ts';

function parseCliArgs(argv: string[]): {
  projectRoot: string;
  dbPath: string;
  autoInit: boolean;
} {
  let projectRoot = process.env.SDD_PROJECT_ROOT ?? process.cwd();
  let dbPath = process.env.SDD_DB_PATH ?? '.sdd-graph/sdd-graph.db';
  let autoInit = process.env.SDD_AUTO_INIT === '1';

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--project-root' && argv[i + 1]) {
      projectRoot = argv[++i];
    } else if (arg === '--db-path' && argv[i + 1]) {
      dbPath = argv[++i];
    } else if (arg === '--memory') {
      dbPath = ':memory:';
    } else if (arg === '--init-current') {
      autoInit = true;
    }
  }

  return {
    projectRoot: path.resolve(projectRoot),
    dbPath,
    autoInit,
  };
}

export async function runStdioServer(argv: string[] = process.argv.slice(2)): Promise<void> {
  const { projectRoot, dbPath, autoInit } = parseCliArgs(argv);
  const { mcpServer, indexer } = createSddMcpServer({
    projectRoot,
    dbPath,
  });

  if (autoInit) {
    await indexer.indexCurrent();
  }

  const transport = new StdioServerTransport();
  await mcpServer.connect(transport);
}

const isMainModule =
  process.argv[1] &&
  pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;

if (isMainModule) {
  runStdioServer().catch((err) => {
    console.error('[sdd-graph-mcp] Fatal startup error:', err);
    process.exit(1);
  });
}
