import { useState } from "react";
import { Link, useSearch, useRouterState } from "@tanstack/react-router";
import {
  Database,
  Upload,
  History,
  Settings,
  FileText,
  Trash2,
  LayoutDashboard,
  ShieldCheck,
  Sparkles,
} from "lucide-react";
import UpcellsLogo from "@/components/layout/UpcellsLogo";
import { cn } from "@/lib/utils";
import { useConnectionStore } from "@/stores/connectionStore";
import { useAdminStore } from "@/stores/adminStore";
import { useSavedQueries, useDeleteSavedQuery } from "@/hooks/useQueries";
import type { SavedQuery } from "@/lib/tauri-commands";

// ── Sidebar ───────────────────────────────────────────────────────────────────

export default function Sidebar() {
  const connections = useConnectionStore((s) => s.connections);
  const connectedCount = connections.filter((c) => c.status === "connected").length;
  const expiredCount = connections.filter((c) => c.status === "error").length;
  const adminEnabled = useAdminStore((s) => s.enabled);

  // The Data section auto-expands when the user is on /data and collapses
  // on any other route — no manual toggle needed.
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const dataActive = pathname.startsWith("/data");

  return (
    <aside className="flex h-full w-56 flex-col border-r bg-background">
      {/* Logo */}
      <div className="flex h-14 items-center gap-2.5 border-b px-4">
        <UpcellsLogo className="h-6 w-6 text-primary" />
        <div className="flex items-baseline gap-1.5">
          <span className="text-lg font-bold tracking-tight">Upcells</span>
          <span className="text-xs text-muted-foreground">for Salesforce</span>
        </div>
      </div>

      {/* Nav */}
      <nav className="flex-1 overflow-y-auto p-2">
        <div className="space-y-0.5">
          {/* Dashboard */}
          <SimpleNavLink to="/dashboard" icon={LayoutDashboard} label="Dashboard" />

          {/* Data — expands automatically when /data is the active route */}
          <DataGroup expanded={dataActive} />

          {/* Update CRM */}
          <SimpleNavLink to="/update" icon={Upload} label="Update CRM" />

          {/* Sales Accelerator (local AI) */}
          <SimpleNavLink to="/assistant" icon={Sparkles} label="Assistant" />

          {/* History */}
          <SimpleNavLink to="/history" icon={History} label="History" />

          {/* Admin (visible only when enabled in Settings) */}
          {adminEnabled && (
            <SimpleNavLink to="/admin" icon={ShieldCheck} label="Admin" />
          )}
        </div>
      </nav>

      {/* Secondary nav — Settings */}
      <div className="border-t p-2">
        <SimpleNavLink to="/settings" icon={Settings} label="Settings" />
      </div>

      {/* Org status footer */}
      <div className="border-t px-4 py-2.5">
        <div className="flex items-center gap-2">
          <div
            className={cn(
              "h-1.5 w-1.5 rounded-full",
              expiredCount > 0
                ? "bg-amber-500"
                : connectedCount > 0
                ? "bg-emerald-500"
                : "bg-muted-foreground/40"
            )}
          />
          <p
            className={cn(
              "text-xs",
              expiredCount > 0
                ? "text-amber-600 dark:text-amber-400"
                : "text-muted-foreground"
            )}
          >
            {connectedCount === 0 && expiredCount === 0
              ? "No org connected"
              : expiredCount > 0
              ? `${expiredCount} org${expiredCount > 1 ? "s" : ""} need${
                  expiredCount === 1 ? "s" : ""
                } reconnect`
              : `${connectedCount} org${connectedCount > 1 ? "s" : ""} connected`}
          </p>
        </div>
      </div>
    </aside>
  );
}

// ── Data group (parent link + auto-expanded children) ────────────────────────

function DataGroup({ expanded }: { expanded: boolean }) {
  const { data: savedQueries = [] } = useSavedQueries();

  return (
    <div>
      <Link
        to="/data"
        search={{}}
        className={cn(
          "flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground",
          "[&.active]:bg-accent [&.active]:text-accent-foreground"
        )}
        activeOptions={{ exact: true, includeSearch: false }}
      >
        <Database className="h-4 w-4 shrink-0" />
        Data
      </Link>

      {expanded && (
        <div className="ml-7 mt-0.5">
          <p className="px-2 py-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground/60">
            Saved queries
          </p>
          {savedQueries.length === 0 ? (
            <p className="px-2 py-1 text-xs italic text-muted-foreground/60">
              None yet
            </p>
          ) : (
            <ul className="space-y-0.5">
              {savedQueries.map((q) => (
                <li key={q.id}>
                  <SavedQueryRow query={q} />
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

// ── Single saved-query row with inline delete confirm ────────────────────────

function SavedQueryRow({ query }: { query: SavedQuery }) {
  const search = useSearch({ strict: false }) as { q?: string };
  const isActive = search.q === query.id;
  const [confirmDelete, setConfirmDelete] = useState(false);
  const deleteQuery = useDeleteSavedQuery();

  if (confirmDelete) {
    return (
      <div className="rounded-md border border-destructive/30 bg-destructive/5 p-1.5">
        <p className="mb-1 px-1 text-xs text-destructive truncate">
          Delete "{query.name}"?
        </p>
        <div className="flex gap-1">
          <button
            onClick={() => {
              deleteQuery.mutate(query.id);
              setConfirmDelete(false);
            }}
            className="flex-1 rounded-sm bg-destructive px-1.5 py-0.5 text-xs font-medium text-destructive-foreground hover:bg-destructive/90"
          >
            Delete
          </button>
          <button
            onClick={() => setConfirmDelete(false)}
            className="flex-1 rounded-sm border px-1.5 py-0.5 text-xs font-medium hover:bg-accent"
          >
            Cancel
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="group flex items-center">
      <Link
        to="/data"
        search={{ q: query.id }}
        className={cn(
          "flex min-w-0 flex-1 items-center gap-1.5 rounded-md px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground",
          isActive && "bg-accent text-accent-foreground"
        )}
      >
        <FileText className="h-3 w-3 shrink-0" />
        <span className="truncate">{query.name}</span>
      </Link>
      <button
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setConfirmDelete(true);
        }}
        className="flex h-5 w-5 shrink-0 items-center justify-center text-muted-foreground/40 opacity-0 transition-opacity hover:text-foreground group-hover:opacity-100"
        aria-label="Delete saved query"
      >
        <Trash2 className="h-3 w-3" />
      </button>
    </div>
  );
}

// ── Plain nav link for non-grouped items ─────────────────────────────────────

function SimpleNavLink({
  to,
  icon: Icon,
  label,
}: {
  to: string;
  icon: typeof Upload;
  label: string;
}) {
  return (
    <Link
      to={to}
      className={cn(
        "flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground",
        "[&.active]:bg-accent [&.active]:text-accent-foreground"
      )}
    >
      <Icon className="h-4 w-4 shrink-0" />
      {label}
    </Link>
  );
}
