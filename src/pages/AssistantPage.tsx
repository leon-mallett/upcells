import { useEffect, useMemo, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import {
  Sparkles,
  Download,
  Database,
  Send,
  Trash2,
  Loader2,
  ChevronDown,
  ChevronRight,
  Plus,
  Cpu,
  CheckCircle2,
  Lock,
} from "lucide-react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import {
  useAiHardware,
  useAiModels,
  useAiRecommendation,
  useAskDataPool,
  useCreateDataPool,
  useDataPools,
  useDeleteDataPool,
  useDownloadAiModel,
  useLoadAiModel,
} from "@/hooks/useAssistant";
import { useSalesAccelerator } from "@/hooks/useLicense";
import type { DownloadProgress, PoolAnswer } from "@/lib/tauri-commands";

const GB = 1e9;
const MB = 1e6;

function formatBytes(n: number): string {
  if (n >= GB) return `${(n / GB).toFixed(1)} GB`;
  if (n >= MB) return `${Math.round(n / MB)} MB`;
  return `${Math.max(1, Math.round(n / 1e3))} KB`;
}

/** Mirror the Rust event-name sanitiser (dots etc. → `_`). */
function downloadEvent(id: string): string {
  return `model:download:${id.replace(/[^A-Za-z0-9_-]/g, "_")}`;
}

export default function AssistantPage() {
  const entitled = useSalesAccelerator();
  return entitled ? <AssistantFeature /> : <AssistantUpsell />;
}

function AssistantUpsell() {
  return (
    <div className="mx-auto max-w-2xl p-6">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Lock className="h-4 w-4" /> Sales Accelerator
          </CardTitle>
          <CardDescription>A premium add-on for Upcells.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3 text-sm text-muted-foreground">
          <p>
            Ask questions about your Salesforce data in plain English, with a private AI
            assistant that runs entirely on your machine — no data ever leaves your device.
          </p>
          <p>
            Your current licence doesn't include this tier. Contact us to upgrade and unlock
            the Assistant.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}

function AssistantFeature() {
  const models = useAiModels();
  const hardware = useAiHardware();
  const recommendation = useAiRecommendation();
  const pools = useDataPools();
  const createPool = useCreateDataPool();
  const deletePool = useDeleteDataPool();
  const download = useDownloadAiModel();
  const load = useLoadAiModel();
  const ask = useAskDataPool();

  const chatModels = useMemo(
    () => (models.data ?? []).filter((m) => m.kind === "chat"),
    [models.data],
  );

  const [selectedModelId, setSelectedModelId] = useState("");
  const [activeModelId, setActiveModelId] = useState<string | null>(null);
  const [downloadPct, setDownloadPct] = useState<number | null>(null);
  const [busyModel, setBusyModel] = useState(false);

  const [selectedPoolId, setSelectedPoolId] = useState<string | null>(null);
  const [question, setQuestion] = useState("");
  const [answer, setAnswer] = useState<PoolAnswer | null>(null);
  const [showSql, setShowSql] = useState(false);

  // Default the model choice to the hardware recommendation.
  useEffect(() => {
    if (!selectedModelId && recommendation.data) {
      setSelectedModelId(recommendation.data.model_id);
    }
  }, [recommendation.data, selectedModelId]);

  async function activateModel(modelId: string) {
    setBusyModel(true);
    setDownloadPct(0);
    const unlisten = await listen<DownloadProgress>(downloadEvent(modelId), (e) => {
      const { downloaded, total } = e.payload;
      setDownloadPct(total ? Math.min(100, Math.round((downloaded / total) * 100)) : null);
    });
    try {
      await download.mutateAsync(modelId);
      setDownloadPct(null);
      await load.mutateAsync(modelId);
      setActiveModelId(modelId);
      toast.success("AI model ready");
    } catch {
      // errors are surfaced by the hooks
    } finally {
      unlisten();
      setDownloadPct(null);
      setBusyModel(false);
    }
  }

  async function importPool() {
    const path = await openDialog({
      filters: [{ name: "Spreadsheet", extensions: ["csv", "xlsx", "xls"] }],
    });
    if (!path || typeof path !== "string") return;
    const base = path.split(/[\\/]/).pop()?.replace(/\.[^.]+$/, "") || "Data pool";
    const pool = await createPool.mutateAsync({ name: base, file_path: path }).catch(() => null);
    if (pool) setSelectedPoolId(pool.id);
  }

  async function onAsk() {
    if (!selectedPoolId || !question.trim()) return;
    setAnswer(null);
    const res = await ask
      .mutateAsync({ pool_id: selectedPoolId, question: question.trim() })
      .catch(() => null);
    if (res) {
      setAnswer(res);
      setShowSql(false);
    }
  }

  const activePool = pools.data?.find((p) => p.id === selectedPoolId);
  const canAsk = !!activeModelId && !!selectedPoolId && !!question.trim() && !ask.isPending;

  return (
    <div className="mx-auto max-w-4xl space-y-6 p-6">
      <header>
        <h1 className="flex items-center gap-2 text-2xl font-bold tracking-tight">
          <Sparkles className="h-6 w-6 text-primary" /> Sales Accelerator
        </h1>
        <p className="text-sm text-muted-foreground">
          Ask questions about your Salesforce data in plain English — runs 100% on your
          machine, nothing leaves your device.
        </p>
      </header>

      {/* ── AI model ─────────────────────────────────────────────────────── */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <Cpu className="h-4 w-4" /> AI model
          </CardTitle>
          <CardDescription>
            {hardware.data
              ? `${hardware.data.cpu_brand} · ${formatBytes(hardware.data.total_ram_bytes)} RAM · ${formatBytes(hardware.data.free_disk_bytes)} free`
              : "Detecting hardware…"}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {recommendation.data && (
            <p className="text-sm text-muted-foreground">{recommendation.data.rationale}</p>
          )}
          <div className="flex flex-wrap gap-2">
            {chatModels.map((m) => (
              <button
                key={m.id}
                onClick={() => setSelectedModelId(m.id)}
                className={cn(
                  "rounded-lg border px-3 py-2 text-left text-sm transition",
                  selectedModelId === m.id ? "border-primary bg-primary/5" : "hover:bg-accent",
                )}
              >
                <div className="flex items-center gap-1.5 font-medium">
                  {m.display_name}
                  {recommendation.data?.model_id === m.id && (
                    <Badge variant="secondary" className="text-[10px]">
                      Recommended
                    </Badge>
                  )}
                  {activeModelId === m.id && (
                    <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500" />
                  )}
                </div>
                <div className="text-xs text-muted-foreground">
                  {m.parameters} · {formatBytes(m.approximate_size_bytes)} · {m.licence}
                </div>
              </button>
            ))}
          </div>
          <div className="flex items-center gap-3">
            <Button
              onClick={() => selectedModelId && activateModel(selectedModelId)}
              disabled={busyModel || !selectedModelId}
            >
              {busyModel ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  {downloadPct !== null ? `Downloading ${downloadPct}%` : "Preparing…"}
                </>
              ) : activeModelId === selectedModelId ? (
                <>
                  <CheckCircle2 className="mr-2 h-4 w-4" /> Active
                </>
              ) : (
                <>
                  <Download className="mr-2 h-4 w-4" /> Download &amp; activate
                </>
              )}
            </Button>
            {activeModelId && (
              <span className="text-xs text-muted-foreground">Model ready — ask away below.</span>
            )}
          </div>
          {downloadPct !== null && (
            <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
              <div
                className="h-full bg-primary transition-all"
                style={{ width: `${downloadPct}%` }}
              />
            </div>
          )}
        </CardContent>
      </Card>

      {/* ── Data pools ───────────────────────────────────────────────────── */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between pb-3">
          <div>
            <CardTitle className="flex items-center gap-2 text-base">
              <Database className="h-4 w-4" /> Data pools
            </CardTitle>
            <CardDescription>Import a CSV or Excel export to query it.</CardDescription>
          </div>
          <Button size="sm" variant="outline" onClick={importPool} disabled={createPool.isPending}>
            {createPool.isPending ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <Plus className="mr-2 h-4 w-4" />
            )}
            Import file
          </Button>
        </CardHeader>
        <CardContent>
          {pools.data && pools.data.length > 0 ? (
            <div className="space-y-1.5">
              {pools.data.map((p) => (
                <div
                  key={p.id}
                  className={cn(
                    "flex items-center justify-between rounded-lg border px-3 py-2",
                    selectedPoolId === p.id && "border-primary bg-primary/5",
                  )}
                >
                  <button className="flex-1 text-left" onClick={() => setSelectedPoolId(p.id)}>
                    <div className="text-sm font-medium">{p.name}</div>
                    <div className="text-xs text-muted-foreground">
                      {p.row_count.toLocaleString()} rows · {p.columns.length} columns
                    </div>
                  </button>
                  <Button
                    size="icon"
                    variant="ghost"
                    onClick={() => {
                      deletePool.mutate(p.id);
                      if (selectedPoolId === p.id) setSelectedPoolId(null);
                    }}
                  >
                    <Trash2 className="h-4 w-4 text-muted-foreground" />
                  </Button>
                </div>
              ))}
            </div>
          ) : (
            <p className="py-6 text-center text-sm text-muted-foreground">
              No data pools yet. Import a CSV/Excel file to get started.
            </p>
          )}
        </CardContent>
      </Card>

      {/* ── Ask ──────────────────────────────────────────────────────────── */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Ask your data</CardTitle>
          <CardDescription>
            {!activeModelId
              ? "Activate a model above first."
              : !selectedPoolId
                ? "Select a data pool above."
                : `Querying "${activePool?.name}".`}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex gap-2">
            <Input
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && canAsk) onAsk();
              }}
              placeholder="e.g. What are my top 3 largest opportunities in the UK?"
              disabled={!activeModelId || !selectedPoolId}
            />
            <Button onClick={onAsk} disabled={!canAsk}>
              {ask.isPending ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Send className="h-4 w-4" />
              )}
            </Button>
          </div>

          {answer && (
            <div className="space-y-3">
              <div className="rounded-lg border bg-muted/30 p-4 text-sm leading-relaxed">
                {answer.answer}
              </div>
              <button
                className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
                onClick={() => setShowSql((s) => !s)}
              >
                {showSql ? (
                  <ChevronDown className="h-3.5 w-3.5" />
                ) : (
                  <ChevronRight className="h-3.5 w-3.5" />
                )}
                Show the query &amp; data behind this answer
              </button>
              {showSql && (
                <div className="space-y-2">
                  <pre className="overflow-x-auto rounded-lg bg-muted p-3 text-xs">
                    <code>{answer.sql}</code>
                  </pre>
                  <ResultTable
                    columns={answer.columns}
                    rows={answer.rows}
                    truncated={answer.truncated}
                  />
                </div>
              )}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function ResultTable({
  columns,
  rows,
  truncated,
}: {
  columns: string[];
  rows: string[][];
  truncated: boolean;
}) {
  if (rows.length === 0) {
    return <p className="text-xs text-muted-foreground">No rows returned.</p>;
  }
  const shown = rows.slice(0, 100);
  return (
    <div className="overflow-x-auto rounded-lg border">
      <table className="w-full text-xs">
        <thead className="bg-muted/50">
          <tr>
            {columns.map((c) => (
              <th key={c} className="px-3 py-1.5 text-left font-medium">
                {c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {shown.map((r, i) => (
            <tr key={i} className="border-t">
              {r.map((cell, j) => (
                <td key={j} className="px-3 py-1.5">
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {(truncated || rows.length > shown.length) && (
        <div className="border-t px-3 py-1.5 text-[11px] text-muted-foreground">
          Showing first {shown.length} rows{truncated ? " (result truncated at 1000)" : ""}.
        </div>
      )}
    </div>
  );
}
