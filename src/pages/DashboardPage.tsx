import { useState } from "react";
import { Link } from "@tanstack/react-router";
import {
  Building2,
  Cable,
  Contact,
  Database,
  Download,
  FileText,
  Gauge,
  Loader2,
  Play,
  Settings,
  Target,
  Upload,
  ArrowRight,
} from "lucide-react";
import { useConnectionStore } from "@/stores/connectionStore";
import { useSavedQueries } from "@/hooks/useQueries";
import { useExportHistory } from "@/hooks/useExport";
import { useSyncHistory } from "@/hooks/useSync";
import { useConnections, useOrgStats } from "@/hooks/useConnections";
import type { Connection } from "@/lib/tauri-commands";
import { cn } from "@/lib/utils";
import GettingStartedCard, {
  type Milestone,
} from "@/components/dashboard/GettingStartedCard";

// ── Helpers ───────────────────────────────────────────────────────────────────

function greeting(): string {
  const h = new Date().getHours();
  if (h < 5) return "Still up";
  if (h < 12) return "Good morning";
  if (h < 18) return "Good afternoon";
  return "Good evening";
}

function formatLastRun(ts: number | null): string {
  if (!ts) return "never run";
  const diff = Math.floor(Date.now() / 1000) - ts;
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  if (diff < 86400 * 7) return `${Math.floor(diff / 86400)}d ago`;
  if (diff < 86400 * 30) return `${Math.floor(diff / (86400 * 7))}w ago`;
  return `${Math.floor(diff / (86400 * 30))}mo ago`;
}

// ── Dashboard ────────────────────────────────────────────────────────────────

export default function DashboardPage() {
  const connections = useConnectionStore((s) => s.connections);
  const connectedCount = connections.filter((c) => c.status === "connected").length;
  // Subscribe to the connections query so we can wait for the first fetch
  // to finish before deciding whether to show the onboarding card.
  const { isPending: connectionsPending } = useConnections();
  const { data: savedQueries = [] } = useSavedQueries();
  const { data: exportHistory = [] } = useExportHistory(100);
  const { data: syncHistory = [] } = useSyncHistory(100);

  // Counts for the stat cards
  const thirtyDaysAgo = Math.floor(Date.now() / 1000) - 30 * 86400;
  const recentExportCount = exportHistory.filter(
    (e) => e.exported_at >= thirtyDaysAgo
  ).length;
  const recentUpdateCount = syncHistory.filter(
    (s) => s.started_at >= thirtyDaysAgo && s.status !== "running"
  ).length;

  // Top 5 saved queries by last run (fall back to updated_at so new queries
  // are visible even before they've been run).
  const recentQueries = [...savedQueries]
    .sort((a, b) => (b.last_run ?? b.updated_at) - (a.last_run ?? a.updated_at))
    .slice(0, 5);

  const noOrgs = connectedCount === 0;
  const noQueries = savedQueries.length === 0;

  // ── Onboarding checklist ─────────────────────────────────────────────────
  // The "ran a query" milestone uses a localStorage flag set on first
  // successful executeQuery — saved-query last_run only covers saved queries,
  // so the flag also catches one-off ad-hoc runs.
  const hasRunQuery =
    typeof window !== "undefined" &&
    localStorage.getItem("upcells.onboarding.ranQuery") === "true";

  const [onboardingDismissed, setOnboardingDismissed] = useState<boolean>(() =>
    typeof window !== "undefined"
      ? localStorage.getItem("upcells.onboarding.dismissed") === "true"
      : false
  );

  function dismissOnboarding() {
    localStorage.setItem("upcells.onboarding.dismissed", "true");
    setOnboardingDismissed(true);
  }

  const milestones: Milestone[] = [
    {
      id: "connect",
      label: "Connect your first Salesforce org",
      hint: "Settings → Salesforce Orgs → Add org",
      done: connectedCount > 0,
      href: "/settings",
    },
    {
      id: "query",
      label: "Run your first query",
      hint: "Pick an object, choose fields, hit Run",
      done: hasRunQuery,
      href: "/data",
    },
    {
      id: "save",
      label: "Save a query for quick access",
      hint: "Saved queries appear in the sidebar and dashboard",
      done: savedQueries.length > 0,
      href: "/data",
    },
    {
      id: "export",
      label: "Export your first file",
      hint: "Run a query, then click Export",
      done: exportHistory.length > 0,
      href: "/data",
    },
    {
      id: "update",
      label: "Push an update back to Salesforce",
      hint: "Edit an exported file and use Update to apply changes",
      done: syncHistory.filter((s) => s.status !== "running").length > 0,
      href: "/update",
    },
  ];

  // Wait for the initial connections fetch before rendering — otherwise we'd
  // briefly show "Connect your first org" as unchecked on every cold start.
  const showOnboarding =
    !connectionsPending &&
    !onboardingDismissed &&
    milestones.some((m) => !m.done);

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {/* Header */}
      <div className="border-b px-6 py-4">
        <h1 className="text-lg font-semibold">Dashboard</h1>
        <p className="text-sm text-muted-foreground">
          {greeting()} — here's what's happening in your workspace
        </p>
      </div>

      {/* Body */}
      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-5xl space-y-8 p-6">
          {/* ── Onboarding checklist ────────────────────────────────────── */}
          {showOnboarding && (
            <GettingStartedCard
              milestones={milestones}
              onDismiss={dismissOnboarding}
            />
          )}

          {/* ── Stat cards ──────────────────────────────────────────────── */}
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <StatCard
              icon={Cable}
              label="Orgs connected"
              value={connectedCount}
            />
            <StatCard
              icon={FileText}
              label="Saved queries"
              value={savedQueries.length}
            />
            <StatCard
              icon={Download}
              label="Exports (30d)"
              value={recentExportCount}
            />
            <StatCard
              icon={Upload}
              label="Updates (30d)"
              value={recentUpdateCount}
            />
          </div>

          {/* ── Org stats (per connected org) ───────────────────────────── */}
          {connectedCount > 0 && (
            <section>
              <h2 className="mb-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                {connectedCount === 1
                  ? "Your Salesforce org"
                  : "Your Salesforce orgs"}
              </h2>
              <div className="space-y-4">
                {connections
                  .filter((c) => c.status === "connected")
                  .map((c) => (
                    <OrgStatsBlock
                      key={c.id}
                      connection={c}
                      showHeader={connectedCount > 1}
                    />
                  ))}
              </div>
            </section>
          )}

          {/* ── Quick actions ───────────────────────────────────────────── */}
          <section>
            <h2 className="mb-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Quick actions
            </h2>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              <ActionCard
                to="/data"
                icon={Database}
                title="Browse data"
                description="Pick a Salesforce object, choose fields, filter, run, and export"
                disabled={noOrgs}
              />
              <ActionCard
                to="/update"
                icon={Upload}
                title="Update CRM"
                description="Load an edited spreadsheet and preview the diff before pushing"
                disabled={noOrgs}
              />
              <ActionCard
                to="/settings"
                icon={Settings}
                title={noOrgs ? "Connect an org" : "Manage orgs"}
                description={
                  noOrgs
                    ? "Add your first Salesforce org to get started"
                    : "Connect more orgs or update app settings"
                }
              />
            </div>
          </section>

          {/* ── Recent saved queries ────────────────────────────────────── */}
          <section>
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Recent saved queries
              </h2>
              {savedQueries.length > 5 && (
                <Link
                  to="/data"
                  search={{}}
                  className="text-xs text-primary hover:underline"
                >
                  View all in Data →
                </Link>
              )}
            </div>
            {noQueries ? (
              <div className="rounded-lg border border-dashed p-8 text-center">
                <FileText className="mx-auto h-6 w-6 text-muted-foreground/40" />
                <p className="mt-2 text-sm font-medium">No saved queries yet</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  Build a query on the{" "}
                  <Link
                    to="/data"
                    search={{}}
                    className="text-primary hover:underline"
                  >
                    Data page
                  </Link>{" "}
                  and save it to see it here.
                </p>
              </div>
            ) : (
              <ul className="divide-y rounded-lg border">
                {recentQueries.map((q) => (
                  <li key={q.id}>
                    <Link
                      to="/data"
                      search={{ q: q.id }}
                      className="flex items-center gap-3 px-4 py-3 hover:bg-muted/40"
                    >
                      <div className="rounded-md bg-muted p-2 text-muted-foreground">
                        <FileText className="h-3.5 w-3.5" />
                      </div>
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium">{q.name}</p>
                        <p className="truncate text-xs text-muted-foreground">
                          {q.object_name && (
                            <span className="font-medium">{q.object_name}</span>
                          )}
                          {q.object_name && " · "}
                          {q.last_run
                            ? `last run ${formatLastRun(q.last_run)}`
                            : "never run"}
                          {q.last_record_count != null && q.last_run && (
                            <> · {q.last_record_count} rows</>
                          )}
                        </p>
                      </div>
                      <Play className="h-3.5 w-3.5 shrink-0 text-muted-foreground/40" />
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </section>

          {/* ── Recent exports (placeholder list if none yet) ──────────── */}
          <section>
            <h2 className="mb-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Recent exports
            </h2>
            {exportHistory.length === 0 ? (
              <div className="rounded-lg border border-dashed p-6 text-center">
                <Download className="mx-auto h-6 w-6 text-muted-foreground/40" />
                <p className="mt-2 text-xs text-muted-foreground">
                  Nothing exported yet
                </p>
              </div>
            ) : (
              <ul className="divide-y rounded-lg border">
                {exportHistory.slice(0, 5).map((e) => (
                  <li
                    key={e.id}
                    className="flex items-center gap-3 px-4 py-3"
                  >
                    <div className="rounded-md bg-muted p-2 text-muted-foreground">
                      <Download className="h-3.5 w-3.5" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm">
                        {e.file_path.split(/[/\\]/).pop()}
                      </p>
                      <p className="truncate text-xs text-muted-foreground">
                        {e.format.toUpperCase()}
                        {e.record_count != null && ` · ${e.record_count} rows`}
                        {" · "}
                        {formatLastRun(e.exported_at)}
                      </p>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}

// ── Per-org stats block ──────────────────────────────────────────────────────

function OrgStatsBlock({
  connection,
  showHeader,
}: {
  connection: Connection;
  showHeader: boolean;
}) {
  const { data: stats, isLoading, isError } = useOrgStats(connection.id);

  // Quota percentage — null when we don't have both numbers
  const quotaUsedPct =
    stats?.daily_api_max != null && stats?.daily_api_remaining != null
      ? 100 - (stats.daily_api_remaining / stats.daily_api_max) * 100
      : null;

  // Color the quota chip so people notice when they're burning through it
  const quotaColor =
    quotaUsedPct == null
      ? "text-muted-foreground"
      : quotaUsedPct >= 90
      ? "text-destructive"
      : quotaUsedPct >= 70
      ? "text-amber-600 dark:text-amber-400"
      : "text-emerald-600 dark:text-emerald-400";

  return (
    <div className={showHeader ? "space-y-2" : ""}>
      {showHeader && (
        <div className="flex items-baseline gap-2">
          <p className="text-sm font-semibold">{connection.name}</p>
          {connection.username && (
            <p className="text-xs text-muted-foreground">
              {connection.username}
            </p>
          )}
        </div>
      )}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <OrgStatCard
          icon={Building2}
          label="Accounts"
          value={stats?.accounts}
          isLoading={isLoading}
          isError={isError}
        />
        <OrgStatCard
          icon={Contact}
          label="Contacts"
          value={stats?.contacts}
          isLoading={isLoading}
          isError={isError}
        />
        <OrgStatCard
          icon={Target}
          label="Opportunities"
          value={stats?.opportunities}
          isLoading={isLoading}
          isError={isError}
        />
        <OrgStatCard
          icon={Gauge}
          label="API requests left"
          value={stats?.daily_api_remaining}
          total={stats?.daily_api_max ?? undefined}
          isLoading={isLoading}
          isError={isError}
          valueClassName={quotaColor}
        />
      </div>
      {stats && stats.errors.length > 0 && (
        <p className="text-xs text-amber-600 dark:text-amber-400">
          Some stats couldn't be loaded: {stats.errors.join(" · ")}
        </p>
      )}
    </div>
  );
}

function OrgStatCard({
  icon: Icon,
  label,
  value,
  total,
  isLoading,
  isError,
  valueClassName,
}: {
  icon: typeof Building2;
  label: string;
  value: number | null | undefined;
  total?: number;
  isLoading: boolean;
  isError: boolean;
  valueClassName?: string;
}) {
  const display = (() => {
    if (isLoading) return null;
    if (isError || value == null) return "—";
    return value.toLocaleString();
  })();

  return (
    <div className="rounded-lg border p-4">
      <Icon className="h-4 w-4 text-muted-foreground" />
      <div className="mt-3 flex items-baseline gap-1.5">
        {isLoading ? (
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        ) : (
          <p
            className={cn(
              "text-2xl font-bold tabular-nums",
              valueClassName
            )}
          >
            {display}
          </p>
        )}
        {total != null && value != null && (
          <p className="text-xs text-muted-foreground">
            / {total.toLocaleString()}
          </p>
        )}
      </div>
      <p className="text-xs text-muted-foreground">{label}</p>
    </div>
  );
}

// ── Stat card ────────────────────────────────────────────────────────────────

function StatCard({
  icon: Icon,
  label,
  value,
  hint,
}: {
  icon: typeof Cable;
  label: string;
  value: number | string;
  hint?: string;
}) {
  return (
    <div className="rounded-lg border p-4">
      <div className="flex items-center justify-between">
        <Icon className="h-4 w-4 text-muted-foreground" />
      </div>
      <p className="mt-3 text-2xl font-bold tabular-nums">{value}</p>
      <p className="text-xs text-muted-foreground">{label}</p>
      {hint && (
        <p className="mt-0.5 text-[10px] uppercase tracking-wide text-muted-foreground/50">
          {hint}
        </p>
      )}
    </div>
  );
}

// ── Action card ──────────────────────────────────────────────────────────────

function ActionCard({
  to,
  icon: Icon,
  title,
  description,
  disabled,
}: {
  to: string;
  icon: typeof Database;
  title: string;
  description: string;
  disabled?: boolean;
}) {
  const body = (
    <>
      <div className="rounded-md bg-primary/10 p-2 text-primary">
        <Icon className="h-4 w-4" />
      </div>
      <div className="mt-3 flex-1">
        <p className="font-semibold">{title}</p>
        <p className="mt-1 text-xs text-muted-foreground">{description}</p>
      </div>
      <ArrowRight className="mt-3 h-3.5 w-3.5 text-muted-foreground/40" />
    </>
  );

  if (disabled) {
    return (
      <div
        className={cn(
          "flex flex-col items-start gap-0 rounded-lg border p-4 opacity-50"
        )}
      >
        {body}
      </div>
    );
  }

  return (
    <Link
      to={to}
      search={to === "/data" ? {} : undefined}
      className="group flex flex-col items-start gap-0 rounded-lg border p-4 transition-colors hover:border-primary hover:bg-accent/30"
    >
      {body}
    </Link>
  );
}
