import { useState } from "react";
import {
  Cable,
  KeyRound,
  Info,
  Plus,
  RefreshCw,
  FileText,
  Download,
  Upload,
  Loader2,
  SlidersHorizontal,
  Sun,
  Moon,
  Monitor,
  CalendarDays,
  Sparkles,
} from "lucide-react";
import { save as saveDialog, open as openDialog } from "@tauri-apps/plugin-dialog";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import ConnectionList from "@/components/connections/ConnectionList";
import ConnectionForm from "@/components/connections/ConnectionForm";
import { useConnections } from "@/hooks/useConnections";
import {
  useSavedQueries,
  useExportSavedQueriesToFile,
  useImportSavedQueriesFromFile,
} from "@/hooks/useQueries";
import { useUiStore } from "@/stores/uiStore";
import { useThemeStore, type ThemeChoice } from "@/stores/themeStore";
import { useDateFormatStore, type DateFormatChoice } from "@/stores/dateFormatStore";
import { useAdminStore } from "@/stores/adminStore";
import {
  useLicenseStatus,
  useDeactivateLicense,
  useMachineFingerprint,
  useSalesAccelerator,
} from "@/hooks/useLicense";
import ModelManager from "@/components/assistant/ModelManager";
import UpcellsLogo from "@/components/layout/UpcellsLogo";
import { cn } from "@/lib/utils";
import type { ImportSavedQueriesResult } from "@/lib/tauri-commands";

type SettingsTab =
  | "orgs"
  | "queries"
  | "assistant"
  | "preferences"
  | "license"
  | "about";

const tabs: { id: SettingsTab; label: string; icon: typeof Cable }[] = [
  { id: "orgs", label: "Salesforce Orgs", icon: Cable },
  { id: "queries", label: "Saved Queries", icon: FileText },
  { id: "assistant", label: "AI Assistant", icon: Sparkles },
  { id: "preferences", label: "Preferences", icon: SlidersHorizontal },
  { id: "license", label: "License", icon: KeyRound },
  { id: "about", label: "About", icon: Info },
];

export default function SettingsPage() {
  const [tab, setTab] = useState<SettingsTab>("orgs");
  const salesAccelerator = useSalesAccelerator();
  // The AI Assistant tab is only shown for licences with the tier.
  const visibleTabs = tabs.filter((t) => t.id !== "assistant" || salesAccelerator);

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {/* Header */}
      <div className="border-b px-6 py-4">
        <h1 className="text-lg font-semibold">Settings</h1>
        <p className="text-sm text-muted-foreground">
          Manage connected orgs, license, and app preferences
        </p>
      </div>

      {/* Tabs */}
      <div className="border-b px-6">
        <div className="flex gap-1">
          {visibleTabs.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              onClick={() => setTab(id)}
              className={cn(
                "flex items-center gap-2 px-4 py-2.5 text-sm font-medium border-b-2 -mb-px transition-colors",
                tab === id
                  ? "border-primary text-foreground"
                  : "border-transparent text-muted-foreground hover:text-foreground"
              )}
            >
              <Icon className="h-3.5 w-3.5" />
              {label}
            </button>
          ))}
        </div>
      </div>

      {/* Tab content */}
      <div className="flex-1 overflow-y-auto">
        {tab === "orgs" && <OrgsTab />}
        {tab === "queries" && <SavedQueriesTab />}
        {tab === "assistant" && <AiAssistantTab />}
        {tab === "preferences" && <PreferencesTab />}
        {tab === "license" && <LicenseTab />}
        {tab === "about" && <AboutTab />}
      </div>
    </div>
  );
}

// ── Orgs tab ──────────────────────────────────────────────────────────────────

function OrgsTab() {
  const { isLoading, isError, refetch } = useConnections();
  const openForm = useUiStore((s) => s.openConnectionForm);

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b px-6 py-3">
        <p className="text-sm text-muted-foreground">
          Connect the Salesforce orgs you want to work with. You'll pick one
          per Data or Update operation.
        </p>
        <div className="flex items-center gap-2">
          <Button
            variant="ghost"
            size="icon"
            onClick={() => refetch()}
            title="Refresh"
          >
            <RefreshCw className={isLoading ? "animate-spin" : ""} />
          </Button>
          <Button onClick={() => openForm()}>
            <Plus />
            Add org
          </Button>
        </div>
      </div>
      <div className="flex-1 overflow-y-auto p-6">
        {isError ? (
          <div className="rounded-lg border border-destructive/50 bg-destructive/10 p-4 text-sm text-destructive">
            Failed to load orgs. Please restart the app.
          </div>
        ) : (
          <ConnectionList />
        )}
      </div>
      <ConnectionForm />
    </div>
  );
}

// ── Saved queries tab ─────────────────────────────────────────────────────────

function SavedQueriesTab() {
  const { data: savedQueries = [] } = useSavedQueries();
  const exportQueries = useExportSavedQueriesToFile();
  const importQueries = useImportSavedQueriesFromFile();

  const [lastImport, setLastImport] = useState<ImportSavedQueriesResult | null>(
    null
  );

  // We track *excluded* ids rather than *selected* ids. Default is "nothing
  // excluded" = everything checked, so any new query that arrives (from an
  // import, or a fresh save) is automatically in the export set. Users opt
  // out individually.
  const [excluded, setExcluded] = useState<Set<string>>(new Set());

  const selectedIds = savedQueries
    .filter((q) => !excluded.has(q.id))
    .map((q) => q.id);
  const selectedCount = selectedIds.length;

  function toggleQuery(id: string) {
    setExcluded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function selectAll() {
    setExcluded(new Set());
  }

  function selectNone() {
    setExcluded(new Set(savedQueries.map((q) => q.id)));
  }

  async function handleExport() {
    if (selectedCount === 0) return;

    const defaultName = `upcells-queries-${new Date()
      .toISOString()
      .slice(0, 10)}.json`;

    const path = await saveDialog({
      defaultPath: defaultName,
      filters: [{ name: "Upcells query bundle", extensions: ["json"] }],
    });

    if (!path) return;

    exportQueries.mutate(
      { file_path: path, query_ids: selectedIds },
      {
        onSuccess: (count) => {
          toast.success(
            `Exported ${count} saved quer${count === 1 ? "y" : "ies"} to ${path
              .split(/[/\\]/)
              .pop()}`
          );
        },
      }
    );
  }

  async function handleImport() {
    const path = await openDialog({
      multiple: false,
      directory: false,
      filters: [{ name: "Upcells query bundle", extensions: ["json"] }],
    });

    if (!path || typeof path !== "string") return;

    setLastImport(null);
    importQueries.mutate(path, {
      onSuccess: (result) => {
        setLastImport(result);
        if (result.imported > 0) {
          toast.success(
            `Imported ${result.imported} quer${result.imported === 1 ? "y" : "ies"}`
          );
        } else if (result.skipped_duplicates > 0) {
          toast.info("Everything in the file was already in your library");
        }
      },
    });
  }

  return (
    <div className="p-6">
      <div className="max-w-2xl space-y-6">
        {/* Current library */}
        <div className="rounded-lg border p-4">
          <div>
            <p className="font-medium">
              {savedQueries.length === 0
                ? "No saved queries yet"
                : `${savedQueries.length} saved quer${
                    savedQueries.length === 1 ? "y" : "ies"
                  } in your library`}
            </p>
            <p className="mt-1 text-sm text-muted-foreground">
              Save queries from the Data page first, then export the ones you
              want to share.
            </p>
          </div>
        </div>

        {/* Query picker */}
        {savedQueries.length > 0 && (
          <div className="rounded-lg border">
            <div className="flex items-center justify-between border-b px-4 py-2.5">
              <div className="flex items-center gap-2">
                <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  Queries
                </p>
                <span className="text-xs text-muted-foreground">
                  {selectedCount} of {savedQueries.length} selected
                </span>
              </div>
              <div className="flex items-center gap-1 text-xs">
                <button
                  className="text-primary hover:underline"
                  onClick={selectAll}
                >
                  All
                </button>
                <span className="text-muted-foreground/40">·</span>
                <button
                  className="text-primary hover:underline"
                  onClick={selectNone}
                >
                  None
                </button>
              </div>
            </div>
            <ul className="max-h-72 divide-y overflow-y-auto">
              {savedQueries.map((q) => {
                const isSelected = !excluded.has(q.id);
                return (
                  <li key={q.id}>
                    <label className="flex cursor-pointer items-center gap-3 px-4 py-2 hover:bg-muted/40">
                      <input
                        type="checkbox"
                        className="h-3.5 w-3.5 accent-primary"
                        checked={isSelected}
                        onChange={() => toggleQuery(q.id)}
                      />
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium">{q.name}</p>
                        {q.object_name && (
                          <p className="truncate text-xs text-muted-foreground">
                            {q.object_name}
                          </p>
                        )}
                      </div>
                    </label>
                  </li>
                );
              })}
            </ul>
          </div>
        )}

        {/* Actions */}
        <div className="flex flex-wrap items-center gap-3">
          <Button
            onClick={handleExport}
            disabled={selectedCount === 0 || exportQueries.isPending}
          >
            {exportQueries.isPending ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Download className="h-4 w-4" />
            )}
            Export {selectedCount > 0 ? selectedCount : ""} selected
          </Button>
          <Button
            variant="outline"
            onClick={handleImport}
            disabled={importQueries.isPending}
          >
            {importQueries.isPending ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Upload className="h-4 w-4" />
            )}
            Import from file
          </Button>
        </div>

        {/* Last import result */}
        {lastImport && (
          <div className="rounded-lg border bg-muted/30 p-4">
            <p className="text-sm font-semibold">Last import</p>
            <ul className="mt-2 space-y-1 text-sm">
              <li className="text-muted-foreground">
                {lastImport.total_in_file} quer
                {lastImport.total_in_file === 1 ? "y" : "ies"} in the file
              </li>
              {lastImport.imported > 0 && (
                <li className="text-emerald-700 dark:text-emerald-400">
                  {lastImport.imported} added to your library
                </li>
              )}
              {lastImport.renamed > 0 && (
                <li className="text-amber-700 dark:text-amber-400">
                  {lastImport.renamed} renamed to avoid name clashes
                </li>
              )}
              {lastImport.skipped_duplicates > 0 && (
                <li className="text-muted-foreground">
                  {lastImport.skipped_duplicates} skipped (already in library)
                </li>
              )}
            </ul>
          </div>
        )}

        {/* Explainer */}
        <div className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">
          <p className="font-medium text-foreground">Sharing with your team</p>
          <p className="mt-1">
            A sales leader can build a set of standard queries (e.g. "Open
            Opportunities", "This Quarter's Closed Deals"), pick the ones
            meant for their team, export them, and send the file on.
            Colleagues import the file and get exactly the same queries in
            their own Upcells app.
          </p>
        </div>
      </div>
    </div>
  );
}

// ── AI Assistant tab ──────────────────────────────────────────────────────────

function AiAssistantTab() {
  return (
    <div className="p-6">
      <div className="max-w-2xl space-y-4">
        <div>
          <h2 className="text-sm font-semibold">Local AI model</h2>
          <p className="text-xs text-muted-foreground">
            Powers the Sales Accelerator assistant. Models run entirely on your machine —
            your data never leaves your device.
          </p>
        </div>
        <ModelManager />
      </div>
    </div>
  );
}

// ── Preferences tab ───────────────────────────────────────────────────────────

function PreferencesTab() {
  const themeChoice = useThemeStore((s) => s.choice);
  const setThemeChoice = useThemeStore((s) => s.setChoice);
  const dateChoice = useDateFormatStore((s) => s.choice);
  const setDateChoice = useDateFormatStore((s) => s.setChoice);
  const adminEnabled = useAdminStore((s) => s.enabled);
  const setAdminEnabled = useAdminStore((s) => s.setEnabled);

  const themeOptions: {
    value: ThemeChoice;
    label: string;
    icon: typeof Sun;
    hint: string;
  }[] = [
    { value: "system", label: "System", icon: Monitor, hint: "Match your OS" },
    { value: "light", label: "Light", icon: Sun, hint: "Always light" },
    { value: "dark", label: "Dark", icon: Moon, hint: "Always dark" },
  ];

  const dateOptions: {
    value: DateFormatChoice;
    label: string;
    example: string;
    hint: string;
  }[] = [
    {
      value: "iso",
      label: "ISO",
      example: "2026-04-16",
      hint: "Always safe, unambiguous",
    },
    {
      value: "international",
      label: "International",
      example: "16/04/2026",
      hint: "DD/MM/YYYY (UK, EU, AU, etc.)",
    },
    {
      value: "us",
      label: "US",
      example: "04/16/2026",
      hint: "MM/DD/YYYY (US, Philippines)",
    },
  ];

  return (
    <div className="p-6">
      <div className="max-w-2xl space-y-8">
        {/* ── Appearance ─────────────────────────────────────────────── */}
        <section>
          <h2 className="mb-1 text-sm font-semibold">Appearance</h2>
          <p className="mb-3 text-xs text-muted-foreground">
            Choose how Upcells looks. System follows your macOS / Windows theme.
          </p>
          <div className="grid gap-2 sm:grid-cols-3">
            {themeOptions.map(({ value, label, icon: Icon, hint }) => {
              const active = themeChoice === value;
              return (
                <button
                  key={value}
                  onClick={() => setThemeChoice(value)}
                  className={cn(
                    "flex flex-col items-start gap-1 rounded-lg border p-3 text-left transition-colors",
                    active
                      ? "border-primary bg-primary/5"
                      : "hover:border-primary/50 hover:bg-accent/30"
                  )}
                >
                  <div className="flex items-center gap-2">
                    <Icon
                      className={cn(
                        "h-4 w-4",
                        active ? "text-primary" : "text-muted-foreground"
                      )}
                    />
                    <span className="text-sm font-medium">{label}</span>
                  </div>
                  <p className="text-xs text-muted-foreground">{hint}</p>
                </button>
              );
            })}
          </div>
        </section>

        {/* ── Date format ────────────────────────────────────────────── */}
        <section>
          <h2 className="mb-1 flex items-center gap-2 text-sm font-semibold">
            <CalendarDays className="h-3.5 w-3.5" />
            Date format
          </h2>
          <p className="mb-3 text-xs text-muted-foreground">
            How to interpret ambiguous date strings when importing edited
            files. Excel reformats dates to your OS locale on save, so match
            this to how your orgs enter dates.
          </p>
          <div className="grid gap-2 sm:grid-cols-3">
            {dateOptions.map(({ value, label, example, hint }) => {
              const active = dateChoice === value;
              return (
                <button
                  key={value}
                  onClick={() => setDateChoice(value)}
                  className={cn(
                    "flex flex-col items-start gap-1 rounded-lg border p-3 text-left transition-colors",
                    active
                      ? "border-primary bg-primary/5"
                      : "hover:border-primary/50 hover:bg-accent/30"
                  )}
                >
                  <div className="flex items-baseline justify-between gap-2 w-full">
                    <span className="text-sm font-medium">{label}</span>
                    <code className="text-xs text-muted-foreground">
                      {example}
                    </code>
                  </div>
                  <p className="text-xs text-muted-foreground">{hint}</p>
                </button>
              );
            })}
          </div>
        </section>

        {/* ── Admin mode ───────────────────────────────────────────── */}
        <section>
          <h2 className="mb-1 text-sm font-semibold">Admin tools</h2>
          <p className="mb-3 text-xs text-muted-foreground">
            Enable Salesforce admin features like unused-field detection and
            org health checks. These tools require Salesforce admin permissions
            and are intended for org administrators, not regular users.
          </p>
          <label className="flex items-center gap-3 rounded-lg border p-4 cursor-pointer hover:border-primary/50 hover:bg-accent/30 transition-colors">
            <input
              type="checkbox"
              className="h-4 w-4 accent-primary"
              checked={adminEnabled}
              onChange={(e) => setAdminEnabled(e.target.checked)}
            />
            <div>
              <p className="text-sm font-medium">
                Enable admin tools
              </p>
              <p className="text-xs text-muted-foreground">
                Shows an Admin section in the sidebar with org optimisation
                features. Will require an admin-tier licence in a future
                release.
              </p>
            </div>
          </label>
        </section>
      </div>
    </div>
  );
}

// ── License tab ───────────────────────────────────────────────────────────────

function LicenseTab() {
  const skipLicense = import.meta.env.VITE_SKIP_LICENSE === "true";
  const { data: license, isLoading } = useLicenseStatus();
  const { data: fingerprint } = useMachineFingerprint();
  const deactivate = useDeactivateLicense();
  const [confirmOpen, setConfirmOpen] = useState(false);

  // ── Dev mode ───────────────────────────────────────────────────────────
  if (skipLicense) {
    return (
      <div className="p-6">
        <div className="max-w-xl space-y-4">
          <div className="rounded-lg border border-amber-300 bg-amber-50 p-4 dark:border-amber-900 dark:bg-amber-950/40">
            <div className="flex items-center gap-3">
              <KeyRound className="h-5 w-5 text-amber-600 dark:text-amber-400" />
              <div>
                <p className="font-medium">Development mode</p>
                <p className="text-sm text-amber-800 dark:text-amber-300">
                  License checks are disabled via{" "}
                  <code>VITE_SKIP_LICENSE=true</code>. Unset this for release
                  builds.
                </p>
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  }

  // ── Masking helper for the license key ─────────────────────────────────
  function maskKey(k: string): string {
    if (k.length <= 8) return k;
    return `${k.slice(0, 4)}${"•".repeat(Math.max(0, k.length - 8))}${k.slice(-4)}`;
  }

  // ── Main UI ────────────────────────────────────────────────────────────
  return (
    <div className="p-6">
      <div className="max-w-xl space-y-4">
        {isLoading && (
          <div className="flex items-center gap-2 rounded-lg border p-4">
            <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
            <p className="text-sm text-muted-foreground">
              Checking license status…
            </p>
          </div>
        )}

        {!isLoading && license && (
          <div className="rounded-lg border p-4">
            <div className="flex items-start gap-3">
              <KeyRound className="h-5 w-5 text-emerald-600 dark:text-emerald-400 shrink-0" />
              <div className="flex-1">
                <div className="flex items-baseline gap-2">
                  <p className="font-medium capitalize">{license.status}</p>
                  {license.expiry && (
                    <p className="text-xs text-muted-foreground">
                      expires {new Date(license.expiry).toLocaleDateString()}
                    </p>
                  )}
                </div>
                <p className="mt-0.5 text-sm text-muted-foreground">
                  {license.message}
                </p>
                <div className="mt-3 space-y-1 text-xs text-muted-foreground">
                  <div className="flex justify-between">
                    <span>License key</span>
                    <code className="text-foreground">
                      {maskKey(license.key)}
                    </code>
                  </div>
                  {license.machine_limit != null && (
                    <div className="flex justify-between">
                      <span>Machine limit</span>
                      <span>
                        {license.machine_count ?? "?"} /{" "}
                        {license.machine_limit}
                      </span>
                    </div>
                  )}
                  {fingerprint && (
                    <div className="flex justify-between">
                      <span>This machine</span>
                      <code className="text-foreground">
                        {fingerprint.slice(0, 8)}…
                      </code>
                    </div>
                  )}
                </div>
              </div>
            </div>
          </div>
        )}

        {!isLoading && !license && (
          <div className="rounded-lg border p-4">
            <p className="text-sm text-muted-foreground">
              No license information available. If you think this is wrong,
              try restarting the app.
            </p>
          </div>
        )}

        {/* Deactivate */}
        {!isLoading && license && (
          <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-4">
            <p className="font-medium">Deactivate on this machine</p>
            <p className="mt-1 text-sm text-muted-foreground">
              Removes the license from this machine so you can activate it
              elsewhere. You'll need your license key to reactivate here.
            </p>
            <Button
              variant="destructive"
              size="sm"
              className="mt-3"
              onClick={() => setConfirmOpen(true)}
            >
              Deactivate license
            </Button>
          </div>
        )}
      </div>

      {/* Deactivate confirmation */}
      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Deactivate license?</DialogTitle>
          </DialogHeader>
          <div className="py-2 text-sm text-muted-foreground">
            This will remove the license from this machine. You'll need to
            enter your license key again to use Upcells here. Your Salesforce
            org connections and saved queries stay on disk.
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                deactivate.mutate();
                setConfirmOpen(false);
              }}
            >
              {deactivate.isPending && (
                <Loader2 className="h-3 w-3 animate-spin" />
              )}
              Deactivate
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ── About tab ─────────────────────────────────────────────────────────────────

function AboutTab() {
  const [updateStatus, setUpdateStatus] = useState<
    "idle" | "checking" | "available" | "downloading" | "up-to-date" | "error"
  >("idle");
  const [updateError, setUpdateError] = useState("");
  const [updateVersion, setUpdateVersion] = useState("");

  async function checkForUpdates() {
    setUpdateStatus("checking");
    setUpdateError("");
    try {
      const { check } = await import("@tauri-apps/plugin-updater");
      const update = await check();
      if (update) {
        setUpdateVersion(update.version);
        setUpdateStatus("available");
      } else {
        setUpdateStatus("up-to-date");
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      // Don't treat "not configured" as a scary error — just show idle state
      if (msg.includes("pubkey") || msg.includes("endpoint")) {
        setUpdateStatus("idle");
        setUpdateError("Auto-updater is not configured yet (pubkey + endpoint needed)");
      } else {
        setUpdateStatus("error");
        setUpdateError(msg);
      }
    }
  }

  async function installUpdate() {
    setUpdateStatus("downloading");
    try {
      const { check } = await import("@tauri-apps/plugin-updater");
      const update = await check();
      if (update) {
        await update.downloadAndInstall();
        // Tauri will restart the app after install
      }
    } catch (e: unknown) {
      setUpdateStatus("error");
      setUpdateError(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <div className="p-6">
      <div className="max-w-xl space-y-6">
        <div className="flex items-center gap-3">
          <UpcellsLogo className="h-10 w-10 text-primary" />
          <div>
            <h2 className="text-xl font-bold tracking-tight">Upcells</h2>
            <p className="text-sm text-muted-foreground">
              Spreadsheet editing for Salesforce
            </p>
          </div>
        </div>

        <div className="space-y-1 text-sm">
          <p className="text-muted-foreground">
            Query your Salesforce data into xlsx or csv, edit it locally in
            your spreadsheet of choice, and push changes back with a diff
            preview and per-row validation.
          </p>
        </div>

        <div className="space-y-2 rounded-lg border p-4 text-sm">
          <div className="flex justify-between">
            <span className="text-muted-foreground">Version</span>
            <span className="font-mono">0.1.0</span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted-foreground">Built with</span>
            <span>Tauri 2 · React · Rust</span>
          </div>
        </div>

        {/* ── Update checker ──────────────────────────────────────── */}
        <div className="rounded-lg border p-4">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium">Software updates</p>
              <p className="mt-0.5 text-xs text-muted-foreground">
                {updateStatus === "idle" && "Check whether a newer version is available"}
                {updateStatus === "checking" && "Checking for updates…"}
                {updateStatus === "up-to-date" && "You're on the latest version"}
                {updateStatus === "available" && `Version ${updateVersion} is available`}
                {updateStatus === "downloading" && "Downloading and installing…"}
                {updateStatus === "error" && updateError}
              </p>
            </div>
            <div>
              {(updateStatus === "idle" || updateStatus === "up-to-date" || updateStatus === "error") && (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={checkForUpdates}
                >
                  Check for updates
                </Button>
              )}
              {updateStatus === "checking" && (
                <Button size="sm" variant="outline" disabled>
                  <Loader2 className="h-3 w-3 animate-spin" />
                  Checking…
                </Button>
              )}
              {updateStatus === "available" && (
                <Button size="sm" onClick={installUpdate}>
                  Install update
                </Button>
              )}
              {updateStatus === "downloading" && (
                <Button size="sm" disabled>
                  <Loader2 className="h-3 w-3 animate-spin" />
                  Installing…
                </Button>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
