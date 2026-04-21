import { useMemo, useState } from "react";
import {
  History as HistoryIcon,
  Download,
  Upload,
  CircleCheck,
  CircleX,
  AlertTriangle,
  Loader2,
} from "lucide-react";
import { useExportHistory } from "@/hooks/useExport";
import { useSyncHistory } from "@/hooks/useSync";
import { useConnectionStore } from "@/stores/connectionStore";
import type {
  ExportHistoryRecord,
  SyncHistoryRecord,
} from "@/lib/tauri-commands";
import { cn } from "@/lib/utils";

// ── Types ─────────────────────────────────────────────────────────────────────

type Filter = "all" | "exports" | "updates";

type TimelineItem =
  | { kind: "export"; at: number; record: ExportHistoryRecord }
  | { kind: "update"; at: number; record: SyncHistoryRecord };

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatRelative(ts: number): string {
  const diff = Math.floor(Date.now() / 1000) - ts;
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  if (diff < 86400 * 7) return `${Math.floor(diff / 86400)}d ago`;
  if (diff < 86400 * 30) return `${Math.floor(diff / (86400 * 7))}w ago`;
  return `${Math.floor(diff / (86400 * 30))}mo ago`;
}

function formatAbsolute(ts: number): string {
  return new Date(ts * 1000).toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function fileName(path: string): string {
  return path.split(/[/\\]/).pop() ?? path;
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function HistoryPage() {
  const { data: exports = [], isLoading: exportsLoading } = useExportHistory(200);
  const { data: updates = [], isLoading: updatesLoading } = useSyncHistory(200);
  const connections = useConnectionStore((s) => s.connections);

  const [filter, setFilter] = useState<Filter>("all");
  const [connectionFilter, setConnectionFilter] = useState<string>("all");

  // Build a unified, sorted timeline
  const items = useMemo<TimelineItem[]>(() => {
    const merged: TimelineItem[] = [
      ...exports.map(
        (r): TimelineItem => ({ kind: "export", at: r.exported_at, record: r })
      ),
      ...updates.map(
        (r): TimelineItem => ({ kind: "update", at: r.started_at, record: r })
      ),
    ];
    return merged.sort((a, b) => b.at - a.at);
  }, [exports, updates]);

  const filtered = useMemo(() => {
    return items.filter((item) => {
      if (filter === "exports" && item.kind !== "export") return false;
      if (filter === "updates" && item.kind !== "update") return false;
      if (connectionFilter !== "all") {
        const cid =
          item.kind === "export"
            ? item.record.connection_id
            : item.record.connection_id;
        if (cid !== connectionFilter) return false;
      }
      return true;
    });
  }, [items, filter, connectionFilter]);

  const isLoading = exportsLoading || updatesLoading;

  // Counts for the filter chips
  const exportCount = items.filter((i) => i.kind === "export").length;
  const updateCount = items.filter((i) => i.kind === "update").length;

  // Map connection id -> display name
  const connectionName = (id: string | null) => {
    if (!id) return null;
    return connections.find((c) => c.id === id)?.name ?? null;
  };

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {/* Header */}
      <div className="border-b px-6 py-4">
        <h1 className="text-lg font-semibold">History</h1>
        <p className="text-sm text-muted-foreground">
          Every export and update operation you've run
        </p>
      </div>

      {/* Filter bar */}
      <div className="flex items-center gap-3 border-b px-6 py-3">
        <div className="flex gap-1">
          <FilterChip
            active={filter === "all"}
            onClick={() => setFilter("all")}
            label="All"
            count={items.length}
          />
          <FilterChip
            active={filter === "exports"}
            onClick={() => setFilter("exports")}
            label="Exports"
            count={exportCount}
          />
          <FilterChip
            active={filter === "updates"}
            onClick={() => setFilter("updates")}
            label="Updates"
            count={updateCount}
          />
        </div>

        {connections.length > 1 && (
          <div className="ml-auto flex items-center gap-2">
            <span className="text-xs text-muted-foreground">Org</span>
            <select
              className="h-8 rounded-md border bg-background px-2 text-xs"
              value={connectionFilter}
              onChange={(e) => setConnectionFilter(e.target.value)}
            >
              <option value="all">All orgs</option>
              {connections.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </div>
        )}
      </div>

      {/* Timeline */}
      <div className="flex-1 overflow-y-auto">
        {isLoading && filtered.length === 0 ? (
          <div className="flex h-full items-center justify-center">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        ) : filtered.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
            <div className="rounded-full bg-muted p-6">
              <HistoryIcon className="h-8 w-8 text-muted-foreground" />
            </div>
            <div className="max-w-md">
              <p className="font-medium">
                {items.length === 0
                  ? "Nothing here yet"
                  : "No entries match your filters"}
              </p>
              <p className="mt-1 text-sm text-muted-foreground">
                {items.length === 0
                  ? "Every export you save and every update you apply will show up here."
                  : "Try switching filters above."}
              </p>
            </div>
          </div>
        ) : (
          <ul className="divide-y">
            {filtered.map((item) =>
              item.kind === "export" ? (
                <ExportRow
                  key={`e-${item.record.id}`}
                  record={item.record}
                  orgName={connectionName(item.record.connection_id)}
                />
              ) : (
                <UpdateRow
                  key={`u-${item.record.id}`}
                  record={item.record}
                  orgName={connectionName(item.record.connection_id)}
                />
              )
            )}
          </ul>
        )}
      </div>
    </div>
  );
}

// ── Filter chip ───────────────────────────────────────────────────────────────

function FilterChip({
  active,
  onClick,
  label,
  count,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  count: number;
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium transition-colors",
        active
          ? "border-primary bg-primary text-primary-foreground"
          : "border-border text-muted-foreground hover:bg-accent hover:text-accent-foreground"
      )}
    >
      {label}
      <span
        className={cn(
          "tabular-nums",
          active ? "text-primary-foreground/80" : "text-muted-foreground/60"
        )}
      >
        {count}
      </span>
    </button>
  );
}

// ── Export row ────────────────────────────────────────────────────────────────

function ExportRow({
  record,
  orgName,
}: {
  record: ExportHistoryRecord;
  orgName: string | null;
}) {
  return (
    <li className="flex items-start gap-3 px-6 py-3 hover:bg-muted/30">
      <div className="rounded-md bg-muted p-2 text-muted-foreground">
        <Download className="h-4 w-4" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <p className="truncate text-sm font-medium">
            {fileName(record.file_path)}
          </p>
          <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] font-semibold uppercase text-muted-foreground">
            {record.format}
          </span>
        </div>
        <p className="mt-0.5 text-xs text-muted-foreground">
          Export
          {record.record_count != null && (
            <> · {record.record_count.toLocaleString()} records</>
          )}
          {orgName && <> · from {orgName}</>}
        </p>
      </div>
      <div className="shrink-0 text-right">
        <p
          className="text-xs text-muted-foreground"
          title={formatAbsolute(record.exported_at)}
        >
          {formatRelative(record.exported_at)}
        </p>
      </div>
    </li>
  );
}

// ── Update row ────────────────────────────────────────────────────────────────

function UpdateRow({
  record,
  orgName,
}: {
  record: SyncHistoryRecord;
  orgName: string | null;
}) {
  const { icon, color, label } = statusStyle(record.status);
  const totalWritten =
    record.records_inserted + record.records_modified;

  return (
    <li className="flex items-start gap-3 px-6 py-3 hover:bg-muted/30">
      <div className="rounded-md bg-muted p-2 text-muted-foreground">
        <Upload className="h-4 w-4" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <p className="truncate text-sm font-medium">
            {record.object_name} update
          </p>
          <span
            className={cn(
              "inline-flex shrink-0 items-center gap-0.5 rounded-full border px-1.5 py-0.5 text-[10px] font-semibold uppercase",
              color
            )}
          >
            {icon}
            {label}
          </span>
        </div>
        <p className="mt-0.5 text-xs text-muted-foreground">
          Update
          {totalWritten > 0 && (
            <>
              {" · "}
              {record.records_inserted > 0 && (
                <>{record.records_inserted} inserted</>
              )}
              {record.records_inserted > 0 &&
                record.records_modified > 0 &&
                ", "}
              {record.records_modified > 0 && (
                <>{record.records_modified} modified</>
              )}
            </>
          )}
          {orgName && <> · to {orgName}</>}
          {record.source_file_path && (
            <> · from {fileName(record.source_file_path)}</>
          )}
        </p>
        {record.error_summary && (
          <p className="mt-1 text-xs text-destructive">{record.error_summary}</p>
        )}
      </div>
      <div className="shrink-0 text-right">
        <p
          className="text-xs text-muted-foreground"
          title={formatAbsolute(record.started_at)}
        >
          {formatRelative(record.started_at)}
        </p>
      </div>
    </li>
  );
}

function statusStyle(status: string): {
  icon: React.ReactNode;
  color: string;
  label: string;
} {
  switch (status) {
    case "success":
      return {
        icon: <CircleCheck className="h-2.5 w-2.5" />,
        color:
          "border-emerald-300 bg-emerald-50 text-emerald-700 dark:border-emerald-900 dark:bg-emerald-950 dark:text-emerald-300",
        label: "success",
      };
    case "partial":
      return {
        icon: <AlertTriangle className="h-2.5 w-2.5" />,
        color:
          "border-amber-300 bg-amber-50 text-amber-700 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-300",
        label: "partial",
      };
    case "failed":
      return {
        icon: <CircleX className="h-2.5 w-2.5" />,
        color: "border-destructive/30 bg-destructive/10 text-destructive",
        label: "failed",
      };
    case "running":
      return {
        icon: <Loader2 className="h-2.5 w-2.5 animate-spin" />,
        color:
          "border-border bg-muted text-muted-foreground",
        label: "running",
      };
    default:
      return {
        icon: null,
        color: "border-border bg-muted text-muted-foreground",
        label: status,
      };
  }
}
