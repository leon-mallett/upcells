import { useState, useMemo } from "react";
import {
  ShieldCheck,
  Search,
  Loader2,
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  BarChart3,
  Copy,
  Users,
} from "lucide-react";
import { useMutation } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useConnectionStore } from "@/stores/connectionStore";
import { useSobjects, useDescribeObject } from "@/hooks/useQueries";
import {
  analyseFieldPopulation,
  detectDuplicates,
  analyseRecordOwnership,
} from "@/lib/tauri-commands";
import type {
  FieldAnalysisResult,
  FieldPopulationInfo,
  DuplicateAnalysisResult,
  OwnershipResult,
} from "@/lib/tauri-commands";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import { errMsg } from "@/hooks/useQueries";

// ── Shared object picker ──────────────────────────────────────────────────────

function useObjectPicker() {
  const connections = useConnectionStore((s) => s.connections);
  const connectedConnections = connections.filter(
    (c) => c.status === "connected" || c.status === "error"
  );
  const [connectionId, setConnectionId] = useState<string>(
    () => connectedConnections[0]?.id ?? ""
  );
  const [objectName, setObjectName] = useState("");
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [search, setSearch] = useState("");
  const { data: sobjects = [] } = useSobjects(connectionId || null);

  return {
    connectionId,
    setConnectionId,
    objectName,
    setObjectName,
    dropdownOpen,
    setDropdownOpen,
    search,
    setSearch,
    connectedConnections,
    sobjects,
  };
}

const COMMON_OBJECTS = [
  "Account",
  "Contact",
  "Opportunity",
  "Lead",
  "Case",
  "Task",
  "Event",
  "User",
];

function ObjectPickerUI({
  picker,
  onObjectChange,
}: {
  picker: ReturnType<typeof useObjectPicker>;
  onObjectChange?: () => void;
}) {
  const searchLower = picker.search.toLowerCase();
  const allObjectNames = new Set(picker.sobjects.map((o) => o.name));

  const commonFiltered = COMMON_OBJECTS.filter(
    (n) =>
      n.toLowerCase().includes(searchLower) ||
      (allObjectNames.has(n) &&
        picker.sobjects
          .find((o) => o.name === n)
          ?.label.toLowerCase()
          .includes(searchLower))
  );

  const otherObjects = picker.sobjects
    .filter((o) => !COMMON_OBJECTS.includes(o.name))
    .filter(
      (o) =>
        o.name.toLowerCase().includes(searchLower) ||
        o.label.toLowerCase().includes(searchLower)
    )
    .sort((a, b) => a.label.localeCompare(b.label));

  function selectObject(name: string) {
    picker.setObjectName(name);
    picker.setDropdownOpen(false);
    picker.setSearch("");
    onObjectChange?.();
  }

  return (
    <div className="flex items-end gap-3">
      {picker.connectedConnections.length > 1 && (
        <div className="space-y-1">
          <label className="text-xs font-medium text-muted-foreground">Org</label>
          <select
            className="h-8 rounded-md border bg-background px-2 text-sm"
            value={picker.connectionId}
            onChange={(e) => picker.setConnectionId(e.target.value)}
          >
            {picker.connectedConnections.map((c) => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
          </select>
        </div>
      )}
      <div className="space-y-1">
        <label className="text-xs font-medium text-muted-foreground">Object</label>
        <div className="relative">
          <Button
            variant="outline"
            size="sm"
            className="h-8 gap-1.5 text-xs"
            onClick={() => picker.setDropdownOpen((o) => !o)}
            disabled={!picker.connectionId}
          >
            {picker.objectName || "Select object…"}
            <ChevronDown className="h-3 w-3" />
          </Button>
          {picker.dropdownOpen && (
            <>
              <div className="fixed inset-0 z-40" onClick={() => picker.setDropdownOpen(false)} />
              <div className="absolute left-0 top-9 z-50 w-72 rounded-md border bg-popover shadow-md">
                <div className="border-b p-2">
                  <Input
                    placeholder="Search objects…"
                    value={picker.search}
                    onChange={(e) => picker.setSearch(e.target.value)}
                    className="h-7 text-xs"
                    autoFocus
                  />
                </div>
                <div className="max-h-80 overflow-y-auto py-1">
                  {commonFiltered.length > 0 && (
                    <>
                      <p className="px-3 py-1 text-xs font-semibold text-muted-foreground">Common</p>
                      {commonFiltered.map((name) => {
                        const meta = picker.sobjects.find((o) => o.name === name);
                        return (
                          <button
                            key={name}
                            className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm hover:bg-muted"
                            onClick={() => selectObject(name)}
                          >
                            <span className="font-medium">{name}</span>
                            {meta && <span className="text-xs text-muted-foreground">{meta.label}</span>}
                          </button>
                        );
                      })}
                    </>
                  )}
                  {otherObjects.length > 0 && (
                    <>
                      <p className="px-3 py-1 text-xs font-semibold text-muted-foreground">All objects</p>
                      {otherObjects.map((o) => (
                        <button
                          key={o.name}
                          className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm hover:bg-muted"
                          onClick={() => selectObject(o.name)}
                        >
                          <span>{o.label}</span>
                          <span className="text-xs text-muted-foreground">{o.name}</span>
                        </button>
                      ))}
                    </>
                  )}
                </div>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Admin tabs ────────────────────────────────────────────────────────────────

type AdminTab = "fields" | "duplicates" | "ownership";

const TABS: { id: AdminTab; label: string; icon: typeof BarChart3 }[] = [
  { id: "fields", label: "Unused Fields", icon: BarChart3 },
  { id: "duplicates", label: "Duplicates", icon: Copy },
  { id: "ownership", label: "Ownership", icon: Users },
];

export default function AdminPage() {
  const [tab, setTab] = useState<AdminTab>("fields");

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {/* Header */}
      <div className="border-b px-6 py-4">
        <div className="flex items-center gap-2">
          <ShieldCheck className="h-5 w-5 text-primary" />
          <div>
            <h1 className="text-lg font-semibold">Admin</h1>
            <p className="text-sm text-muted-foreground">
              Salesforce org optimisation tools
            </p>
          </div>
        </div>
      </div>

      {/* Tabs */}
      <div className="border-b px-6">
        <div className="flex gap-1">
          {TABS.map(({ id, label, icon: Icon }) => (
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
      <div className="flex-1 overflow-hidden">
        {tab === "fields" && <FieldPopulationTab />}
        {tab === "duplicates" && <DuplicateDetectionTab />}
        {tab === "ownership" && <OwnershipTab />}
      </div>
    </div>
  );
}

// ── Field Population Tab ──────────────────────────────────────────────────────

type FieldFilter = "all" | "empty" | "low" | "healthy";

function FieldPopulationTab() {
  const picker = useObjectPicker();
  const [result, setResult] = useState<FieldAnalysisResult | null>(null);
  const [filterMode, setFilterMode] = useState<FieldFilter>("all");
  const [fieldSearch, setFieldSearch] = useState("");

  const analyse = useMutation({
    mutationFn: analyseFieldPopulation,
    onSuccess: (data) => { setResult(data); setFilterMode("all"); },
    onError: (err: unknown) => toast.error(`Analysis failed: ${errMsg(err)}`),
  });

  const filteredFields = useMemo(() => {
    if (!result) return [];
    let fields = result.fields;
    if (filterMode === "empty") fields = fields.filter((f) => f.population_pct === 0);
    else if (filterMode === "low") fields = fields.filter((f) => f.population_pct < 5);
    else if (filterMode === "healthy") fields = fields.filter((f) => f.population_pct >= 50);
    if (fieldSearch) {
      const q = fieldSearch.toLowerCase();
      fields = fields.filter((f) => f.name.toLowerCase().includes(q) || f.label.toLowerCase().includes(q));
    }
    return fields;
  }, [result, filterMode, fieldSearch]);

  const emptyCount = result?.fields.filter((f) => f.population_pct === 0).length ?? 0;
  const lowCount = result?.fields.filter((f) => f.population_pct > 0 && f.population_pct < 5).length ?? 0;
  const healthyCount = result?.fields.filter((f) => f.population_pct >= 50).length ?? 0;

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <div className="flex items-end gap-3 border-b px-6 py-3">
        <ObjectPickerUI picker={picker} onObjectChange={() => setResult(null)} />
        <Button
          onClick={() => picker.objectName && picker.connectionId && analyse.mutate({ connection_id: picker.connectionId, object_name: picker.objectName })}
          disabled={!picker.objectName || analyse.isPending}
        >
          {analyse.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <BarChart3 className="h-4 w-4" />}
          Analyse fields
        </Button>
      </div>

      {!result && !analyse.isPending && (
        <div className="flex flex-1 items-center justify-center">
          <div className="text-center">
            <BarChart3 className="mx-auto h-8 w-8 text-muted-foreground/40" />
            <p className="mt-3 text-sm text-muted-foreground">Pick an object and click Analyse to see field population rates</p>
          </div>
        </div>
      )}

      {analyse.isPending && (
        <div className="flex flex-1 items-center justify-center gap-2">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          <span className="text-sm text-muted-foreground">Querying up to 2,000 records…</span>
        </div>
      )}

      {result && (
        <>
          <div className="flex flex-wrap items-center gap-2 border-b px-6 py-3">
            <span className="text-sm text-muted-foreground">
              {result.fields.length} fields · sampled {result.sample_size.toLocaleString()} of {result.total_records.toLocaleString()} records
            </span>
            <div className="ml-auto flex items-center gap-2">
              {(["all", "empty", "low", "healthy"] as const).map((mode) => (
                <SmallChip key={mode} active={filterMode === mode} onClick={() => setFilterMode(mode)}
                  label={mode === "all" ? "All" : mode === "empty" ? "Empty" : mode === "low" ? "< 5%" : "≥ 50%"}
                  count={mode === "all" ? result.fields.length : mode === "empty" ? emptyCount : mode === "low" ? lowCount : healthyCount}
                />
              ))}
              <div className="relative ml-2">
                <Search className="pointer-events-none absolute left-2 top-1/2 h-3 w-3 -translate-y-1/2 text-muted-foreground" />
                <Input placeholder="Filter fields…" value={fieldSearch} onChange={(e) => setFieldSearch(e.target.value)} className="h-7 w-40 pl-7 text-xs" />
              </div>
            </div>
          </div>

          <div className="flex-1 overflow-auto">
            <table className="w-full border-collapse text-sm">
              <thead className="sticky top-0 z-10 bg-muted/80 backdrop-blur-sm">
                <tr>
                  <th className="border-b border-r px-3 py-2 text-left text-xs font-semibold text-muted-foreground">Field</th>
                  <th className="border-b border-r px-3 py-2 text-left text-xs font-semibold text-muted-foreground w-20">Type</th>
                  <th className="border-b border-r px-3 py-2 text-right text-xs font-semibold text-muted-foreground w-28">Populated</th>
                  <th className="border-b border-r px-3 py-2 text-left text-xs font-semibold text-muted-foreground w-48">Rate</th>
                  <th className="border-b px-3 py-2 text-left text-xs font-semibold text-muted-foreground">Recommendation</th>
                </tr>
              </thead>
              <tbody>
                {filteredFields.map((f) => {
                  const rec = fieldRecommendation(f);
                  return (
                    <tr key={f.name} className={cn("border-b hover:bg-muted/20", f.population_pct === 0 && "bg-destructive/5", f.population_pct > 0 && f.population_pct < 5 && "bg-amber-50 dark:bg-amber-950/20")}>
                      <td className="border-r px-3 py-1.5">
                        <span className="text-xs font-medium">{f.label}</span>
                        <span className="ml-1.5 text-xs text-muted-foreground/60">{f.name}</span>
                      </td>
                      <td className="border-r px-3 py-1.5 text-xs text-muted-foreground">{f.field_type}</td>
                      <td className="border-r px-3 py-1.5 text-right text-xs tabular-nums">
                        {f.populated_count.toLocaleString()} <span className="text-muted-foreground/60">/ {f.sample_size.toLocaleString()}</span>
                      </td>
                      <td className="border-r px-3 py-1.5">
                        <div className="flex items-center gap-2">
                          <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
                            <div className={cn("h-full rounded-full", f.population_pct === 0 ? "bg-destructive" : f.population_pct < 5 ? "bg-amber-500" : f.population_pct < 50 ? "bg-blue-500" : "bg-emerald-500")} style={{ width: `${Math.max(f.population_pct, 0.5)}%` }} />
                          </div>
                          <span className={cn("w-12 text-right text-xs font-medium tabular-nums", f.population_pct === 0 ? "text-destructive" : f.population_pct < 5 ? "text-amber-600 dark:text-amber-400" : "text-muted-foreground")}>{f.population_pct}%</span>
                        </div>
                      </td>
                      <td className="px-3 py-1.5 text-xs">
                        {rec ? (
                          <span className="flex items-center gap-1 text-amber-700 dark:text-amber-400"><AlertTriangle className="h-3 w-3 shrink-0" />{rec}</span>
                        ) : f.population_pct >= 50 ? (
                          <span className="flex items-center gap-1 text-emerald-700 dark:text-emerald-400"><CheckCircle2 className="h-3 w-3 shrink-0" />Well-used</span>
                        ) : null}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}

function fieldRecommendation(f: FieldPopulationInfo): string | null {
  if (!f.updateable) return null;
  if (f.population_pct === 0) return "Completely empty — strong candidate for removal";
  if (f.population_pct < 1) return "Almost unused — review whether this field is still needed";
  if (f.population_pct < 5) return "Very low usage — consider merging or deprecating";
  return null;
}

// ── Duplicate Detection Tab ──────────────────────────────────────────────────

function DuplicateDetectionTab() {
  const picker = useObjectPicker();
  const [fieldName, setFieldName] = useState("Name");
  const [result, setResult] = useState<DuplicateAnalysisResult | null>(null);

  // Get fields for the field picker
  const { data: describe } = useDescribeObject(
    picker.connectionId || null,
    picker.objectName || null
  );
  const textFields = useMemo(
    () =>
      (describe?.fields ?? [])
        .filter((f) => ["string", "email", "phone", "url", "textarea", "picklist"].includes(f.field_type))
        .sort((a, b) => a.label.localeCompare(b.label)),
    [describe]
  );

  const scan = useMutation({
    mutationFn: detectDuplicates,
    onSuccess: (data) => setResult(data),
    onError: (err: unknown) => toast.error(`Duplicate scan failed: ${errMsg(err)}`),
  });

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <div className="flex items-end gap-3 border-b px-6 py-3">
        <ObjectPickerUI picker={picker} onObjectChange={() => { setResult(null); setFieldName("Name"); }} />
        <div className="space-y-1">
          <label className="text-xs font-medium text-muted-foreground">Check field</label>
          <select
            className="h-8 rounded-md border bg-background px-2 text-xs"
            value={fieldName}
            onChange={(e) => { setFieldName(e.target.value); setResult(null); }}
          >
            {textFields.length === 0 && <option value="Name">Name</option>}
            {textFields.map((f) => (
              <option key={f.name} value={f.name}>{f.label}</option>
            ))}
          </select>
        </div>
        <Button
          onClick={() => picker.objectName && picker.connectionId && scan.mutate({ connection_id: picker.connectionId, object_name: picker.objectName, field_name: fieldName })}
          disabled={!picker.objectName || !fieldName || scan.isPending}
        >
          {scan.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Copy className="h-4 w-4" />}
          Scan for duplicates
        </Button>
      </div>

      {!result && !scan.isPending && (
        <div className="flex flex-1 items-center justify-center">
          <div className="text-center">
            <Copy className="mx-auto h-8 w-8 text-muted-foreground/40" />
            <p className="mt-3 text-sm text-muted-foreground">Pick an object and field, then scan to find duplicate values</p>
          </div>
        </div>
      )}

      {scan.isPending && (
        <div className="flex flex-1 items-center justify-center gap-2">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          <span className="text-sm text-muted-foreground">Scanning for duplicates…</span>
        </div>
      )}

      {result && (
        <>
          <div className="border-b bg-muted/30 px-6 py-3">
            <p className="text-sm">
              {result.total_duplicates === 0 ? (
                <span className="flex items-center gap-1.5 text-emerald-700 dark:text-emerald-400">
                  <CheckCircle2 className="h-4 w-4" />
                  No duplicates found in {result.field_label}
                </span>
              ) : (
                <>
                  <span className="font-semibold text-amber-700 dark:text-amber-400">{result.total_duplicates}</span>
                  {" "}duplicate value{result.total_duplicates === 1 ? "" : "s"} found in{" "}
                  <span className="font-medium">{result.field_label}</span>
                  {" "}affecting{" "}
                  <span className="font-semibold">{result.total_affected_records.toLocaleString()}</span> records
                </>
              )}
            </p>
          </div>

          {result.groups.length > 0 && (
            <div className="flex-1 overflow-auto">
              <table className="w-full border-collapse text-sm">
                <thead className="sticky top-0 z-10 bg-muted/80 backdrop-blur-sm">
                  <tr>
                    <th className="border-b border-r px-3 py-2 text-left text-xs font-semibold text-muted-foreground">{result.field_label} value</th>
                    <th className="border-b px-3 py-2 text-right text-xs font-semibold text-muted-foreground w-32">Records</th>
                  </tr>
                </thead>
                <tbody>
                  {result.groups.map((g) => (
                    <tr key={g.value} className="border-b hover:bg-muted/20">
                      <td className="border-r px-3 py-1.5 text-xs">{g.value}</td>
                      <td className="px-3 py-1.5 text-right">
                        <span className={cn("inline-flex items-center rounded-full px-2 py-0.5 text-xs font-semibold tabular-nums", g.count >= 5 ? "bg-destructive/10 text-destructive" : "bg-amber-50 text-amber-700 dark:bg-amber-950 dark:text-amber-300")}>
                          {g.count}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </div>
  );
}

// ── Ownership Distribution Tab ───────────────────────────────────────────────

function OwnershipTab() {
  const picker = useObjectPicker();
  const [result, setResult] = useState<OwnershipResult | null>(null);

  const analyse = useMutation({
    mutationFn: analyseRecordOwnership,
    onSuccess: (data) => setResult(data),
    onError: (err: unknown) => toast.error(`Ownership analysis failed: ${errMsg(err)}`),
  });

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <div className="flex items-end gap-3 border-b px-6 py-3">
        <ObjectPickerUI picker={picker} onObjectChange={() => setResult(null)} />
        <Button
          onClick={() => picker.objectName && picker.connectionId && analyse.mutate({ connection_id: picker.connectionId, object_name: picker.objectName })}
          disabled={!picker.objectName || analyse.isPending}
        >
          {analyse.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Users className="h-4 w-4" />}
          Analyse ownership
        </Button>
      </div>

      {!result && !analyse.isPending && (
        <div className="flex flex-1 items-center justify-center">
          <div className="text-center">
            <Users className="mx-auto h-8 w-8 text-muted-foreground/40" />
            <p className="mt-3 text-sm text-muted-foreground">Pick an object to see how records are distributed across owners</p>
          </div>
        </div>
      )}

      {analyse.isPending && (
        <div className="flex flex-1 items-center justify-center gap-2">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          <span className="text-sm text-muted-foreground">Analysing ownership…</span>
        </div>
      )}

      {result && (
        <>
          <div className="border-b bg-muted/30 px-6 py-3">
            <p className="text-sm text-muted-foreground">
              <span className="font-semibold text-foreground">{result.total_records.toLocaleString()}</span>{" "}
              total {result.object_name} records across{" "}
              <span className="font-semibold text-foreground">{result.owners.length}</span> owner{result.owners.length === 1 ? "" : "s"}
            </p>
          </div>

          <div className="flex-1 overflow-auto">
            <table className="w-full border-collapse text-sm">
              <thead className="sticky top-0 z-10 bg-muted/80 backdrop-blur-sm">
                <tr>
                  <th className="border-b border-r px-3 py-2 text-left text-xs font-semibold text-muted-foreground">Owner</th>
                  <th className="border-b border-r px-3 py-2 text-right text-xs font-semibold text-muted-foreground w-28">Records</th>
                  <th className="border-b px-3 py-2 text-left text-xs font-semibold text-muted-foreground w-56">Share</th>
                </tr>
              </thead>
              <tbody>
                {result.owners.map((o) => {
                  const pct = result.total_records > 0
                    ? Math.round((o.record_count / result.total_records) * 1000) / 10
                    : 0;
                  return (
                    <tr key={o.owner_id} className="border-b hover:bg-muted/20">
                      <td className="border-r px-3 py-1.5">
                        <span className="text-xs font-medium">{o.owner_name}</span>
                        <span className="ml-1.5 text-xs text-muted-foreground/60">{o.owner_id.slice(0, 15)}</span>
                      </td>
                      <td className="border-r px-3 py-1.5 text-right text-xs font-medium tabular-nums">
                        {o.record_count.toLocaleString()}
                      </td>
                      <td className="px-3 py-1.5">
                        <div className="flex items-center gap-2">
                          <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
                            <div className="h-full rounded-full bg-primary" style={{ width: `${Math.max(pct, 0.5)}%` }} />
                          </div>
                          <span className="w-12 text-right text-xs tabular-nums text-muted-foreground">{pct}%</span>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}

// ── Shared chip ──────────────────────────────────────────────────────────────

function SmallChip({ active, onClick, label, count }: { active: boolean; onClick: () => void; label: string; count: number }) {
  return (
    <button onClick={onClick} className={cn("inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium transition-colors", active ? "border-primary bg-primary text-primary-foreground" : "border-border text-muted-foreground hover:bg-accent")}>
      {label} <span className={cn("tabular-nums", active ? "text-primary-foreground/80" : "text-muted-foreground/60")}>{count}</span>
    </button>
  );
}
