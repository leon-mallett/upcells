import { useMutation, useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { exportQueryResults, listExportHistory } from "@/lib/tauri-commands";
import { errMsg } from "@/hooks/useQueries";

export const EXPORT_HISTORY_KEY = ["export_history"] as const;

function toastError(message: string) {
  toast.error(message, {
    duration: 20000,
    action: {
      label: "Copy",
      onClick: () => navigator.clipboard.writeText(message),
    },
  });
}

export function useExportQueryResults() {
  return useMutation({
    mutationFn: exportQueryResults,
    onSuccess: (record) => {
      toast.success(
        `Exported ${record.record_count ?? 0} record${
          record.record_count === 1 ? "" : "s"
        } to ${record.file_path.split("/").pop()}`
      );
    },
    onError: (err: unknown) => {
      toastError(`Export failed: ${errMsg(err)}`);
    },
  });
}

export function useExportHistory(limit?: number) {
  return useQuery({
    queryKey: [...EXPORT_HISTORY_KEY, limit ?? 50],
    queryFn: () => listExportHistory(limit),
  });
}
