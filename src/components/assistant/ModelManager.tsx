import { useEffect, useMemo, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { Cpu, Download, Loader2, CheckCircle2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import {
  useActiveAiModel,
  useAiHardware,
  useAiModels,
  useAiRecommendation,
  useDownloadAiModel,
  useLoadAiModel,
} from "@/hooks/useAssistant";
import type { DownloadProgress } from "@/lib/tauri-commands";

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

/** Hardware-aware model manager — recommend, download (with progress), and activate a local
 *  model. Lives in Settings; the active model is shared app-wide so the Assistant can use it. */
export default function ModelManager() {
  const models = useAiModels();
  const hardware = useAiHardware();
  const recommendation = useAiRecommendation();
  const activeModel = useActiveAiModel();
  const download = useDownloadAiModel();
  const load = useLoadAiModel();

  const chatModels = useMemo(
    () => (models.data ?? []).filter((m) => m.kind === "chat"),
    [models.data],
  );

  const [selectedModelId, setSelectedModelId] = useState("");
  const [downloadPct, setDownloadPct] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);

  const activeModelId = activeModel.data ?? null;

  useEffect(() => {
    if (!selectedModelId && recommendation.data) {
      setSelectedModelId(recommendation.data.model_id);
    }
  }, [recommendation.data, selectedModelId]);

  async function activate(modelId: string) {
    setBusy(true);
    setDownloadPct(0);
    const unlisten = await listen<DownloadProgress>(downloadEvent(modelId), (e) => {
      const { downloaded, total } = e.payload;
      setDownloadPct(total ? Math.min(100, Math.round((downloaded / total) * 100)) : null);
    });
    try {
      await download.mutateAsync(modelId);
      setDownloadPct(null);
      await load.mutateAsync(modelId);
      toast.success("AI model ready");
    } catch {
      // errors surfaced by the hooks
    } finally {
      unlisten();
      setDownloadPct(null);
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3">
      <p className="text-xs text-muted-foreground">
        {hardware.data
          ? `${hardware.data.cpu_brand} · ${formatBytes(hardware.data.total_ram_bytes)} RAM · ${formatBytes(hardware.data.free_disk_bytes)} free`
          : "Detecting hardware…"}
      </p>
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
          onClick={() => selectedModelId && activate(selectedModelId)}
          disabled={busy || !selectedModelId || activeModelId === selectedModelId}
        >
          {busy ? (
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
          <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <Cpu className="h-3.5 w-3.5" /> Active model ready for the Assistant.
          </span>
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
    </div>
  );
}
