import { useState, useMemo, useEffect } from "react";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import {
  FileUp,
  FilePlus2,
  FileCheck2,
  FileX2,
  FileWarning,
  ChevronRight,
  ChevronDown,
  Loader2,
  X,
  AlertTriangle,
  Upload,
  CircleCheck,
  CircleX,
} from "lucide-react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useConnectionStore } from "@/stores/connectionStore";
import { useDateFormatStore } from "@/stores/dateFormatStore";
import SessionExpiredBanner from "@/components/connections/SessionExpiredBanner";
import {
  useReadImportFile,
  useComputeSyncDiff,
  useExecuteSync,
} from "@/hooks/useSync";
import type {
  ParsedFile,
  DiffResult,
  DiffRow,
  DiffStatus,
  SyncResult,
} from "@/lib/tauri-commands";

// ── Helpers ───────────────────────────────────────────────────────────────────

function fileName(path: string): string {
  return path.split(/[/\\]/).pop() ?? path;
}

function formatValue(val: unknown): string {
  if (val === null || val === undefined) return "—";
  if (typeof val === "boolean") return val ? "true" : "false";
  if (typeof val === "object") return JSON.stringify(val);
  return String(val);
}

function statusColor(status: DiffStatus): string {
  switch (status) {
    case "new":
      return "bg-emerald-100 text-emerald-800 border-emerald-200 dark:bg-emerald-950 dark:text-emerald-200 dark:border-emerald-900";
    case "modified":
      return "bg-amber-100 text-amber-800 border-amber-200 dark:bg-amber-950 dark:text-amber-200 dark:border-amber-900";
    case "unchanged":
      return "bg-muted text-muted-foreground border-border";
    case "error":
      return "bg-destructive/10 text-destructive border-destructive/30";
  }
}

function statusLabel(status: DiffStatus): string {
  switch (status) {
    case "new":
      return "NEW";
    case "modified":
      return "MODIFIED";
    case "unchanged":
      return "UNCHANGED";
    case "error":
      return "ERROR";
  }
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function ImportPage() {
  const connections = useConnectionStore((s) => s.connections);
  // Include error-state orgs so the user can still see and reconnect them
  const connectedConnections = connections.filter(
    (c) => c.status === "connected" || c.status === "error"
  );

  const [parsed, setParsed] = useState<ParsedFile | null>(null);
  const [connectionId, setConnectionId] = useState<string>(
    () => connectedConnections[0]?.id ?? ""
  );
  const [objectNameOverride, setObjectNameOverride] = useState<string>("");
  const [diff, setDiff] = useState<DiffResult | null>(null);
  const [expandedRows, setExpandedRows] = useState<Set<number>>(new Set());
  const [statusFilter, setStatusFilter] = useState<DiffStatus | "all">("all");

  const [confirmOpen, setConfirmOpen] = useState(false);
  const [syncResult, setSyncResult] = useState<SyncResult | null>(null);

  const readFile = useReadImportFile();
  const computeDiff = useComputeSyncDiff();
  const execSync = useExecuteSync();
  const dateLocale = useDateFormatStore((s) => s.choice);

  // ── OS-level file drag & drop ─────────────────────────────────────────────
  // Only active while the user is on the "no file chosen yet" step; we don't
  // want a stray drag onto the diff page to accidentally replace their work.
  const [isDraggingFile, setIsDraggingFile] = useState(false);
  const onEmptyStep = !parsed && !syncResult;

  useEffect(() => {
    if (!onEmptyStep) return;

    let unlisten: (() => void) | undefined;

    (async () => {
      unlisten = await getCurrentWebview().onDragDropEvent((event) => {
        if (event.payload.type === "over" || event.payload.type === "enter") {
          setIsDraggingFile(true);
        } else if (event.payload.type === "leave") {
          setIsDraggingFile(false);
        } else if (event.payload.type === "drop") {
          setIsDraggingFile(false);
          const paths = event.payload.paths ?? [];
          const first = paths.find(
            (p) => p.toLowerCase().endsWith(".xlsx") || p.toLowerCase().endsWith(".csv")
          );
          if (!first) return;
          setDiff(null);
          setExpandedRows(new Set());
          setObjectNameOverride("");
          readFile.mutate(
            { file_path: first, date_locale: dateLocale },
            {
              onSuccess: (p) => {
                setParsed(p);
                if (p.metadata?.object_name) {
                  setObjectNameOverride(p.metadata.object_name);
                }
              },
            }
          );
        }
      });
    })();

    return () => {
      unlisten?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onEmptyStep, dateLocale]);

  const effectiveObjectName =
    objectNameOverride || parsed?.metadata?.object_name || "";

  const filteredRows = useMemo(() => {
    if (!diff) return [];
    if (statusFilter === "all") return diff.rows;
    return diff.rows.filter((r) => r.status === statusFilter);
  }, [diff, statusFilter]);

  /** Rows that will actually be written if the user clicks Apply */
  const applicableRows = useMemo(() => {
    if (!diff) return [];
    return diff.rows.filter((r) => r.status === "new" || r.status === "modified");
  }, [diff]);

  const hasApplicableRows = applicableRows.length > 0;
  const applicableWithWarnings = applicableRows.filter(
    (r) => r.warnings.length > 0
  ).length;

  // ── Actions ─────────────────────────────────────────────────────────────────
  async function pickFile() {
    const path = await openDialog({
      multiple: false,
      directory: false,
      filters: [
        { name: "Spreadsheet", extensions: ["xlsx", "csv"] },
      ],
    });
    if (!path || typeof path !== "string") return;

    setDiff(null);
    setExpandedRows(new Set());
    setObjectNameOverride("");

    readFile.mutate(
      { file_path: path, date_locale: dateLocale },
      {
        onSuccess: (p) => {
          setParsed(p);
          // Seed the object name field from metadata if present
          if (p.metadata?.object_name) {
            setObjectNameOverride(p.metadata.object_name);
          }
        },
      }
    );
  }

  function clearFile() {
    setParsed(null);
    setDiff(null);
    setExpandedRows(new Set());
    setObjectNameOverride("");
  }

  function runDiff() {
    if (!parsed || !connectionId || !effectiveObjectName) return;
    computeDiff.mutate(
      {
        file_path: parsed.file_path,
        connection_id: connectionId,
        object_name: effectiveObjectName,
        date_locale: dateLocale,
      },
      {
        onSuccess: (r) => {
          setDiff(r);
          setExpandedRows(new Set());
          // Auto-focus on the most interesting category
          if (r.modified_count > 0) setStatusFilter("modified");
          else if (r.new_count > 0) setStatusFilter("new");
          else if (r.error_count > 0) setStatusFilter("error");
          else setStatusFilter("all");
        },
      }
    );
  }

  function applySync() {
    if (!diff) return;
    execSync.mutate(
      {
        diff,
        source_file_path: parsed?.file_path,
      },
      {
        onSuccess: (result) => {
          setSyncResult(result);
          setConfirmOpen(false);
        },
      }
    );
  }

  function startOver() {
    setSyncResult(null);
    setDiff(null);
    setParsed(null);
    setObjectNameOverride("");
    setExpandedRows(new Set());
  }

  function toggleRow(rowNumber: number) {
    setExpandedRows((prev) => {
      const next = new Set(prev);
      if (next.has(rowNumber)) next.delete(rowNumber);
      else next.add(rowNumber);
      return next;
    });
  }

  const noConnection = connectedConnections.length === 0;
  const activeConnection = connectedConnections.find((c) => c.id === connectionId);
  const isSessionExpired = activeConnection?.status === "error";

  // ── Render ──────────────────────────────────────────────────────────────────
  return (
    <div className="flex h-full flex-col overflow-hidden">
      {/* Header */}
      <div className="border-b px-6 py-4">
        <h1 className="text-lg font-semibold">Update CRM</h1>
        <p className="text-sm text-muted-foreground">
          Preview the changes in an edited file before pushing them back to Salesforce
        </p>
      </div>

      {/* Session expired banner */}
      {isSessionExpired && activeConnection && (
        <SessionExpiredBanner connection={activeConnection} />
      )}

      {/* Step 1: No file yet ────────────────────────────────────────────────── */}
      {!parsed && !syncResult && (
        <div className="flex flex-1 items-center justify-center p-6">
          <div
            className={`flex w-full max-w-lg flex-col items-center gap-4 rounded-xl border-2 border-dashed p-10 text-center transition-colors ${
              isDraggingFile
                ? "border-primary bg-primary/5"
                : "border-border"
            }`}
          >
            <div
              className={`rounded-full p-6 transition-colors ${
                isDraggingFile ? "bg-primary/10 text-primary" : "bg-muted text-muted-foreground"
              }`}
            >
              <FileUp className="h-8 w-8" />
            </div>
            <div className="max-w-md">
              <p className="font-medium">
                {isDraggingFile
                  ? "Drop your file to begin"
                  : "Drop an exported file here, or click to pick"}
              </p>
              <p className="mt-1 text-sm text-muted-foreground">
                An xlsx or csv file created by Upcells. We'll read its metadata,
                compare every row against Salesforce, and show you what would
                change.
              </p>
            </div>
            <Button onClick={pickFile} disabled={readFile.isPending || noConnection}>
              {readFile.isPending ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <FileUp className="h-4 w-4" />
              )}
              Choose file…
            </Button>
            {noConnection && (
              <p className="text-xs text-destructive">
                No Salesforce org connected — add one in Settings
              </p>
            )}
          </div>
        </div>
      )}

      {/* Step 4: Sync result view ──────────────────────────────────────────── */}
      {syncResult && (
        <SyncResultView result={syncResult} onStartOver={startOver} />
      )}

      {/* Step 2: File parsed, ready to diff ─────────────────────────────────── */}
      {parsed && !syncResult && (
        <div className="flex flex-1 flex-col overflow-hidden">
          {/* File summary bar */}
          <div className="flex items-start gap-4 border-b bg-muted/30 px-6 py-3">
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                <FileCheck2 className="h-4 w-4 text-muted-foreground shrink-0" />
                <span className="truncate text-sm font-medium">
                  {fileName(parsed.file_path)}
                </span>
                <span className="text-xs text-muted-foreground">
                  · {parsed.row_count} row{parsed.row_count === 1 ? "" : "s"}
                  · {parsed.columns.length} column{parsed.columns.length === 1 ? "" : "s"}
                  · {parsed.format}
                </span>
              </div>
              {parsed.metadata && (
                <p className="mt-1 text-xs text-muted-foreground">
                  Originally exported from{" "}
                  <span className="font-medium text-foreground">
                    {parsed.metadata.connection_name}
                  </span>{" "}
                  · object{" "}
                  <span className="font-medium text-foreground">
                    {parsed.metadata.object_name}
                  </span>
                </p>
              )}
              {!parsed.metadata && (
                <p className="mt-1 text-xs text-amber-600">
                  <AlertTriangle className="inline h-3 w-3 mr-1" />
                  No metadata found — you'll need to tell us the object type manually
                </p>
              )}
            </div>
            <Button size="sm" variant="ghost" onClick={clearFile}>
              <X className="h-3 w-3" />
              Clear
            </Button>
          </div>

          {/* Controls */}
          <div className="flex items-end gap-3 border-b px-6 py-3">
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground">
                Connection
              </label>
              <select
                className="h-8 rounded-md border bg-background px-2 text-sm"
                value={connectionId}
                onChange={(e) => setConnectionId(e.target.value)}
              >
                {connectedConnections.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground">
                Object
              </label>
              <input
                type="text"
                className="h-8 w-48 rounded-md border bg-background px-2 text-sm"
                value={objectNameOverride}
                onChange={(e) => setObjectNameOverride(e.target.value)}
                placeholder="e.g. Account"
              />
            </div>
            <Button
              onClick={runDiff}
              disabled={
                computeDiff.isPending ||
                !connectionId ||
                !effectiveObjectName ||
                noConnection ||
                isSessionExpired
              }
            >
              {computeDiff.isPending ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : null}
              Compare with Salesforce
            </Button>
          </div>

          {/* Step 3: Diff results ─────────────────────────────────────────── */}
          {!diff && !computeDiff.isPending && (
            <div className="flex flex-1 items-center justify-center p-6">
              <p className="text-sm text-muted-foreground">
                Click "Compare with Salesforce" to preview the changes
              </p>
            </div>
          )}

          {computeDiff.isPending && (
            <div className="flex flex-1 items-center justify-center gap-2 p-6">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
              <span className="text-sm text-muted-foreground">
                Fetching current state from Salesforce…
              </span>
            </div>
          )}

          {diff && (
            <>
              {/* Summary chips */}
              <div className="flex flex-wrap items-center gap-2 border-b px-6 py-3">
                <SummaryChip
                  icon={<FilePlus2 className="h-3 w-3" />}
                  label="New"
                  count={diff.new_count}
                  color="emerald"
                  active={statusFilter === "new"}
                  onClick={() => setStatusFilter(statusFilter === "new" ? "all" : "new")}
                />
                <SummaryChip
                  icon={<FileCheck2 className="h-3 w-3" />}
                  label="Modified"
                  count={diff.modified_count}
                  color="amber"
                  active={statusFilter === "modified"}
                  onClick={() =>
                    setStatusFilter(statusFilter === "modified" ? "all" : "modified")
                  }
                />
                <SummaryChip
                  icon={<FileCheck2 className="h-3 w-3" />}
                  label="Unchanged"
                  count={diff.unchanged_count}
                  color="muted"
                  active={statusFilter === "unchanged"}
                  onClick={() =>
                    setStatusFilter(statusFilter === "unchanged" ? "all" : "unchanged")
                  }
                />
                {diff.error_count > 0 && (
                  <SummaryChip
                    icon={<FileX2 className="h-3 w-3" />}
                    label="Errors"
                    count={diff.error_count}
                    color="destructive"
                    active={statusFilter === "error"}
                    onClick={() =>
                      setStatusFilter(statusFilter === "error" ? "all" : "error")
                    }
                  />
                )}
                <div className="ml-auto flex items-center gap-3">
                  <span className="text-xs text-muted-foreground">
                    {filteredRows.length} of {diff.total_rows} rows shown
                  </span>
                </div>
              </div>

              {/* Skipped fields warning */}
              {diff.skipped_fields.length > 0 && (
                <div className="border-b bg-amber-50 px-6 py-2 dark:bg-amber-950/30">
                  <p className="text-xs text-amber-800 dark:text-amber-200">
                    <FileWarning className="inline h-3 w-3 mr-1" />
                    {diff.skipped_fields.length} column
                    {diff.skipped_fields.length === 1 ? "" : "s"} will be ignored
                    (not updateable):{" "}
                    <span className="font-mono">
                      {diff.skipped_fields.join(", ")}
                    </span>
                  </p>
                </div>
              )}

              {/* Picklist / validation warnings banner */}
              {diff.warning_count > 0 && (
                <div className="border-b bg-amber-50 px-6 py-2 dark:bg-amber-950/30">
                  <p className="text-xs text-amber-800 dark:text-amber-200">
                    <AlertTriangle className="inline h-3 w-3 mr-1" />
                    {diff.warning_count} row{diff.warning_count === 1 ? "" : "s"}{" "}
                    {diff.warning_count === 1 ? "has" : "have"} validation
                    warnings (picklist mismatch, required field, etc.). You can
                    still apply, but Salesforce will reject those records at
                    write time.
                  </p>
                </div>
              )}

              {/* Apply bar */}
              <div className="flex items-center justify-between border-b bg-muted/30 px-6 py-3">
                <div className="text-sm">
                  {hasApplicableRows || diff.action_count > 0 ? (
                    <>
                      {hasApplicableRows && (
                        <>
                          <strong>{applicableRows.length}</strong>{" "}
                          {applicableRows.length === 1 ? "row" : "rows"} will be
                          written
                          {diff.new_count > 0 && ` (${diff.new_count} new)`}
                          {diff.modified_count > 0 && diff.new_count > 0 && ", "}
                          {diff.modified_count > 0 &&
                            `${diff.modified_count} modified`}
                        </>
                      )}
                      {diff.action_count > 0 && (
                        <span className="text-muted-foreground">
                          {hasApplicableRows ? " · " : ""}
                          {diff.action_count} feed post
                          {diff.action_count === 1 ? "" : "s"} / note
                          {diff.action_count === 1 ? "" : "s"} will be created
                        </span>
                      )}
                    </>
                  ) : (
                    <span className="text-muted-foreground">
                      Nothing to apply — all rows are unchanged
                    </span>
                  )}
                </div>
                <Button
                  onClick={() => setConfirmOpen(true)}
                  disabled={
                    (!hasApplicableRows && diff.action_count === 0) ||
                    execSync.isPending
                  }
                >
                  {execSync.isPending ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Upload className="h-4 w-4" />
                  )}
                  Apply changes
                </Button>
              </div>

              {/* Rows */}
              <div className="flex-1 overflow-y-auto">
                {filteredRows.length === 0 ? (
                  <div className="flex h-full items-center justify-center">
                    <p className="text-sm text-muted-foreground">
                      No rows match this filter
                    </p>
                  </div>
                ) : (
                  <ul className="divide-y">
                    {filteredRows.map((row) => (
                      <DiffRowItem
                        key={row.row_number}
                        row={row}
                        expanded={expandedRows.has(row.row_number)}
                        onToggle={() => toggleRow(row.row_number)}
                      />
                    ))}
                  </ul>
                )}
              </div>
            </>
          )}
        </div>
      )}

      {/* ── Confirm dialog ────────────────────────────────────────────────── */}
      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Apply changes to Salesforce?</DialogTitle>
          </DialogHeader>
          {diff && (
            <div className="space-y-3 py-2 text-sm">
              <p>
                You're about to write to{" "}
                <strong>{diff.object_name}</strong> in{" "}
                <strong>
                  {
                    connectedConnections.find((c) => c.id === connectionId)
                      ?.name
                  }
                </strong>
                .
              </p>
              <ul className="space-y-1 rounded-md border bg-muted/30 p-3 text-xs">
                {diff.new_count > 0 && (
                  <li>
                    <span className="font-medium text-emerald-700 dark:text-emerald-400">
                      {diff.new_count}
                    </span>{" "}
                    new record{diff.new_count === 1 ? "" : "s"} will be inserted
                  </li>
                )}
                {diff.modified_count > 0 && (
                  <li>
                    <span className="font-medium text-amber-700 dark:text-amber-400">
                      {diff.modified_count}
                    </span>{" "}
                    existing record{diff.modified_count === 1 ? "" : "s"} will
                    be updated
                  </li>
                )}
                <li className="text-muted-foreground">
                  {diff.unchanged_count} unchanged row
                  {diff.unchanged_count === 1 ? "" : "s"} will be skipped
                </li>
              </ul>
              {applicableWithWarnings > 0 && (
                <p className="rounded-md border border-amber-300 bg-amber-50 p-3 text-xs text-amber-900 dark:bg-amber-950/40 dark:text-amber-200 dark:border-amber-800">
                  <AlertTriangle className="inline h-3 w-3 mr-1" />
                  {applicableWithWarnings} row
                  {applicableWithWarnings === 1 ? "" : "s"} have validation
                  warnings and will likely be rejected by Salesforce. Failed
                  records will be listed in the result.
                </p>
              )}
              <p className="text-xs text-muted-foreground">
                Changes are sent in batches via the Salesforce Composite API
                with <code>allOrNone=false</code> — partial success is
                possible.
              </p>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmOpen(false)}>
              Cancel
            </Button>
            <Button onClick={applySync} disabled={execSync.isPending}>
              {execSync.isPending ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Upload className="h-4 w-4" />
              )}
              Apply {applicableRows.length} change
              {applicableRows.length === 1 ? "" : "s"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ── Sync result view ───────────────────────────────────────────────────────────

function SyncResultView({
  result,
  onStartOver,
}: {
  result: SyncResult;
  onStartOver: () => void;
}) {
  const allSucceeded = result.failure_count === 0;
  const allFailed = result.success_count === 0;
  const failures = result.results.filter((r) => !r.success);

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      {/* Status hero */}
      <div
        className={`border-b px-6 py-6 ${
          allSucceeded
            ? "bg-emerald-50 dark:bg-emerald-950/30"
            : allFailed
            ? "bg-destructive/10"
            : "bg-amber-50 dark:bg-amber-950/30"
        }`}
      >
        <div className="flex items-start gap-3">
          {allSucceeded ? (
            <CircleCheck className="h-8 w-8 text-emerald-600 dark:text-emerald-400" />
          ) : allFailed ? (
            <CircleX className="h-8 w-8 text-destructive" />
          ) : (
            <AlertTriangle className="h-8 w-8 text-amber-600 dark:text-amber-400" />
          )}
          <div className="flex-1">
            <h2 className="text-lg font-semibold">
              {allSucceeded
                ? "All changes applied"
                : allFailed
                ? "Sync failed"
                : "Partial success"}
            </h2>
            <p className="mt-1 text-sm text-muted-foreground">
              {result.success_count} of {result.total_attempted} record
              {result.total_attempted === 1 ? "" : "s"} written to{" "}
              <strong>{result.object_name}</strong>
              {result.inserted_count > 0 &&
                ` · ${result.inserted_count} inserted`}
              {result.updated_count > 0 &&
                ` · ${result.updated_count} updated`}
              {result.feed_posts_created > 0 &&
                ` · ${result.feed_posts_created} feed post${
                  result.feed_posts_created === 1 ? "" : "s"
                }`}
              {result.notes_created > 0 &&
                ` · ${result.notes_created} note${
                  result.notes_created === 1 ? "" : "s"
                }`}
              {result.tasks_created > 0 &&
                ` · ${result.tasks_created} task${
                  result.tasks_created === 1 ? "" : "s"
                }`}
              {result.calls_created > 0 &&
                ` · ${result.calls_created} call${
                  result.calls_created === 1 ? "" : "s"
                } logged`}
              {result.events_created > 0 &&
                ` · ${result.events_created} event${
                  result.events_created === 1 ? "" : "s"
                }`}
              {result.failure_count > 0 &&
                ` · ${result.failure_count} failed`}
            </p>
          </div>
          <Button variant="outline" onClick={onStartOver}>
            Start over
          </Button>
        </div>
      </div>

      {/* Failure list */}
      {failures.length > 0 && (
        <div className="flex-1 overflow-y-auto">
          <div className="border-b bg-muted/30 px-6 py-2">
            <p className="text-xs font-semibold text-muted-foreground">
              Failed records
            </p>
          </div>
          <ul className="divide-y">
            {failures.map((f) => (
              <li key={`${f.row_number}-${f.operation}`} className="px-6 py-3">
                <div className="flex items-start gap-3">
                  <span className="inline-flex shrink-0 items-center gap-1 rounded-full border border-destructive/30 bg-destructive/10 px-2 py-0.5 text-xs font-semibold text-destructive">
                    {f.operation.toUpperCase()}
                  </span>
                  <span className="shrink-0 text-xs text-muted-foreground">
                    Row {f.row_number}
                  </span>
                  {f.id && (
                    <span className="shrink-0 font-mono text-xs text-muted-foreground">
                      {f.id}
                    </span>
                  )}
                  <div className="flex-1 min-w-0">
                    <p className="text-xs text-destructive font-mono break-words">
                      {f.error_code && `[${f.error_code}] `}
                      {f.error_message ?? "Unknown error"}
                    </p>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}

      {failures.length === 0 && (
        <div className="flex flex-1 items-center justify-center">
          <p className="text-sm text-muted-foreground">
            Every record was written successfully
          </p>
        </div>
      )}
    </div>
  );
}

// ── Summary chip ───────────────────────────────────────────────────────────────

function SummaryChip({
  icon,
  label,
  count,
  color,
  active,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  count: number;
  color: "emerald" | "amber" | "muted" | "destructive";
  active: boolean;
  onClick: () => void;
}) {
  const colorClasses = {
    emerald: active
      ? "bg-emerald-600 text-white border-emerald-600"
      : "bg-emerald-50 text-emerald-800 border-emerald-200 hover:bg-emerald-100 dark:bg-emerald-950 dark:text-emerald-200 dark:border-emerald-900",
    amber: active
      ? "bg-amber-600 text-white border-amber-600"
      : "bg-amber-50 text-amber-800 border-amber-200 hover:bg-amber-100 dark:bg-amber-950 dark:text-amber-200 dark:border-amber-900",
    muted: active
      ? "bg-muted-foreground text-background border-muted-foreground"
      : "bg-muted text-muted-foreground border-border hover:bg-muted/70",
    destructive: active
      ? "bg-destructive text-destructive-foreground border-destructive"
      : "bg-destructive/10 text-destructive border-destructive/30 hover:bg-destructive/20",
  };

  return (
    <button
      onClick={onClick}
      className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium transition ${colorClasses[color]}`}
    >
      {icon}
      {label}: {count}
    </button>
  );
}

// ── Row item ───────────────────────────────────────────────────────────────────

function DiffRowItem({
  row,
  expanded,
  onToggle,
}: {
  row: DiffRow;
  expanded: boolean;
  onToggle: () => void;
}) {
  const expandable = row.status === "modified" || row.status === "new";
  const hasWarnings = row.warnings.length > 0;
  const hasActions = Object.keys(row.action_values).length > 0;

  return (
    <li>
      <button
        onClick={expandable ? onToggle : undefined}
        className={`flex w-full items-center gap-3 px-6 py-2.5 text-left ${
          expandable ? "hover:bg-muted/40 cursor-pointer" : "cursor-default"
        }`}
      >
        <div className="w-5 shrink-0">
          {expandable &&
            (expanded ? (
              <ChevronDown className="h-4 w-4 text-muted-foreground" />
            ) : (
              <ChevronRight className="h-4 w-4 text-muted-foreground" />
            ))}
        </div>
        <span
          className={`shrink-0 rounded-full border px-2 py-0.5 text-xs font-semibold ${statusColor(
            row.status
          )}`}
        >
          {statusLabel(row.status)}
        </span>
        <span className="shrink-0 text-xs text-muted-foreground">
          Row {row.row_number}
        </span>
        <span className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground">
          {row.id ?? "(no Id — will be inserted)"}
        </span>
        {hasWarnings && (
          <span className="shrink-0 inline-flex items-center gap-1 rounded-full border border-amber-300 bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-800 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200">
            <AlertTriangle className="h-2.5 w-2.5" />
            {row.warnings.length} warning{row.warnings.length === 1 ? "" : "s"}
          </span>
        )}
        {row.status === "modified" && (
          <span className="shrink-0 text-xs text-muted-foreground">
            {row.changes.length} field{row.changes.length === 1 ? "" : "s"} changed
          </span>
        )}
        {hasActions && (
          <span className="shrink-0 inline-flex items-center gap-1 rounded-full border border-blue-300 bg-blue-50 px-2 py-0.5 text-[10px] font-medium text-blue-800 dark:border-blue-800 dark:bg-blue-950 dark:text-blue-200">
            {Object.keys(row.action_values).length} action{Object.keys(row.action_values).length === 1 ? "" : "s"}
          </span>
        )}
        {row.status === "error" && row.error && (
          <span className="shrink-0 text-xs text-destructive truncate max-w-xs">
            {row.error}
          </span>
        )}
      </button>

      {/* Warnings — always visible when present */}
      {hasWarnings && (
        <div className="border-l-2 border-amber-400 bg-amber-50/50 px-6 py-2 dark:bg-amber-950/20 dark:border-amber-800">
          {row.warnings.map((w, i) => (
            <p
              key={i}
              className="text-xs text-amber-800 dark:text-amber-200 font-mono"
            >
              <AlertTriangle className="inline h-2.5 w-2.5 mr-1" />
              {w}
            </p>
          ))}
        </div>
      )}

      {/* Expanded detail */}
      {expanded && row.status === "modified" && (
        <div className="bg-muted/20 px-6 py-3">
          <table className="w-full text-xs">
            <thead>
              <tr className="text-muted-foreground">
                <th className="w-1/4 px-2 py-1 text-left font-medium">Field</th>
                <th className="w-1/3 px-2 py-1 text-left font-medium">
                  Current (Salesforce)
                </th>
                <th className="w-1/3 px-2 py-1 text-left font-medium">
                  New (File)
                </th>
              </tr>
            </thead>
            <tbody>
              {row.changes.map((c) => (
                <tr key={c.field} className="border-t">
                  <td className="px-2 py-1 font-mono font-medium">{c.field}</td>
                  <td className="px-2 py-1 font-mono text-muted-foreground">
                    {formatValue(c.old_value)}
                  </td>
                  <td className="px-2 py-1 font-mono text-emerald-700 dark:text-emerald-400">
                    {formatValue(c.new_value)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {expanded && row.status === "new" && (
        <div className="bg-muted/20 px-6 py-3">
          <table className="w-full text-xs">
            <thead>
              <tr className="text-muted-foreground">
                <th className="w-1/3 px-2 py-1 text-left font-medium">Field</th>
                <th className="w-2/3 px-2 py-1 text-left font-medium">Value</th>
              </tr>
            </thead>
            <tbody>
              {Object.entries(row.new_values).map(([field, value]) => (
                <tr key={field} className="border-t">
                  <td className="px-2 py-1 font-mono font-medium">{field}</td>
                  <td className="px-2 py-1 font-mono text-emerald-700 dark:text-emerald-400">
                    {formatValue(value)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </li>
  );
}
