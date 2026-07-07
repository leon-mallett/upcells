import { invoke } from "@tauri-apps/api/core";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface Connection {
  id: string;
  name: string;
  type: string;
  instance_url: string | null;
  client_id: string | null;
  username: string | null;
  status: "untested" | "connected" | "error";
  created_at: number;
  updated_at: number;
  last_tested: number | null;
}

export interface ConnectionTestResult {
  success: boolean;
  username: string | null;
  api_versions: string[];
  message: string;
}

export type LicenseStatus =
  | "valid"
  | "trial"
  | "expired"
  | "suspended"
  | "not_activated"
  | "not_found"
  | "invalid";

export interface LicenseInfo {
  status: LicenseStatus;
  key: string;
  expiry: string | null;
  machine_count: number | null;
  machine_limit: number | null;
  message: string;
  /** Whether this licence includes the Sales Accelerator (local-AI) tier. */
  sales_accelerator: boolean;
}

export interface AppError {
  code: string;
  message: string;
}

// ── Connection commands ───────────────────────────────────────────────────────
// Note: Tauri 2 expects camelCase argument names on the JS side, which it
// converts to snake_case before passing to the Rust command handler.

export const listConnections = (): Promise<Connection[]> =>
  invoke("list_connections");

export const createConnection = (args: {
  name: string;
  instance_url: string;
  client_id: string;
}): Promise<Connection> =>
  invoke("create_connection", {
    name: args.name,
    instanceUrl: args.instance_url,
    clientId: args.client_id,
  });

export const updateConnection = (args: {
  id: string;
  name?: string;
  instance_url?: string;
  client_id?: string;
}): Promise<Connection> =>
  invoke("update_connection", {
    id: args.id,
    name: args.name,
    instanceUrl: args.instance_url,
    clientId: args.client_id,
  });

export const deleteConnection = (id: string): Promise<void> =>
  invoke("delete_connection", { id });

export const startSalesforceOAuth = (args: {
  connection_id: string;
  instance_url: string;
  client_id: string;
}): Promise<string> =>
  invoke("start_salesforce_oauth", {
    connectionId: args.connection_id,
    instanceUrl: args.instance_url,
    clientId: args.client_id,
  });

export const cancelOAuth = (): Promise<void> =>
  invoke("cancel_oauth");

// ── Query types ───────────────────────────────────────────────────────────────

export interface SObjectListItem {
  name: string;
  label: string;
  queryable: boolean;
}

export interface PicklistValue {
  value: string;
  label: string | null;
  active: boolean;
}

export interface SObjectField {
  name: string;
  label: string;
  field_type: string;
  filterable: boolean;
  sortable: boolean;
  nillable: boolean;
  updateable: boolean;
  createable: boolean;
  restricted_picklist: boolean;
  picklist_values: PicklistValue[];
  /** For reference fields, the relationship name used in dotted SOQL
   *  (e.g. Opportunity.AccountId has `relationship_name: "Account"`). */
  relationship_name: string | null;
  /** Target SObject type(s) for a reference field. Polymorphic lookups
   *  have more than one entry. */
  reference_to: string[];
}

export interface SObjectDescribe {
  name: string;
  label: string;
  queryable: boolean;
  fields: SObjectField[];
}

export interface QueryResult {
  total_size: number;
  fetched_count: number;
  records: Record<string, unknown>[];
  columns: string[];
}

export interface SavedQuery {
  id: string;
  name: string;
  connection_id: string | null;
  soql_text: string;
  object_name: string | null;
  last_run: number | null;
  last_record_count: number | null;
  created_at: number;
  updated_at: number;
}

// ── Query commands ────────────────────────────────────────────────────────────

export const listSobjects = (connection_id: string): Promise<SObjectListItem[]> =>
  invoke("list_sobjects", { connectionId: connection_id });

export const describeObject = (
  connection_id: string,
  object_name: string
): Promise<SObjectDescribe> =>
  invoke("describe_object", { connectionId: connection_id, objectName: object_name });

export const executeQuery = (args: {
  connection_id: string;
  soql: string;
  query_id?: string;
  columns?: string[];
}): Promise<QueryResult> =>
  invoke("execute_query", {
    connectionId: args.connection_id,
    soql: args.soql,
    queryId: args.query_id ?? null,
    columns: args.columns ?? null,
  });

export const listSavedQueries = (connection_id?: string): Promise<SavedQuery[]> =>
  invoke("list_saved_queries", { connectionId: connection_id ?? null });

export const saveQuery = (args: {
  name: string;
  connection_id: string;
  soql_text: string;
  object_name?: string;
}): Promise<SavedQuery> =>
  invoke("save_query", {
    name: args.name,
    connectionId: args.connection_id,
    soqlText: args.soql_text,
    objectName: args.object_name ?? null,
  });

export const updateSavedQuery = (args: {
  id: string;
  name?: string;
  soql_text?: string;
  object_name?: string;
}): Promise<SavedQuery> =>
  invoke("update_saved_query", {
    id: args.id,
    name: args.name ?? null,
    soqlText: args.soql_text ?? null,
    objectName: args.object_name ?? null,
  });

export const deleteSavedQuery = (id: string): Promise<void> =>
  invoke("delete_saved_query", { id });

export interface ImportSavedQueriesResult {
  total_in_file: number;
  imported: number;
  renamed: number;
  skipped_duplicates: number;
}

export const exportSavedQueriesToFile = (args: {
  file_path: string;
  query_ids?: string[];
}): Promise<number> =>
  invoke("export_saved_queries_to_file", {
    filePath: args.file_path,
    queryIds: args.query_ids ?? null,
  });

export const importSavedQueriesFromFile = (
  file_path: string
): Promise<ImportSavedQueriesResult> =>
  invoke("import_saved_queries_from_file", { filePath: file_path });

// ── Export types ──────────────────────────────────────────────────────────────

export type ExportFormat = "xlsx" | "csv";

export interface ExportHistoryRecord {
  id: string;
  query_id: string | null;
  connection_id: string | null;
  file_path: string;
  format: string;
  record_count: number | null;
  exported_at: number;
}

export const exportQueryResults = (args: {
  connection_id: string;
  connection_name: string;
  object_name?: string;
  query_id?: string;
  soql: string;
  records: Record<string, unknown>[];
  columns: string[];
  file_path: string;
  format: ExportFormat;
  action_columns?: string[];
}): Promise<ExportHistoryRecord> =>
  invoke("export_query_results", {
    connectionId: args.connection_id,
    connectionName: args.connection_name,
    objectName: args.object_name ?? null,
    queryId: args.query_id ?? null,
    soql: args.soql,
    records: args.records,
    columns: args.columns,
    filePath: args.file_path,
    format: args.format,
    actionColumns: args.action_columns ?? null,
  });

export const listExportHistory = (limit?: number): Promise<ExportHistoryRecord[]> =>
  invoke("list_export_history", { limit: limit ?? null });

// ── Import / Sync types ───────────────────────────────────────────────────────

export interface ExportMetadata {
  connection_name: string;
  object_name: string;
  soql: string;
  exported_at: number;
  record_count: number;
  field_types: Record<string, string>;
}

export interface ParsedFile {
  metadata: ExportMetadata | null;
  columns: string[];
  rows: Record<string, unknown>[];
  row_count: number;
  format: string;
  file_path: string;
}

export type DiffStatus = "new" | "modified" | "unchanged" | "error";

export interface FieldChange {
  field: string;
  old_value: unknown;
  new_value: unknown;
}

export interface DiffRow {
  row_number: number;
  id: string | null;
  status: DiffStatus;
  changes: FieldChange[];
  new_values: Record<string, unknown>;
  error: string | null;
  warnings: string[];
  action_values: Record<string, string>;
}

export interface DiffResult {
  object_name: string;
  connection_id: string;
  total_rows: number;
  new_count: number;
  modified_count: number;
  unchanged_count: number;
  error_count: number;
  warning_count: number;
  action_count: number;
  rows: DiffRow[];
  skipped_fields: string[];
  compared_fields: string[];
}

export interface SyncRecordResult {
  row_number: number;
  operation: string;
  id: string | null;
  success: boolean;
  error_message: string | null;
  error_code: string | null;
}

export interface SyncResult {
  sync_id: string;
  object_name: string;
  total_attempted: number;
  success_count: number;
  failure_count: number;
  inserted_count: number;
  updated_count: number;
  feed_posts_created: number;
  notes_created: number;
  tasks_created: number;
  calls_created: number;
  events_created: number;
  results: SyncRecordResult[];
  started_at: number;
  completed_at: number;
}

export type DateLocale = "iso" | "international" | "us";

export const readImportFile = (args: {
  file_path: string;
  date_locale?: DateLocale;
}): Promise<ParsedFile> =>
  invoke("read_import_file", {
    filePath: args.file_path,
    dateLocale: args.date_locale ?? null,
  });

export const computeSyncDiff = (args: {
  file_path: string;
  connection_id: string;
  object_name?: string;
  date_locale?: DateLocale;
}): Promise<DiffResult> =>
  invoke("compute_sync_diff", {
    filePath: args.file_path,
    connectionId: args.connection_id,
    objectName: args.object_name ?? null,
    dateLocale: args.date_locale ?? null,
  });

export const executeSync = (args: {
  diff: DiffResult;
  source_file_path?: string;
  selected_row_numbers?: number[];
}): Promise<SyncResult> =>
  invoke("execute_sync", {
    diff: args.diff,
    sourceFilePath: args.source_file_path ?? null,
    selectedRowNumbers: args.selected_row_numbers ?? null,
  });

export interface SyncHistoryRecord {
  id: string;
  connection_id: string | null;
  query_id: string | null;
  object_name: string;
  source_file_path: string | null;
  status: string;
  records_modified: number;
  records_inserted: number;
  records_deleted: number;
  started_at: number;
  completed_at: number | null;
  error_summary: string | null;
}

export const listSyncHistory = (limit?: number): Promise<SyncHistoryRecord[]> =>
  invoke("list_sync_history", { limit: limit ?? null });

// ── Admin ─────────────────────────────────────────────────────────────────────

export interface FieldPopulationInfo {
  name: string;
  label: string;
  field_type: string;
  updateable: boolean;
  populated_count: number;
  sample_size: number;
  population_pct: number;
}

export interface FieldAnalysisResult {
  object_name: string;
  sample_size: number;
  total_records: number;
  fields: FieldPopulationInfo[];
}

export const analyseFieldPopulation = (args: {
  connection_id: string;
  object_name: string;
  sample_limit?: number;
}): Promise<FieldAnalysisResult> =>
  invoke("analyse_field_population", {
    connectionId: args.connection_id,
    objectName: args.object_name,
    sampleLimit: args.sample_limit ?? null,
  });

// Duplicate detection

export interface DuplicateGroup {
  value: string;
  count: number;
}

export interface DuplicateAnalysisResult {
  object_name: string;
  field_name: string;
  field_label: string;
  total_duplicates: number;
  total_affected_records: number;
  groups: DuplicateGroup[];
}

export const detectDuplicates = (args: {
  connection_id: string;
  object_name: string;
  field_name: string;
  min_count?: number;
}): Promise<DuplicateAnalysisResult> =>
  invoke("detect_duplicates", {
    connectionId: args.connection_id,
    objectName: args.object_name,
    fieldName: args.field_name,
    minCount: args.min_count ?? null,
  });

// Record ownership distribution

export interface OwnershipBucket {
  owner_id: string;
  owner_name: string;
  record_count: number;
}

export interface OwnershipResult {
  object_name: string;
  total_records: number;
  owners: OwnershipBucket[];
}

export const analyseRecordOwnership = (args: {
  connection_id: string;
  object_name: string;
}): Promise<OwnershipResult> =>
  invoke("analyse_record_ownership", {
    connectionId: args.connection_id,
    objectName: args.object_name,
  });

export const testConnection = (connection_id: string): Promise<ConnectionTestResult> =>
  invoke("test_connection", { connectionId: connection_id });

export const disconnect = (connection_id: string): Promise<void> =>
  invoke("disconnect", { connectionId: connection_id });

// ── Org stats ─────────────────────────────────────────────────────────────────

export interface OrgStats {
  connection_id: string;
  accounts: number | null;
  contacts: number | null;
  opportunities: number | null;
  daily_api_max: number | null;
  daily_api_remaining: number | null;
  errors: string[];
}

export const getOrgStats = (connection_id: string): Promise<OrgStats> =>
  invoke("get_org_stats", { connectionId: connection_id });

// ── License commands ──────────────────────────────────────────────────────────

export const getMachineFingerprint = (): Promise<string> =>
  invoke("get_machine_fingerprint");

export const activateLicense = (args: {
  license_key: string;
  account_id: string;
  product_id: string;
}): Promise<LicenseInfo> =>
  invoke("activate_license", {
    licenseKey: args.license_key,
    accountId: args.account_id,
    productId: args.product_id,
  });

export const checkLicenseStatus = (args: {
  account_id: string;
  product_id: string;
}): Promise<LicenseInfo> =>
  invoke("check_license_status", {
    accountId: args.account_id,
    productId: args.product_id,
  });

export const deactivateLicense = (): Promise<void> =>
  invoke("deactivate_license");

export const hasStoredLicense = (): Promise<boolean> =>
  invoke("has_stored_license");

// ── Sales Accelerator: local AI ───────────────────────────────────────────────

export type GpuKind = "apple_unified" | "nvidia" | "vulkan" | "none";

export interface HardwareInfo {
  total_ram_bytes: number;
  available_ram_bytes: number;
  cpu_brand: string;
  cpu_cores: number;
  free_disk_bytes: number;
  gpu: { kind: GpuKind; vram_bytes: number | null };
}

export type ModelKind = "chat" | "embedding" | "rerank";
export type SizeClass = "small" | "mid" | "large" | "moe" | "xlarge";

export interface ModelEntry {
  id: string;
  display_name: string;
  description: string;
  kind: ModelKind;
  hugging_face_repo: string;
  hugging_face_file: string;
  approximate_size_bytes: number;
  context_length: number;
  licence: string;
  size_class: SizeClass;
  family: string;
  quant_label: string;
  is_default_quant: boolean;
  kv_bytes_per_token: number;
  parameters: string;
  min_ram_bytes: number;
  recommended_ram_bytes: number;
  recommended_vram_bytes: number;
  disk_footprint_bytes: number;
  sha256: string | null;
  download_url: string | null;
}

export interface ModelRecommendation {
  model_id: string;
  tier: "comfortable" | "loadable" | "fallback";
  confidence: "high" | "low";
  rationale: string;
}

/** Payload of `model:download:{id}` progress events. */
export interface DownloadProgress {
  model_id: string;
  downloaded: number;
  total: number | null;
}

export const getAiHardwareInfo = (): Promise<HardwareInfo> =>
  invoke("get_ai_hardware_info");

export const listAiModels = (): Promise<ModelEntry[]> => invoke("list_ai_models");

export const recommendAiModel = (): Promise<ModelRecommendation> =>
  invoke("recommend_ai_model");

export const downloadAiModel = (modelId: string): Promise<void> =>
  invoke("download_ai_model", { modelId });

export const cancelAiDownload = (): Promise<void> => invoke("cancel_ai_download");

export const loadAiModel = (modelId: string): Promise<void> =>
  invoke("load_ai_model", { modelId });

export const cancelAiGeneration = (): Promise<void> =>
  invoke("cancel_ai_generation");

/** The currently-loaded (active) model id, or null if none is loaded this session. */
export const getActiveAiModel = (): Promise<string | null> =>
  invoke("get_active_ai_model");

// ── Sales Accelerator: data pools ─────────────────────────────────────────────

export interface DataPool {
  id: string;
  name: string;
  table_name: string;
  source_file: string | null;
  row_count: number;
  columns: string[];
  created_at: number;
}

export interface PoolAnswer {
  sql: string;
  columns: string[];
  rows: string[][];
  truncated: boolean;
  answer: string;
}

export const listDataPools = (): Promise<DataPool[]> => invoke("list_data_pools");

export const createDataPool = (args: {
  name: string;
  file_path: string;
}): Promise<DataPool> =>
  invoke("create_data_pool", { name: args.name, filePath: args.file_path });

/** Create a pool directly from query results (the primary path). */
export const createDataPoolFromResults = (args: {
  name: string;
  columns: string[];
  rows: string[][];
}): Promise<DataPool> =>
  invoke("create_data_pool_from_results", {
    name: args.name,
    columns: args.columns,
    rows: args.rows,
  });

export const deleteDataPool = (poolId: string): Promise<void> =>
  invoke("delete_data_pool", { poolId });

/** A prior conversation turn (question + the SQL that answered it) for follow-up context. */
export interface PriorTurn {
  question: string;
  sql: string;
}

export const askDataPool = (args: {
  pool_id: string;
  question: string;
  history: PriorTurn[];
}): Promise<PoolAnswer> =>
  invoke("ask_data_pool", {
    poolId: args.pool_id,
    question: args.question,
    history: args.history,
  });

export interface ReportMetric {
  question: string;
  sql: string;
  columns: string[];
  rows: string[][];
}

export interface Report {
  title: string;
  narrative: string;
  metrics: ReportMetric[];
}

/** Payload of `report:progress` events while a report is generated. */
export interface ReportProgress {
  step: string;
}

/** Generate a report over a pool — from a template id or a freeform request. */
export const generateReport = (args: {
  pool_id: string;
  template?: string;
  request?: string;
}): Promise<Report> =>
  invoke("generate_report", {
    poolId: args.pool_id,
    template: args.template ?? null,
    request: args.request ?? null,
  });

// ── Knowledge base (RAG / prospecting) ────────────────────────────────────────

export interface KnowledgeSource {
  id: string;
  name: string;
  kind: string; // 'file' | 'url'
  location: string | null;
  chunk_count: number;
  created_at: number;
}

/** Payload of `knowledge:progress` events while a source is ingested. */
export interface KnowledgeProgress {
  done: number;
  total: number;
}

export interface Citation {
  source_id: string;
  source_name: string;
  snippet: string;
}

export interface ProspectingResult {
  content: string;
  citations: Citation[];
}

export const addKnowledgeFile = (filePath: string): Promise<KnowledgeSource> =>
  invoke("add_knowledge_file", { filePath });

export const addKnowledgeUrl = (url: string): Promise<KnowledgeSource> =>
  invoke("add_knowledge_url", { url });

export const listKnowledgeSources = (): Promise<KnowledgeSource[]> =>
  invoke("list_knowledge_sources");

export const deleteKnowledgeSource = (sourceId: string): Promise<void> =>
  invoke("delete_knowledge_source", { sourceId });

export const writeProspecting = (brief: string): Promise<ProspectingResult> =>
  invoke("write_prospecting", { brief });

// ── Coaching / strategy chat ──────────────────────────────────────────────────

export interface CoachTurn {
  role: "user" | "assistant";
  content: string;
}

export const coach = (args: { message: string; history: CoachTurn[] }): Promise<string> =>
  invoke("coach", { message: args.message, history: args.history });
