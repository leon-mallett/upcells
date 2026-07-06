import { useState } from "react";
import { Database, Search } from "lucide-react";
import { cn } from "@/lib/utils";
import QueriesPage from "./QueriesPage";
import DataPoolsPanel from "@/components/assistant/DataPoolsPanel";

/** The Sales Data area. Interim two-view layout (query builder + data pools) — the fuller
 *  landing-page redesign is a follow-up. */
export default function SalesDataPage() {
  const [tab, setTab] = useState<"query" | "pools">("query");
  return (
    <div className="flex h-full flex-col overflow-hidden">
      <div className="flex items-center gap-1 border-b px-4 py-2">
        <TabButton
          active={tab === "query"}
          onClick={() => setTab("query")}
          icon={Search}
          label="Query CRM"
        />
        <TabButton
          active={tab === "pools"}
          onClick={() => setTab("pools")}
          icon={Database}
          label="Data Pools"
        />
      </div>
      <div className="min-h-0 flex-1">
        {tab === "query" ? (
          <QueriesPage />
        ) : (
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
