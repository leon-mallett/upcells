import { useState } from "react";
import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import {
  Database,
  Search,
  LayoutGrid,
  Plus,
  Upload,
  FileText,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { useSavedQueries } from "@/hooks/useQueries";
import { useDataPools } from "@/hooks/useAssistant";
import { useSalesAccelerator } from "@/hooks/useLicense";
import QueriesPage from "./QueriesPage";
import DataPoolsPanel from "@/components/assistant/DataPoolsPanel";

type View = "overview" | "query" | "pools";

/** The Sales Data hub: an Overview landing (quick actions, saved queries, data pools) with the
 *  query builder and data-pool management one click away. */
export default function SalesDataPage() {
  const search = useSearch({ strict: false }) as { q?: string };
  const navigate = useNavigate();
  const salesAccelerator = useSalesAccelerator();
  // A saved-query deep link (?q=…) or reload lands straight on the builder.
  const [tab, setTab] = useState<View>(search.q ? "query" : "overview");

  function openSavedQuery(id: string) {
    navigate({ to: "/data", search: { q: id } });
    setTab("query");
  }
  function newQuery() {
    navigate({ to: "/data", search: {} });
    setTab("query");
  }

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <div className="flex items-center gap-1 border-b px-4 py-2">
        <TabButton
          active={tab === "overview"}
          onClick={() => setTab("overview")}
          icon={LayoutGrid}
          label="Overview"
        />
        <TabButton
          active={tab === "query"}
          onClick={() => setTab("query")}
          icon={Search}
          label="Query CRM"
        />
        {salesAccelerator && (
          <TabButton
            active={tab === "pools"}
            onClick={() => setTab("pools")}
            icon={Database}
            label="Data Pools"
          />
        )}
      </div>
      <div className="min-h-0 flex-1">
        {tab === "overview" && (
          <SalesDataOverview
            onNewQuery={newQuery}
            onOpenPools={() => setTab("pools")}
            onOpenSavedQuery={openSavedQuery}
          />
        )}
        {tab === "query" && <QueriesPage />}
        {tab === "pools" && salesAccelerator && (
          <div className="h-full overflow-y-auto p-6">
            <div className="mx-auto max-w-3xl">
              <DataPoolsPanel />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function SalesDataOverview({
  onNewQuery,
  onOpenPools,
  onOpenSavedQuery,
}: {
  onNewQuery: () => void;
  onOpenPools: () => void;
  onOpenSavedQuery: (id: string) => void;
}) {
  const { data: savedQueries = [] } = useSavedQueries();
  const { data: pools = [] } = useDataPools();
  const salesAccelerator = useSalesAccelerator();

  return (
    <div className="h-full overflow-y-auto p-6">
      <div className="mx-auto max-w-4xl space-y-8">
        {/* Quick actions */}
        <section>
          <h2 className="mb-3 text-sm font-semibold">Quick actions</h2>
          <div className="flex flex-wrap gap-2">
            <Button onClick={onNewQuery}>
              <Plus className="mr-2 h-4 w-4" />
              New CRM query
            </Button>
            {salesAccelerator && (
              <Button variant="outline" onClick={onOpenPools}>
                <Upload className="mr-2 h-4 w-4" />
                Import data
              </Button>
            )}
          </div>
        </section>

        {/* Saved queries */}
        <section>
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-sm font-semibold">Saved queries</h2>
            <span className="text-xs text-muted-foreground">
              {savedQueries.length} saved
            </span>
          </div>
          {savedQueries.length === 0 ? (
            <p className="rounded-lg border border-dashed px-4 py-8 text-center text-sm text-muted-foreground">
              No saved queries yet. Build a query and save it to reuse it here.
            </p>
          ) : (
            <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
              {savedQueries.map((q) => (
                <button
                  key={q.id}
                  onClick={() => onOpenSavedQuery(q.id)}
                  className="flex flex-col items-start gap-1 rounded-lg border p-3 text-left transition hover:border-primary/50 hover:bg-accent/30"
                >
                  <div className="flex w-full items-center gap-2">
                    <FileText className="h-4 w-4 shrink-0 text-muted-foreground" />
                    <span className="truncate text-sm font-medium">{q.name}</span>
                  </div>
                  <span className="text-xs text-muted-foreground">
                    {q.object_name ?? "—"}
                    {q.last_record_count != null &&
                      ` · ${q.last_record_count.toLocaleString()} rows`}
                  </span>
                </button>
              ))}
            </div>
          )}
        </section>

        {/* Data pools (Sales Accelerator) */}
        {salesAccelerator && (
          <section>
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-sm font-semibold">Data pools</h2>
              <div className="flex items-center gap-3 text-xs">
                <button className="text-muted-foreground hover:text-foreground" onClick={onOpenPools}>
                  Manage
                </button>
                <Link to="/assistant" className="text-primary hover:underline">
                  Ask in Assistant →
                </Link>
              </div>
            </div>
            {pools.length === 0 ? (
              <p className="rounded-lg border border-dashed px-4 py-8 text-center text-sm text-muted-foreground">
                No data pools yet. Run a query and choose "Save as Data Pool", or import a file.
              </p>
            ) : (
              <div className="space-y-1.5">
                {pools.map((p) => (
                  <div
                    key={p.id}
                    className="flex items-center justify-between rounded-lg border px-3 py-2"
                  >
                    <div className="flex items-center gap-2">
                      <Database className="h-4 w-4 text-muted-foreground" />
                      <span className="text-sm font-medium">{p.name}</span>
                    </div>
                    <span className="text-xs text-muted-foreground">
                      {p.row_count.toLocaleString()} rows · {p.columns.length} cols
                    </span>
                  </div>
                ))}
              </div>
            )}
          </section>
        )}
      </div>
    </div>
  );
}

function TabButton({
  active,
  onClick,
  icon: Icon,
  label,
}: {
  active: boolean;
  onClick: () => void;
  icon: typeof Database;
  label: string;
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
        active ? "bg-accent text-accent-foreground" : "text-muted-foreground hover:bg-accent/50",
      )}
    >
      <Icon className="h-4 w-4" />
      {label}
    </button>
  );
}
