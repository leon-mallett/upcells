import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  listSobjects,
  describeObject,
  executeQuery,
  listSavedQueries,
  saveQuery,
  updateSavedQuery,
  deleteSavedQuery,
  exportSavedQueriesToFile,
  importSavedQueriesFromFile,
} from "@/lib/tauri-commands";

// ── Cache keys ────────────────────────────────────────────────────────────────

export const sobjectsKey = (connectionId: string) =>
  ["sobjects", connectionId] as const;

export const describeKey = (connectionId: string, objectName: string) =>
  ["describe", connectionId, objectName] as const;

export const savedQueriesKey = (connectionId?: string) =>
  connectionId ? (["saved_queries", connectionId] as const) : (["saved_queries"] as const);

// ── Error helpers ──────────────────────────────────────────────────────────────

export function errMsg(err: unknown): string {
  if (typeof err === "string") return err;
  if (err && typeof err === "object") {
    const e = err as Record<string, unknown>;
    if (typeof e.message === "string") return e.message;
    if (typeof e.code === "string") return `${e.code}: ${e.message ?? "unknown"}`;
  }
  return String(err);
}

/** Heuristic — is this error the result of Salesforce rejecting our refresh
 *  token (expired / revoked)? We check for the specific strings SF and our
 *  own refresh flow produce. */
export function isAuthFailure(err: unknown): boolean {
  const m = errMsg(err).toLowerCase();
  return (
    m.includes("token refresh failed") ||
    m.includes("invalid_grant") ||
    m.includes("expired access/refresh token") ||
    m.includes("no refresh token stored") ||
    m.includes("please re-authenticate")
  );
}

/** Shows an error toast with a Copy button so the user can paste the full message. */
function toastError(message: string) {
  toast.error(message, {
    duration: 20000,
    action: {
      label: "Copy",
      onClick: () => navigator.clipboard.writeText(message),
    },
  });
}

// ── Data-fetching hooks ────────────────────────────────────────────────────────

/** All queryable SObject types for a connection. Cached for 10 minutes. */
export function useSobjects(connectionId: string | null) {
  return useQuery({
    queryKey: sobjectsKey(connectionId ?? ""),
    queryFn: () => listSobjects(connectionId!),
    enabled: !!connectionId,
    staleTime: 10 * 60 * 1000,
  });
}

/** Field metadata for a single SObject. Cached for 10 minutes. */
export function useDescribeObject(
  connectionId: string | null,
  objectName: string | null
) {
  return useQuery({
    queryKey: describeKey(connectionId ?? "", objectName ?? ""),
    queryFn: () => describeObject(connectionId!, objectName!),
    enabled: !!connectionId && !!objectName,
    staleTime: 10 * 60 * 1000,
  });
}

/** Saved queries, optionally filtered to a connection. */
export function useSavedQueries(connectionId?: string) {
  return useQuery({
    queryKey: savedQueriesKey(connectionId),
    queryFn: () => listSavedQueries(connectionId),
  });
}

// ── Mutation hooks ────────────────────────────────────────────────────────────

export function useExecuteQuery() {
  const qc = useQueryClient();

  return useMutation({
    mutationFn: executeQuery,
    onSuccess: () => {
      // Onboarding milestone — used by the dashboard checklist so it can
      // tick off "Run your first query" without a dedicated tracking table.
      localStorage.setItem("upcells.onboarding.ranQuery", "true");
    },
    onError: (err: unknown) => {
      if (isAuthFailure(err)) {
        // The Rust refresh flow already flipped the connection to 'error'
        // in the DB — we just need to refresh the query cache so the
        // session-expired banner renders. The toast is short and points at
        // the banner rather than dumping the raw error.
        qc.invalidateQueries({ queryKey: ["connections"] });
        toast.error(
          "Your Salesforce session has expired. Reconnect using the banner above."
        );
      } else {
        toastError(`Query failed: ${errMsg(err)}`);
      }
    },
  });
}

export function useSaveQuery(connectionId?: string) {
  const qc = useQueryClient();

  return useMutation({
    mutationFn: saveQuery,
    onSuccess: (q) => {
      qc.invalidateQueries({ queryKey: savedQueriesKey(connectionId) });
      toast.success(`Query "${q.name}" saved`);
    },
    onError: (err: unknown) => {
      toastError(`Failed to save query: ${errMsg(err)}`);
    },
  });
}

export function useUpdateSavedQuery(connectionId?: string) {
  const qc = useQueryClient();

  return useMutation({
    mutationFn: updateSavedQuery,
    onSuccess: (q) => {
      qc.invalidateQueries({ queryKey: savedQueriesKey(connectionId) });
      toast.success(`Query "${q.name}" updated`);
    },
    onError: (err: unknown) => {
      toastError(`Failed to update query: ${errMsg(err)}`);
    },
  });
}

export function useDeleteSavedQuery(connectionId?: string) {
  const qc = useQueryClient();

  return useMutation({
    mutationFn: deleteSavedQuery,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: savedQueriesKey(connectionId) });
      toast.success("Query deleted");
    },
    onError: (err: unknown) => {
      toastError(`Failed to delete query: ${errMsg(err)}`);
    },
  });
}

export function useExportSavedQueriesToFile() {
  return useMutation({
    mutationFn: exportSavedQueriesToFile,
    onError: (err: unknown) => {
      toastError(`Export failed: ${errMsg(err)}`);
    },
  });
}

export function useImportSavedQueriesFromFile() {
  const qc = useQueryClient();

  return useMutation({
    mutationFn: importSavedQueriesFromFile,
    onSuccess: () => {
      // Invalidate ALL saved_queries cache entries — there may be variants
      // per connection id that also need refreshing.
      qc.invalidateQueries({ queryKey: ["saved_queries"] });
    },
    onError: (err: unknown) => {
      toastError(`Import failed: ${errMsg(err)}`);
    },
  });
}
