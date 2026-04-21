import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  listConnections,
  createConnection,
  updateConnection,
  deleteConnection,
  startSalesforceOAuth,
  testConnection,
  disconnect,
  getOrgStats,
} from "@/lib/tauri-commands";
import { useConnectionStore } from "@/stores/connectionStore";

export const CONNECTIONS_KEY = ["connections"] as const;

// Tauri errors can come back as either a plain string (IPC-level error) or as
// our serialised AppError object { code, message }. This helper extracts a
// readable message from either shape.
function errMsg(err: unknown): string {
  if (typeof err === "string") return err;
  if (err && typeof err === "object") {
    const e = err as Record<string, unknown>;
    if (typeof e.message === "string") return e.message;
    if (typeof e.code === "string") return `${e.code}: ${e.message ?? "unknown"}`;
  }
  return String(err);
}

export function useConnections() {
  const setConnections = useConnectionStore((s) => s.setConnections);

  return useQuery({
    queryKey: CONNECTIONS_KEY,
    queryFn: async () => {
      const connections = await listConnections();
      setConnections(connections);
      return connections;
    },
  });
}

export function useCreateConnection() {
  const qc = useQueryClient();
  const upsert = useConnectionStore((s) => s.upsertConnection);

  return useMutation({
    mutationFn: createConnection,
    onSuccess: (connection) => {
      upsert(connection);
      qc.invalidateQueries({ queryKey: CONNECTIONS_KEY });
      toast.success(`Connection "${connection.name}" created`);
    },
    onError: (err: unknown) => {
      toast.error(`Failed to create connection: ${errMsg(err)}`);
    },
  });
}

export function useUpdateConnection() {
  const qc = useQueryClient();
  const upsert = useConnectionStore((s) => s.upsertConnection);

  return useMutation({
    mutationFn: updateConnection,
    onSuccess: (connection) => {
      upsert(connection);
      qc.invalidateQueries({ queryKey: CONNECTIONS_KEY });
      toast.success(`Connection "${connection.name}" updated`);
    },
    onError: (err: unknown) => {
      toast.error(`Failed to update connection: ${errMsg(err)}`);
    },
  });
}

export function useDeleteConnection() {
  const qc = useQueryClient();
  const remove = useConnectionStore((s) => s.removeConnection);

  return useMutation({
    mutationFn: deleteConnection,
    onSuccess: (_, id) => {
      remove(id);
      qc.invalidateQueries({ queryKey: CONNECTIONS_KEY });
      toast.success("Connection deleted");
    },
    onError: (err: unknown) => {
      toast.error(`Failed to delete connection: ${errMsg(err)}`);
    },
  });
}

export function useStartOAuth() {
  const qc = useQueryClient();

  return useMutation({
    mutationFn: startSalesforceOAuth,
    onSuccess: (username) => {
      qc.invalidateQueries({ queryKey: CONNECTIONS_KEY });
      toast.success(`Authenticated as ${username}`);
    },
    onError: (err: unknown) => {
      toast.error(`Authentication failed: ${errMsg(err)}`);
    },
  });
}

export function useTestConnection() {
  const qc = useQueryClient();

  return useMutation({
    mutationFn: testConnection,
    onSuccess: (result) => {
      qc.invalidateQueries({ queryKey: CONNECTIONS_KEY });
      if (result.success) {
        toast.success("Connection test passed");
      } else {
        toast.error(`Connection test failed: ${result.message}`);
      }
    },
    onError: (err: unknown) => {
      toast.error(`Test failed: ${errMsg(err)}`);
    },
  });
}

export function useDisconnect() {
  const qc = useQueryClient();

  return useMutation({
    mutationFn: disconnect,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: CONNECTIONS_KEY });
      toast.success("Disconnected");
    },
    onError: (err: unknown) => {
      toast.error(`Disconnect failed: ${errMsg(err)}`);
    },
  });
}

/** Per-org stats for the dashboard. Long stale time so we don't re-burn
 *  4 API calls every time the user navigates back to the dashboard. */
export function useOrgStats(connectionId: string | null) {
  return useQuery({
    queryKey: ["org_stats", connectionId ?? ""],
    queryFn: () => getOrgStats(connectionId!),
    enabled: !!connectionId,
    staleTime: 5 * 60 * 1000,
    gcTime: 30 * 60 * 1000,
    retry: false,
  });
}
