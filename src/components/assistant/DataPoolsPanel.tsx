import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { Database, Plus, Trash2, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  useCreateDataPool,
  useDataPools,
  useDeleteDataPool,
} from "@/hooks/useAssistant";

/** Data-pool management: import a CSV/Excel export as a queryable pool, list, and delete.
 *  Pools are what the Sales Accelerator Assistant asks questions about. */
export default function DataPoolsPanel() {
  const pools = useDataPools();
  const createPool = useCreateDataPool();
  const deletePool = useDeleteDataPool();

  async function importPool() {
    const path = await openDialog({
      filters: [{ name: "Spreadsheet", extensions: ["csv", "xlsx", "xls"] }],
    });
    if (!path || typeof path !== "string") return;
    const base = path.split(/[\\/]/).pop()?.replace(/\.[^.]+$/, "") || "Data pool";
    await createPool.mutateAsync({ name: base, file_path: path }).catch(() => {});
  }

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between">
        <div>
          <h2 className="flex items-center gap-2 text-sm font-semibold">
            <Database className="h-4 w-4" /> Data pools
          </h2>
          <p className="text-xs text-muted-foreground">
            The Accelerator answers questions about these. The main way to create one is to run a
            query in <span className="font-medium">Query CRM</span> and choose{" "}
            <span className="font-medium">Save as Data Pool</span>. You can also import a file.
          </p>
        </div>
        <Button size="sm" variant="outline" onClick={importPool} disabled={createPool.isPending}>
          {createPool.isPending ? (
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
          ) : (
            <Plus className="mr-2 h-4 w-4" />
          )}
          Import a file
        </Button>
      </div>

      {pools.data && pools.data.length > 0 ? (
        <div className="space-y-1.5">
          {pools.data.map((p) => (
            <div
              key={p.id}
              className="flex items-center justify-between rounded-lg border px-3 py-2"
            >
              <div>
                <div className="text-sm font-medium">{p.name}</div>
                <div className="text-xs text-muted-foreground">
                  {p.row_count.toLocaleString()} rows · {p.columns.length} columns
                </div>
              </div>
              <Button size="icon" variant="ghost" onClick={() => deletePool.mutate(p.id)}>
                <Trash2 className="h-4 w-4 text-muted-foreground" />
              </Button>
            </div>
          ))}
        </div>
      ) : (
        <p className="rounded-lg border border-dashed px-4 py-8 text-center text-sm text-muted-foreground">
          No data pools yet. Run a query in <span className="font-medium">Query CRM</span> and
          choose <span className="font-medium">Save as Data Pool</span>, or import a spreadsheet.
        </p>
      )}
    </div>
  );
}
