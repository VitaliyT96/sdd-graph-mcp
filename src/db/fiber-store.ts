import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';

export type GraphLayer = 'CURRENT' | 'WIP';

export type NodeKind =
  | 'function'
  | 'component'
  | 'hook'
  | 'interface'
  | 'type_alias'
  | 'class'
  | 'method'
  | 'variable'
  | 'module';

export type EdgeType =
  | 'IMPORTS'
  | 'REEXPORTS'
  | 'CALLS'
  | 'RENDERS_JSX'
  | 'PASSES_PROPS'
  | 'USES_TYPE'
  | 'EXTENDS'
  | 'IMPLEMENTS_SPEC'
  | 'VERIFIED_BY_TEST';

export type ResolutionMode =
  | 'AST'
  | 'BARREL_UNWRAPPED'
  | 'LSP_TYPECHECKER'
  | 'SPEC_ANNOTATION';

export type MutationKind =
  | 'TOMBSTONED_TARGET'
  | 'DIRECT_SIGNATURE_MUTATION'
  | 'TRANSITIVE_TYPE_CONTRACT_DRIFT';

export interface GraphNodeInput {
  node_id: string;
  layer: GraphLayer;
  kind: NodeKind;
  name: string;
  file_path: string;
  start_line: number;
  end_line: number;
  signature: string;
  signature_hash?: string;
  body_hash?: string | null;
  jsdoc_summary?: string | null;
  is_exported?: boolean | 0 | 1;
  is_tombstone?: boolean | 0 | 1;
}

export interface GraphNodeRecord {
  node_id: string;
  layer: GraphLayer;
  kind: NodeKind;
  name: string;
  file_path: string;
  start_line: number;
  end_line: number;
  signature: string;
  signature_hash: string;
  body_hash: string | null;
  jsdoc_summary: string | null;
  is_exported: 0 | 1;
  is_tombstone: 0 | 1;
  updated_at: number;
}

export interface GraphEdgeInput {
  source_id: string;
  target_id: string;
  edge_type: EdgeType;
  layer: GraphLayer;
  call_site_line?: number | null;
  resolution_mode?: ResolutionMode;
  expected_target_hash?: string | null;
  is_tombstone?: boolean | 0 | 1;
}

export interface GraphEdgeRecord {
  source_id: string;
  target_id: string;
  edge_type: EdgeType;
  layer: GraphLayer;
  call_site_line: number | null;
  resolution_mode: ResolutionMode;
  expected_target_hash: string | null;
  is_tombstone: 0 | 1;
  updated_at: number;
}

export interface SubgraphNodeResult {
  node_id: string;
  hop_distance: number;
  active_layer: GraphLayer;
  kind: NodeKind;
  name: string;
  file_path: string;
  start_line: number;
  end_line: number;
  signature: string;
  signature_hash: string;
  jsdoc_summary: string | null;
  relation_trace: string;
}

export interface StaleContractReport {
  status: 'STALE_CONTRACT';
  stale_node_id: string;
  stale_node_kind: NodeKind;
  stale_file_path: string;
  broken_at_line: number;
  dependency_type: EdgeType;
  mutated_target_id: string;
  mutation_kind: MutationKind;
  propagation_depth: number;
  old_target_signature: string;
  new_target_signature: string;
  old_sig_hash: string;
  new_sig_hash: string;
}

export interface CommitResult {
  deletedNodes: number;
  deletedEdges: number;
  deletedSpecs: number;
  orphanedEdgesCleaned: number;
  promotedNodes: number;
  promotedEdges: number;
  promotedSpecs: number;
}

export interface AbortResult {
  clearedNodes: number;
  clearedEdges: number;
  clearedSpecs: number;
}

export interface StoreStats {
  currentNodes: number;
  currentEdges: number;
  wipLiveNodes: number;
  wipTombstoneNodes: number;
  wipLiveEdges: number;
  wipTombstoneEdges: number;
}

/**
 * Deterministic 16-hex-char (64-bit equivalent) hash for normalized signatures and AST bodies.
 */
export function computeHash(content: string): string {
  return createHash('sha256').update(content.trim()).digest('hex').slice(0, 16);
}

const SCHEMA_SQL = `
-- ============================================================================
-- ПРАГМЫ ПРОИЗВОДИТЕЛЬНОСТИ SQLite 3.51+
-- ============================================================================
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA temp_store = MEMORY;
PRAGMA mmap_size = 268435456;
PRAGMA foreign_keys = ON;

-- ============================================================================
-- 1. ТАБЛИЦА СПЕЦИФИКАЦИЙ (SDD Contracts & Requirements из .md файлов)
-- ============================================================================
CREATE TABLE IF NOT EXISTS specs (
  spec_id         TEXT NOT NULL,
  layer           TEXT NOT NULL CHECK (layer IN ('CURRENT', 'WIP')),
  file_path       TEXT NOT NULL,
  section_anchor  TEXT NOT NULL,
  title           TEXT NOT NULL,
  summary         TEXT NOT NULL,
  content_hash    TEXT NOT NULL,
  invariants_json TEXT NOT NULL DEFAULT '[]',
  is_tombstone    INTEGER NOT NULL DEFAULT 0 CHECK (is_tombstone IN (0, 1)),
  updated_at      INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (spec_id, layer)
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS idx_specs_layer_file
  ON specs(layer, file_path, is_tombstone);

-- ============================================================================
-- 2. ТАБЛИЦА УЗЛОВ AST-ГРАФА (Сигнатуры + JSDoc без тел функций)
-- ============================================================================
CREATE TABLE IF NOT EXISTS nodes (
  node_id         TEXT NOT NULL,
  layer           TEXT NOT NULL CHECK (layer IN ('CURRENT', 'WIP')),
  kind            TEXT NOT NULL CHECK (kind IN (
                    'function', 'component', 'hook', 'interface',
                    'type_alias', 'class', 'method', 'variable', 'module'
                  )),
  name            TEXT NOT NULL,
  file_path       TEXT NOT NULL,
  start_line      INTEGER NOT NULL,
  end_line        INTEGER NOT NULL,
  signature       TEXT NOT NULL,
  signature_hash  TEXT NOT NULL,
  body_hash       TEXT,
  jsdoc_summary   TEXT,
  is_exported     INTEGER NOT NULL DEFAULT 0 CHECK (is_exported IN (0, 1)),
  is_tombstone    INTEGER NOT NULL DEFAULT 0 CHECK (is_tombstone IN (0, 1)),
  updated_at      INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (node_id, layer)
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS idx_nodes_layer_mutation
  ON nodes(layer, node_id, signature_hash, is_tombstone);

CREATE INDEX IF NOT EXISTS idx_nodes_file_layer
  ON nodes(file_path, layer);

CREATE INDEX IF NOT EXISTS idx_nodes_name_layer
  ON nodes(name, layer);

-- ============================================================================
-- 3. ТАБЛИЦА РЁБЕР ГРАФА (Связи кода и привязка к спецификациям)
-- ============================================================================
CREATE TABLE IF NOT EXISTS edges (
  source_id            TEXT NOT NULL,
  target_id            TEXT NOT NULL,
  edge_type            TEXT NOT NULL CHECK (edge_type IN (
                         'IMPORTS',
                         'REEXPORTS',
                         'CALLS',
                         'RENDERS_JSX',
                         'PASSES_PROPS',
                         'USES_TYPE',
                         'EXTENDS',
                         'IMPLEMENTS_SPEC',
                         'VERIFIED_BY_TEST'
                       )),
  layer                TEXT NOT NULL CHECK (layer IN ('CURRENT', 'WIP')),
  call_site_line       INTEGER,
  resolution_mode      TEXT NOT NULL DEFAULT 'AST' CHECK (resolution_mode IN (
                         'AST', 'BARREL_UNWRAPPED', 'LSP_TYPECHECKER', 'SPEC_ANNOTATION'
                       )),
  expected_target_hash TEXT,
  is_tombstone         INTEGER NOT NULL DEFAULT 0 CHECK (is_tombstone IN (0, 1)),
  updated_at           INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (source_id, target_id, edge_type, layer)
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS idx_edges_target_lookup
  ON edges(target_id, edge_type, layer, source_id, is_tombstone);
`;

const QUERY_SUBGRAPH_SQL = `
WITH RECURSIVE
k_hop_subgraph(
  node_id,
  hop,
  path,
  via_edge,
  edge_layer,
  direction,
  call_site_line
) AS (
  -- 1. Базовый шаг (hop = 0): Разрешаем стартовый символ (WIP поверх CURRENT)
  SELECT
    COALESCE(w.node_id, c.node_id) AS node_id,
    0 AS hop,
    ',' || COALESCE(w.node_id, c.node_id) || ',' AS path,
    'SEED' AS via_edge,
    COALESCE(w.layer, c.layer) AS edge_layer,
    'ROOT' AS direction,
    COALESCE(w.start_line, c.start_line) AS call_site_line
  FROM (SELECT :target_symbol_id AS seed_id) s
  LEFT JOIN nodes w ON w.node_id = s.seed_id AND w.layer = 'WIP'
  LEFT JOIN nodes c ON c.node_id = s.seed_id AND c.layer = 'CURRENT'
  WHERE COALESCE(w.is_tombstone, c.is_tombstone, 1) = 0

  UNION ALL

  -- 2. Рекурсивный шаг (1..k): Двунаправленный обход виртуального графа
  SELECT
    CASE WHEN e.source_id = t.node_id THEN e.target_id ELSE e.source_id END AS node_id,
    t.hop + 1 AS hop,
    t.path || (CASE WHEN e.source_id = t.node_id THEN e.target_id ELSE e.source_id END) || ',' AS path,
    e.edge_type AS via_edge,
    COALESCE(ew.layer, ec.layer) AS edge_layer,
    CASE WHEN e.source_id = t.node_id THEN 'OUTBOUND' ELSE 'INBOUND' END AS direction,
    COALESCE(ew.call_site_line, ec.call_site_line) AS call_site_line
  FROM k_hop_subgraph t
  JOIN edges e
    ON (e.source_id = t.node_id OR e.target_id = t.node_id)
  -- Точечный Primary Key lookup для WIP и CURRENT версий этого же ребра
  LEFT JOIN edges ew
    ON ew.source_id = e.source_id
   AND ew.target_id = e.target_id
   AND ew.edge_type = e.edge_type
   AND ew.layer = 'WIP'
  LEFT JOIN edges ec
    ON ec.source_id = e.source_id
   AND ec.target_id = e.target_id
   AND ec.edge_type = e.edge_type
   AND ec.layer = 'CURRENT'
  -- Точечный Primary Key lookup для соседнего узла (WIP поверх CURRENT)
  LEFT JOIN nodes nw
    ON nw.node_id = (CASE WHEN e.source_id = t.node_id THEN e.target_id ELSE e.source_id END)
   AND nw.layer = 'WIP'
  LEFT JOIN nodes nc
    ON nc.node_id = (CASE WHEN e.source_id = t.node_id THEN e.target_id ELSE e.source_id END)
   AND nc.layer = 'CURRENT'
  WHERE t.hop < :max_hops
    -- Дедупликация CoW: если ребро есть в оба слоя, берём только строку победившего слоя
    AND e.layer = COALESCE(ew.layer, ec.layer)
    -- Отсекаем удалённые (tombstone) рёбра и удалённые соседние узлы в WIP
    AND COALESCE(ew.is_tombstone, ec.is_tombstone, 1) = 0
    AND COALESCE(nw.is_tombstone, nc.is_tombstone, 1) = 0
    -- Защита от «Супер-хабов» (Hub Damping): если пришли в промежуточный узел на шаге >= 1
    -- по OUTBOUND ребру, не разворачиваем из него обратные INBOUND рёбра, если узел является хабом.
    -- Подсчёт ограничен LIMIT (max + 1): стоимость O(min(in_degree, max)) вместо O(in_degree)
    -- на каждое ребро-кандидат (иначе суммарно O(in_degree^2) на хабах).
    AND NOT (
      t.hop >= 1
      AND t.direction = 'OUTBOUND'
      AND e.target_id = t.node_id
      AND (
        SELECT COUNT(*) FROM (
          SELECT DISTINCT eh.source_id
          FROM edges eh
          WHERE eh.target_id = t.node_id
            AND eh.is_tombstone = 0
          LIMIT :max_hub_in_degree + 1
        )
      ) > :max_hub_in_degree
    )
    -- Защита от циклов в путях обхода
    AND instr(
          t.path,
          ',' || (CASE WHEN e.source_id = t.node_id THEN e.target_id ELSE e.source_id END) || ','
        ) = 0
)
-- 3. Финальная проекция с детерминированной сортировкой (для сохранения Prompt Cache)
SELECT
  t.node_id,
  MIN(t.hop) AS hop_distance,
  COALESCE(w.layer, c.layer) AS active_layer,
  COALESCE(w.kind, c.kind) AS kind,
  COALESCE(w.name, c.name) AS name,
  COALESCE(w.file_path, c.file_path) AS file_path,
  COALESCE(w.start_line, c.start_line) AS start_line,
  COALESCE(w.end_line, c.end_line) AS end_line,
  COALESCE(w.signature, c.signature) AS signature,
  COALESCE(w.signature_hash, c.signature_hash) AS signature_hash,
  COALESCE(w.jsdoc_summary, c.jsdoc_summary) AS jsdoc_summary,
  GROUP_CONCAT(
    DISTINCT t.direction || ':' || t.via_edge || '@L' || COALESCE(t.call_site_line, 0) || '(' || t.edge_layer || ')'
  ) AS relation_trace
FROM k_hop_subgraph t
LEFT JOIN nodes w ON w.node_id = t.node_id AND w.layer = 'WIP'
LEFT JOIN nodes c ON c.node_id = t.node_id AND c.layer = 'CURRENT'
GROUP BY t.node_id
ORDER BY hop_distance ASC, t.node_id ASC;
`;

const RECONCILE_WIP_SQL = `
WITH RECURSIVE
reconciliation_cte(
  stale_node_id,
  stale_node_kind,
  stale_file_path,
  stale_node_signature,
  broken_at_line,
  dependency_type,
  mutated_target_id,
  mutation_kind,
  old_target_signature,
  new_target_signature,
  old_sig_hash,
  new_sig_hash,
  propagation_depth,
  visit_path
) AS (
  -- 1. Базовый шаг (Depth = 1): Прямые потребители в CURRENT, чьи цели в WIP изменили signature_hash или удалены
  SELECT
    caller_c.node_id AS stale_node_id,
    caller_c.kind AS stale_node_kind,
    caller_c.file_path AS stale_file_path,
    caller_c.signature AS stale_node_signature,
    COALESCE(ew.call_site_line, ec.call_site_line, caller_c.start_line) AS broken_at_line,
    COALESCE(ew.edge_type, ec.edge_type) AS dependency_type,
    target_w.node_id AS mutated_target_id,
    CASE
      WHEN target_w.is_tombstone = 1 THEN 'TOMBSTONED_TARGET'
      ELSE 'DIRECT_SIGNATURE_MUTATION'
    END AS mutation_kind,
    target_c.signature AS old_target_signature,
    CASE
      WHEN target_w.is_tombstone = 1 THEN '<DELETED_IN_WIP>'
      ELSE COALESCE(NULLIF(target_w.signature, ''), '<DELETED_IN_WIP>')
    END AS new_target_signature,
    target_c.signature_hash AS old_sig_hash,
    target_w.signature_hash AS new_sig_hash,
    1 AS propagation_depth,
    ',' || target_w.node_id || ',' || caller_c.node_id || ',' AS visit_path
  FROM nodes target_w
  JOIN nodes target_c
    ON target_c.node_id = target_w.node_id
   AND target_c.layer = 'CURRENT'
  -- Входящие рёбра CALLS / USES_TYPE / RENDERS_JSX / PASSES_PROPS к изменённому узлу target_w
  JOIN edges ec
    ON ec.target_id = target_w.node_id
   AND ec.layer = 'CURRENT'
   AND ec.edge_type IN ('CALLS', 'USES_TYPE', 'RENDERS_JSX', 'PASSES_PROPS')
  LEFT JOIN edges ew
    ON ew.source_id = ec.source_id
   AND ew.target_id = ec.target_id
   AND ew.edge_type = ec.edge_type
   AND ew.layer = 'WIP'
  -- Узел-потребитель в базовом слое CURRENT
  JOIN nodes caller_c
    ON caller_c.node_id = ec.source_id
   AND caller_c.layer = 'CURRENT'
  -- Проверяем, был ли узел-потребитель уже обновлён в слое WIP
  LEFT JOIN nodes caller_w
    ON caller_w.node_id = caller_c.node_id
   AND caller_w.layer = 'WIP'
  WHERE target_w.layer = 'WIP'
    -- Контракт целевого узла изменился (или целевой узел удалён как tombstone)
    AND (
      target_w.is_tombstone = 1
      OR target_w.signature_hash != target_c.signature_hash
    )
    -- Само ребро зависимости не было удалено (tombstoned) в WIP
    AND COALESCE(ew.is_tombstone, ec.is_tombstone, 0) = 0
    -- Узел-потребитель ещё НЕ адаптирован под новый контракт:
    --  (a) его нет в WIP; ИЛИ
    --  (b) он попал в WIP лишь как побочный эффект ре-парсинга файла (body_hash и signature_hash
    --      не изменились относительно CURRENT) — повторный парсинг НЕ является подтверждением; ИЛИ
    --  (c) его ребро к T всё ещё указывает на старый хеш контракта.
    AND (
      caller_w.node_id IS NULL
      OR (
        caller_w.is_tombstone = 0
        AND (
          (caller_w.body_hash IS caller_c.body_hash AND caller_w.signature_hash = caller_c.signature_hash)
          OR COALESCE(ew.expected_target_hash, ec.expected_target_hash, target_c.signature_hash) != target_w.signature_hash
        )
      )
    )

  UNION ALL

  -- 2. Рекурсивный шаг (Depth = 2..3): Транзитивное протекание сломанного контракта
  --    через интерфейсы/типы ИЛИ от компонента (d=1 через USES_TYPE пропсов) к родителям (d=2 через RENDERS_JSX / PASSES_PROPS)
  SELECT
    upstream_c.node_id AS stale_node_id,
    upstream_c.kind AS stale_node_kind,
    upstream_c.file_path AS stale_file_path,
    upstream_c.signature AS stale_node_signature,
    COALESCE(ew.call_site_line, ec.call_site_line, upstream_c.start_line) AS broken_at_line,
    COALESCE(ew.edge_type, ec.edge_type) AS dependency_type,
    r.stale_node_id AS mutated_target_id,
    'TRANSITIVE_TYPE_CONTRACT_DRIFT' AS mutation_kind,
    r.old_target_signature,
    r.new_target_signature,
    r.old_sig_hash,
    r.new_sig_hash,
    r.propagation_depth + 1 AS propagation_depth,
    r.visit_path || upstream_c.node_id || ',' AS visit_path
  FROM reconciliation_cte r
  JOIN edges ec
    ON ec.target_id = r.stale_node_id
   AND ec.layer = 'CURRENT'
  LEFT JOIN edges ew
    ON ew.source_id = ec.source_id
   AND ew.target_id = ec.target_id
   AND ew.edge_type = ec.edge_type
   AND ew.layer = 'WIP'
  JOIN nodes upstream_c
    ON upstream_c.node_id = ec.source_id
   AND upstream_c.layer = 'CURRENT'
  LEFT JOIN nodes upstream_w
    ON upstream_w.node_id = upstream_c.node_id
   AND upstream_w.layer = 'WIP'
  WHERE (
      (
        r.stale_node_kind IN ('interface', 'type_alias')
        AND ec.edge_type IN ('USES_TYPE', 'PASSES_PROPS', 'EXTENDS')
      )
      OR (
        r.stale_node_kind = 'component'
        AND r.propagation_depth = 1
        AND r.dependency_type = 'USES_TYPE'
        AND ec.edge_type IN ('RENDERS_JSX', 'PASSES_PROPS')
      )
    )
    AND r.propagation_depth < 3
    AND COALESCE(ew.is_tombstone, ec.is_tombstone, 0) = 0
    -- Та же семантика подтверждения, что и на d=1: ре-парсинг без изменений не снимает дрейф
    AND (
      upstream_w.node_id IS NULL
      OR (upstream_w.body_hash IS upstream_c.body_hash AND upstream_w.signature_hash = upstream_c.signature_hash)
    )
    AND instr(r.visit_path, ',' || upstream_c.node_id || ',') = 0
)
SELECT
  'STALE_CONTRACT' AS status,
  stale_node_id,
  stale_node_kind,
  stale_file_path,
  broken_at_line,
  dependency_type,
  mutated_target_id,
  mutation_kind,
  propagation_depth,
  old_target_signature,
  new_target_signature,
  old_sig_hash,
  new_sig_hash
FROM reconciliation_cte
ORDER BY propagation_depth ASC, stale_file_path ASC, broken_at_line ASC;
`;

export class FiberGraphStore {
  public readonly db: DatabaseSync;

  constructor(dbPath: string = ':memory:') {
    this.db = new DatabaseSync(dbPath);
    this.db.exec(SCHEMA_SQL);
  }

  /**
   * Upserts a node into the specified layer ('CURRENT' or 'WIP').
   * Automatically computes signature_hash from normalized signature if omitted.
   */
  public upsertNode(input: GraphNodeInput): void {
    const sigHash = input.signature_hash ?? computeHash(input.signature);
    const isExported = input.is_exported ? 1 : 0;
    const isTombstone = input.is_tombstone ? 1 : 0;

    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO nodes (
        node_id, layer, kind, name, file_path, start_line, end_line,
        signature, signature_hash, body_hash, jsdoc_summary,
        is_exported, is_tombstone, updated_at
      ) VALUES (
        :node_id, :layer, :kind, :name, :file_path, :start_line, :end_line,
        :signature, :signature_hash, :body_hash, :jsdoc_summary,
        :is_exported, :is_tombstone, unixepoch()
      )
    `);

    stmt.run({
      ':node_id': input.node_id,
      ':layer': input.layer,
      ':kind': input.kind,
      ':name': input.name,
      ':file_path': input.file_path,
      ':start_line': input.start_line,
      ':end_line': input.end_line,
      ':signature': input.signature,
      ':signature_hash': sigHash,
      ':body_hash': input.body_hash ?? null,
      ':jsdoc_summary': input.jsdoc_summary ?? null,
      ':is_exported': isExported,
      ':is_tombstone': isTombstone,
    });
  }

  /**
   * Batch-upserts multiple nodes inside a single transaction.
   */
  public upsertNodes(inputs: GraphNodeInput[]): void {
    this.db.exec('BEGIN IMMEDIATE TRANSACTION');
    try {
      for (const node of inputs) {
        this.upsertNode(node);
      }
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  /**
   * Marks a symbol as deleted (is_tombstone = 1) in the WIP layer without mutating CURRENT.
   */
  public tombstoneNode(nodeId: string): void {
    const existing =
      this.getNodeInLayer(nodeId, 'WIP') ??
      this.getNodeInLayer(nodeId, 'CURRENT');

    this.upsertNode({
      node_id: nodeId,
      layer: 'WIP',
      kind: existing?.kind ?? 'function',
      name: existing?.name ?? (nodeId.split('::')[1]?.split('#')[0] ?? nodeId),
      file_path: existing?.file_path ?? (nodeId.split('::')[0] ?? ''),
      start_line: existing?.start_line ?? 0,
      end_line: existing?.end_line ?? 0,
      signature: '',
      signature_hash: '<TOMBSTONE>',
      body_hash: null,
      jsdoc_summary: null,
      is_exported: existing?.is_exported ?? 0,
      is_tombstone: 1,
    });
  }

  /**
   * Upserts a directed edge into the specified layer ('CURRENT' or 'WIP').
   */
  public upsertEdge(input: GraphEdgeInput): void {
    const isTombstone = input.is_tombstone ? 1 : 0;
    const resolutionMode = input.resolution_mode ?? 'AST';

    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO edges (
        source_id, target_id, edge_type, layer, call_site_line,
        resolution_mode, expected_target_hash, is_tombstone, updated_at
      ) VALUES (
        :source_id, :target_id, :edge_type, :layer, :call_site_line,
        :resolution_mode, :expected_target_hash, :is_tombstone, unixepoch()
      )
    `);

    stmt.run({
      ':source_id': input.source_id,
      ':target_id': input.target_id,
      ':edge_type': input.edge_type,
      ':layer': input.layer,
      ':call_site_line': input.call_site_line ?? null,
      ':resolution_mode': resolutionMode,
      ':expected_target_hash': input.expected_target_hash ?? null,
      ':is_tombstone': isTombstone,
    });
  }

  /**
   * Batch-upserts multiple edges inside a single transaction.
   */
  public upsertEdges(inputs: GraphEdgeInput[]): void {
    this.db.exec('BEGIN IMMEDIATE TRANSACTION');
    try {
      for (const edge of inputs) {
        this.upsertEdge(edge);
      }
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  /**
   * Marks an edge as deleted (is_tombstone = 1) in the WIP layer without mutating CURRENT.
   */
  public tombstoneEdge(
    sourceId: string,
    targetId: string,
    edgeType: EdgeType
  ): void {
    this.upsertEdge({
      source_id: sourceId,
      target_id: targetId,
      edge_type: edgeType,
      layer: 'WIP',
      call_site_line: null,
      resolution_mode: 'AST',
      expected_target_hash: null,
      is_tombstone: 1,
    });
  }

  /**
   * Retrieves a node record from a specific layer ('CURRENT' or 'WIP').
   */
  public getNodeInLayer(
    nodeId: string,
    layer: GraphLayer
  ): GraphNodeRecord | null {
    const stmt = this.db.prepare(`
      SELECT * FROM nodes WHERE node_id = :node_id AND layer = :layer
    `);
    const row = stmt.get({ ':node_id': nodeId, ':layer': layer }) as
      | GraphNodeRecord
      | undefined;
    return row ?? null;
  }

  /**
   * Resolves the effective state of a node (WIP overlaid on CURRENT with tombstone semantics).
   */
  public getEffectiveNode(nodeId: string): GraphNodeRecord | null {
    const stmt = this.db.prepare(`
      SELECT
        COALESCE(w.node_id, c.node_id) AS node_id,
        COALESCE(w.layer, c.layer) AS layer,
        COALESCE(w.kind, c.kind) AS kind,
        COALESCE(w.name, c.name) AS name,
        COALESCE(w.file_path, c.file_path) AS file_path,
        COALESCE(w.start_line, c.start_line) AS start_line,
        COALESCE(w.end_line, c.end_line) AS end_line,
        COALESCE(w.signature, c.signature) AS signature,
        COALESCE(w.signature_hash, c.signature_hash) AS signature_hash,
        COALESCE(w.body_hash, c.body_hash) AS body_hash,
        COALESCE(w.jsdoc_summary, c.jsdoc_summary) AS jsdoc_summary,
        COALESCE(w.is_exported, c.is_exported) AS is_exported,
        COALESCE(w.is_tombstone, c.is_tombstone) AS is_tombstone,
        COALESCE(w.updated_at, c.updated_at) AS updated_at
      FROM (SELECT :node_id AS target_id) s
      LEFT JOIN nodes w ON w.node_id = s.target_id AND w.layer = 'WIP'
      LEFT JOIN nodes c ON c.node_id = s.target_id AND c.layer = 'CURRENT'
      WHERE COALESCE(w.is_tombstone, c.is_tombstone, 1) = 0
    `);
    const row = stmt.get({ ':node_id': nodeId }) as GraphNodeRecord | undefined;
    return row ?? null;
  }

  /**
   * Resolves a canonical node_id OR a short symbol name (e.g. 'verifyToken')
   * to active effective nodes (WIP overlaid on CURRENT, excluding tombstones).
   */
  public resolveEffectiveNodes(symbolIdOrName: string): GraphNodeRecord[] {
    const exact = this.getEffectiveNode(symbolIdOrName);
    if (exact) {
      return [exact];
    }

    const stmt = this.db.prepare(`
      SELECT
        COALESCE(w.node_id, c.node_id) AS node_id,
        COALESCE(w.layer, c.layer) AS layer,
        COALESCE(w.kind, c.kind) AS kind,
        COALESCE(w.name, c.name) AS name,
        COALESCE(w.file_path, c.file_path) AS file_path,
        COALESCE(w.start_line, c.start_line) AS start_line,
        COALESCE(w.end_line, c.end_line) AS end_line,
        COALESCE(w.signature, c.signature) AS signature,
        COALESCE(w.signature_hash, c.signature_hash) AS signature_hash,
        COALESCE(w.body_hash, c.body_hash) AS body_hash,
        COALESCE(w.jsdoc_summary, c.jsdoc_summary) AS jsdoc_summary,
        COALESCE(w.is_exported, c.is_exported) AS is_exported,
        COALESCE(w.is_tombstone, c.is_tombstone) AS is_tombstone,
        COALESCE(w.updated_at, c.updated_at) AS updated_at
      FROM (
        SELECT DISTINCT node_id FROM nodes WHERE name = :name
      ) ids
      LEFT JOIN nodes w ON w.node_id = ids.node_id AND w.layer = 'WIP'
      LEFT JOIN nodes c ON c.node_id = ids.node_id AND c.layer = 'CURRENT'
      WHERE COALESCE(w.is_tombstone, c.is_tombstone, 1) = 0
        AND COALESCE(w.name, c.name) = :name
      ORDER BY node_id ASC
    `);

    return stmt.all({ ':name': symbolIdOrName }) as unknown as GraphNodeRecord[];
  }

  /**
   * Section 2.4: Reads the virtual merged k-hop subgraph (WIP overlaid on CURRENT)
   * without materializing the entire database, ordered deterministically for Prompt Cache stability.
   */
  public querySubgraph(
    symbolId: string,
    maxHops: number = 2,
    maxHubInDegree: number = 20
  ): SubgraphNodeResult[] {
    const stmt = this.db.prepare(QUERY_SUBGRAPH_SQL);
    const rows = stmt.all({
      ':target_symbol_id': symbolId,
      ':max_hops': maxHops,
      ':max_hub_in_degree': maxHubInDegree,
    }) as unknown as SubgraphNodeResult[];
    return rows;
  }

  /**
   * Returns EXPLAIN QUERY PLAN details for querySubgraph to verify index-only B-Tree lookups.
   */
  public explainQuerySubgraph(
    symbolId: string,
    maxHops: number = 2,
    maxHubInDegree: number = 20
  ): string[] {
    const stmt = this.db.prepare(`EXPLAIN QUERY PLAN ${QUERY_SUBGRAPH_SQL}`);
    const rows = stmt.all({
      ':target_symbol_id': symbolId,
      ':max_hops': maxHops,
      ':max_hub_in_degree': maxHubInDegree,
    }) as Array<{ detail: string }>;
    return rows.map((r) => r.detail);
  }

  /**
   * Section 2.5: Runs the Reconciliation phase (Render Phase in React Fiber terms),
   * detecting all direct and transitive STALE_CONTRACT nodes affected by WIP signature mutations or tombstones.
   */
  public reconcileWip(): StaleContractReport[] {
    const stmt = this.db.prepare(RECONCILE_WIP_SQL);
    const rows = stmt.all() as unknown as StaleContractReport[];
    return rows;
  }

  /**
   * Section 2.6: Atomic Commit Phase (WIP -> CURRENT).
   * Applies tombstones, cleans up orphaned edges, promotes live WIP records to CURRENT, and clears WIP.
   */
  public commitWip(): CommitResult {
    this.db.exec('BEGIN IMMEDIATE TRANSACTION');
    try {
      // 1. Apply Tombstones: physically delete from CURRENT any nodes, edges, or specs tombstoned in WIP
      const delNodes = this.db
        .prepare(`
          DELETE FROM nodes
          WHERE layer = 'CURRENT'
            AND node_id IN (SELECT node_id FROM nodes WHERE layer = 'WIP' AND is_tombstone = 1)
        `)
        .run();

      const delEdges = this.db
        .prepare(`
          DELETE FROM edges
          WHERE layer = 'CURRENT'
            AND (source_id, target_id, edge_type) IN (
              SELECT source_id, target_id, edge_type FROM edges WHERE layer = 'WIP' AND is_tombstone = 1
            )
        `)
        .run();

      const delSpecs = this.db
        .prepare(`
          DELETE FROM specs
          WHERE layer = 'CURRENT'
            AND spec_id IN (SELECT spec_id FROM specs WHERE layer = 'WIP' AND is_tombstone = 1)
        `)
        .run();

      // 2. Promote (Upsert) live records from WIP to CURRENT
      const promNodes = this.db
        .prepare(`
          INSERT OR REPLACE INTO nodes (
            node_id, layer, kind, name, file_path, start_line, end_line,
            signature, signature_hash, body_hash, jsdoc_summary, is_exported, is_tombstone, updated_at
          )
          SELECT
            node_id, 'CURRENT', kind, name, file_path, start_line, end_line,
            signature, signature_hash, body_hash, jsdoc_summary, is_exported, 0, unixepoch()
          FROM nodes
          WHERE layer = 'WIP' AND is_tombstone = 0
        `)
        .run();

      const promEdges = this.db
        .prepare(`
          INSERT OR REPLACE INTO edges (
            source_id, target_id, edge_type, layer, call_site_line,
            resolution_mode, expected_target_hash, is_tombstone, updated_at
          )
          SELECT
            source_id, target_id, edge_type, 'CURRENT', call_site_line,
            resolution_mode, expected_target_hash, 0, unixepoch()
          FROM edges
          WHERE layer = 'WIP' AND is_tombstone = 0
        `)
        .run();

      const promSpecs = this.db
        .prepare(`
          INSERT OR REPLACE INTO specs (
            spec_id, layer, file_path, section_anchor, title, summary,
            content_hash, invariants_json, is_tombstone, updated_at
          )
          SELECT
            spec_id, 'CURRENT', file_path, section_anchor, title, summary,
            content_hash, invariants_json, 0, unixepoch()
          FROM specs
          WHERE layer = 'WIP' AND is_tombstone = 0
        `)
        .run();

      // 3. Cascade cleanup of orphaned edges in CURRENT whose endpoints were removed via tombstone
      const orphanEdges = this.db
        .prepare(`
          DELETE FROM edges
          WHERE layer = 'CURRENT'
            AND (
              edge_type != 'IMPLEMENTS_SPEC'
              AND (
                source_id NOT IN (SELECT node_id FROM nodes WHERE layer = 'CURRENT')
                OR target_id NOT IN (SELECT node_id FROM nodes WHERE layer = 'CURRENT')
              )
            )
        `)
        .run();

      // 4. Clear WIP buffer
      this.db.prepare(`DELETE FROM nodes WHERE layer = 'WIP'`).run();
      this.db.prepare(`DELETE FROM edges WHERE layer = 'WIP'`).run();
      this.db.prepare(`DELETE FROM specs WHERE layer = 'WIP'`).run();

      this.db.exec('COMMIT');

      return {
        deletedNodes: Number(delNodes.changes),
        deletedEdges: Number(delEdges.changes),
        deletedSpecs: Number(delSpecs.changes),
        orphanedEdgesCleaned: Number(orphanEdges.changes),
        promotedNodes: Number(promNodes.changes),
        promotedEdges: Number(promEdges.changes),
        promotedSpecs: Number(promSpecs.changes),
      };
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  /**
   * Section 2.6: Instant Rollback / Abort Phase.
   * Discards all WIP mutations and tombstones without touching CURRENT.
   */
  public abortWip(): AbortResult {
    this.db.exec('BEGIN IMMEDIATE TRANSACTION');
    try {
      const n = this.db.prepare(`DELETE FROM nodes WHERE layer = 'WIP'`).run();
      const e = this.db.prepare(`DELETE FROM edges WHERE layer = 'WIP'`).run();
      const s = this.db.prepare(`DELETE FROM specs WHERE layer = 'WIP'`).run();
      this.db.exec('COMMIT');
      return {
        clearedNodes: Number(n.changes),
        clearedEdges: Number(e.changes),
        clearedSpecs: Number(s.changes),
      };
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  /**
   * Retrieves all node records for a specific file_path in the given layer.
   */
  public getNodesByFileInLayer(
    filePath: string,
    layer: GraphLayer
  ): GraphNodeRecord[] {
    const stmt = this.db.prepare(`
      SELECT * FROM nodes
      WHERE file_path = :file_path AND layer = :layer
      ORDER BY node_id ASC
    `);
    return stmt.all({
      ':file_path': filePath,
      ':layer': layer,
    }) as unknown as GraphNodeRecord[];
  }

  /**
   * Returns a map of file_path -> active effective nodes (WIP overlaid on CURRENT, excluding tombstones).
   */
  public getEffectiveNodesByFileMap(): Map<string, GraphNodeRecord[]> {
    const stmt = this.db.prepare(`
      SELECT
        COALESCE(w.node_id, c.node_id) AS node_id,
        COALESCE(w.layer, c.layer) AS layer,
        COALESCE(w.kind, c.kind) AS kind,
        COALESCE(w.name, c.name) AS name,
        COALESCE(w.file_path, c.file_path) AS file_path,
        COALESCE(w.start_line, c.start_line) AS start_line,
        COALESCE(w.end_line, c.end_line) AS end_line,
        COALESCE(w.signature, c.signature) AS signature,
        COALESCE(w.signature_hash, c.signature_hash) AS signature_hash,
        COALESCE(w.body_hash, c.body_hash) AS body_hash,
        COALESCE(w.jsdoc_summary, c.jsdoc_summary) AS jsdoc_summary,
        COALESCE(w.is_exported, c.is_exported) AS is_exported,
        COALESCE(w.is_tombstone, c.is_tombstone) AS is_tombstone,
        COALESCE(w.updated_at, c.updated_at) AS updated_at
      FROM (
        SELECT DISTINCT node_id FROM nodes
      ) ids
      LEFT JOIN nodes w ON w.node_id = ids.node_id AND w.layer = 'WIP'
      LEFT JOIN nodes c ON c.node_id = ids.node_id AND c.layer = 'CURRENT'
      WHERE COALESCE(w.is_tombstone, c.is_tombstone, 1) = 0
      ORDER BY file_path ASC, node_id ASC
    `);
    const rows = stmt.all() as unknown as GraphNodeRecord[];
    const map = new Map<string, GraphNodeRecord[]>();
    for (const row of rows) {
      let list = map.get(row.file_path);
      if (!list) {
        list = [];
        map.set(row.file_path, list);
      }
      list.push(row);
    }
    return map;
  }

  /**
   * Retrieves all outbound edge records from source_id in the given layer.
   */
  public getOutboundEdgesInLayer(
    sourceId: string,
    layer: GraphLayer
  ): GraphEdgeRecord[] {
    const stmt = this.db.prepare(`
      SELECT * FROM edges
      WHERE source_id = :source_id AND layer = :layer
      ORDER BY target_id ASC, edge_type ASC
    `);
    return stmt.all({
      ':source_id': sourceId,
      ':layer': layer,
    }) as unknown as GraphEdgeRecord[];
  }

  /**
   * Deletes a WIP-only node record (used when a symbol created in WIP is deleted before commit).
   */
  public deleteWipRecordForNode(nodeId: string): void {
    this.db
      .prepare(`DELETE FROM nodes WHERE node_id = :node_id AND layer = 'WIP'`)
      .run({ ':node_id': nodeId });
  }

  /**
   * Deletes a WIP-only edge record.
   */
  public deleteWipRecordForEdge(
    sourceId: string,
    targetId: string,
    edgeType: EdgeType
  ): void {
    this.db
      .prepare(`
        DELETE FROM edges
        WHERE source_id = :source_id
          AND target_id = :target_id
          AND edge_type = :edge_type
          AND layer = 'WIP'
      `)
      .run({
        ':source_id': sourceId,
        ':target_id': targetId,
        ':edge_type': edgeType,
      });
  }

  /**
   * Clears all layers (CURRENT and WIP) before a full baseline re-index.
   */
  public clearAll(): void {
    this.db.exec('BEGIN IMMEDIATE TRANSACTION');
    try {
      this.db.prepare(`DELETE FROM edges`).run();
      this.db.prepare(`DELETE FROM nodes`).run();
      this.db.prepare(`DELETE FROM specs`).run();
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  /**
   * Returns summary counts of nodes and edges across CURRENT and WIP layers.
   */
  public getStats(): StoreStats {
    const count = (sql: string): number => {
      const row = this.db.prepare(sql).get() as { c: number } | undefined;
      return Number(row?.c ?? 0);
    };

    return {
      currentNodes: count(`SELECT COUNT(*) AS c FROM nodes WHERE layer = 'CURRENT'`),
      currentEdges: count(`SELECT COUNT(*) AS c FROM edges WHERE layer = 'CURRENT'`),
      wipLiveNodes: count(
        `SELECT COUNT(*) AS c FROM nodes WHERE layer = 'WIP' AND is_tombstone = 0`
      ),
      wipTombstoneNodes: count(
        `SELECT COUNT(*) AS c FROM nodes WHERE layer = 'WIP' AND is_tombstone = 1`
      ),
      wipLiveEdges: count(
        `SELECT COUNT(*) AS c FROM edges WHERE layer = 'WIP' AND is_tombstone = 0`
      ),
      wipTombstoneEdges: count(
        `SELECT COUNT(*) AS c FROM edges WHERE layer = 'WIP' AND is_tombstone = 1`
      ),
    };
  }

  public close(): void {
    this.db.close();
  }
}
