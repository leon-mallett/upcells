import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  readImportFile,
  computeSyncDiff,
  executeSync,
  listSyncHistory,
} from "@/lib/tauri-commands";
import { errMsg, isAuthFailure } from "@/hooks/useQueries";

export const SYNC_HISTORY_KEY = ["sync_history"] as const;

function toastError(message: string) {
  toast.error(message, {
    duration: 20000,
    action: {
      label: "Copy",
      onClick: () => navigator.clipboard.writeText(message),
    },
  });
}

export function useReadImportFile() {
  return useMutation({
    mutationFn: readImportFile,
    onError: (err: unknown) => {
      toastError(`Failed to read file: ${errMsg(err)}`);
    },
  });
}

export function useComputeSyncDiff() {
  const qc = useQueryClient();

  return useMutation({
    mutationFn: computeSyncDiff,
    onError: (err: unknown) => {
      if (isAuthFailure(err)) {
        qc.invalidateQueries({ queryKey: ["connections"] });
        toast.error(
          "Your Salesforce session has expired. Reconnect using the banner above."
        );
      } else {
        toastError(`Diff failed: ${errMsg(err)}`);
      }
    },
  });
}

export function useExecuteSync() {
  const qc = useQueryClient();

  return useMutation({
    mutationFn: executeSync,
    onError: (err: unknown) => {
      if (isAuthFailure(err)) {
        qc.invalidateQueries({ queryKey: ["connections"] });
        toast.error(
          "Your Salesforce session has expired. Reconnect using the banner above."
        );
      } else {
        toastError(`Sync failed: ${errMsg(err)}`);
      }
    },
  });
}

export function useSyncHistory(limit?: number) {
  return useQuery({
    queryKey: [...SYNC_HISTORY_KEY, limit ?? 100],
    queryFn: () => listSyncHistory(limit),
  });
}
