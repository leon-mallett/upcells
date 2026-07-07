import { useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { FileText, Globe, Plus, Trash2, Loader2, Send } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  useAddKnowledgeFile,
  useAddKnowledgeUrl,
  useDeleteKnowledgeSource,
  useKnowledgeSources,
  useWriteProspecting,
} from "@/hooks/useAssistant";
import type { ProspectingResult } from "@/lib/tauri-commands";

/** Prospecting: manage source material (files/URLs) and draft grounded outreach with citations. */
export default function ProspectingPanel() {
  const sources = useKnowledgeSources();
  const addFile = useAddKnowledgeFile();
  const addUrl = useAddKnowledgeUrl();
  const del = useDeleteKnowledgeSource();
  const write = useWriteProspecting();

  const [urlInput, setUrlInput] = useState("");
  const [showUrl, setShowUrl] = useState(false);
  const [brief, setBrief] = useState("");
  const [result, setResult] = useState<ProspectingResult | null>(null);

  const sourceList = sources.data ?? [];
  const busyIngest = addFile.isPending || addUrl.isPending;
  const canGenerate = sourceList.length > 0 && !!brief.trim() && !write.isPending;

  async function pickFile() {
    const path = await openDialog({
      filters: [{ name: "Document", extensions: ["pdf", "docx", "txt", "md"] }],
    });
    if (path && typeof path === "string") addFile.mutate(path);
  }

  function submitUrl() {
    const u = urlInput.trim();
    if (!u) return;
    addUrl.mutate(u, {
      onSuccess: () => {
        setUrlInput("");
        setShowUrl(false);
      },
    });
  }

  async function generate() {
    const b = brief.trim();
    if (!b || !canGenerate) return;
    setResult(null);
    const r = await write.mutateAsync(b).catch(() => null);
    if (r) setResult(r);
  }

  return (
    <div className="space-y-5">
      {/* Source material */}
      <section className="space-y-2">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-sm font-semibold">Source material</h2>
            <p className="text-xs text-muted-foreground">
              Your product/brand docs and pages — drafts are grounded in these.
            </p>
          </div>
          <div className="flex gap-1.5">
            <Button size="sm" variant="outline" onClick={pickFile} disabled={busyIngest}>
              {addFile.isPending ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <Plus className="mr-2 h-4 w-4" />
              )}
              Add file
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => setShowUrl((v) => !v)}
              disabled={busyIngest}
            >
              <Globe className="mr-2 h-4 w-4" />
              Add URL
            </Button>
          </div>
        </div>

        {showUrl && (
          <div className="flex gap-2">
            <Input
              value={urlInput}
              onChange={(e) => setUrlInput(e.target.value)}
              placeholder="https://your-product-page.com"
              onKeyDown={(e) => {
                if (e.key === "Enter") submitUrl();
              }}
            />
            <Button size="sm" onClick={submitUrl} disabled={addUrl.isPending || !urlInput.trim()}>
              {addUrl.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : "Add"}
            </Button>
          </div>
        )}

        {busyIngest && (
          <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <Loader2 className="h-3 w-3 animate-spin" />
            Indexing… (the first time also downloads a small embedding model)
          </p>
        )}

        {sourceList.length === 0 ? (
          <p className="rounded-lg border border-dashed px-4 py-6 text-center text-sm text-muted-foreground">
            Add your product/brand material (PDF, Word, text, or a web page) to get started.
          </p>
        ) : (
          <div className="space-y-1.5">
            {sourceList.map((s) => (
              <div
                key={s.id}
                className="flex items-center justify-between rounded-lg border px-3 py-2"
              >
                <div className="flex min-w-0 items-center gap-2">
                  {s.kind === "url" ? (
                    <Globe className="h-4 w-4 shrink-0 text-muted-foreground" />
                  ) : (
                    <FileText className="h-4 w-4 shrink-0 text-muted-foreground" />
                  )}
                  <span className="truncate text-sm">{s.name}</span>
                  <span className="shrink-0 text-xs text-muted-foreground">
                    · {s.chunk_count} chunks
                  </span>
                </div>
                <Button size="icon" variant="ghost" onClick={() => del.mutate(s.id)}>
                  <Trash2 className="h-4 w-4 text-muted-foreground" />
                </Button>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* Brief */}
      <section className="space-y-2">
        <h2 className="text-sm font-semibold">What should I write?</h2>
        <div className="flex gap-2">
          <Input
            value={brief}
            onChange={(e) => setBrief(e.target.value)}
            placeholder="e.g. a short intro email to a fintech CFO"
            onKeyDown={(e) => {
              if (e.key === "Enter" && canGenerate) generate();
            }}
            disabled={sourceList.length === 0}
          />
          <Button onClick={generate} disabled={!canGenerate}>
            {write.isPending ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Send className="h-4 w-4" />
            )}
          </Button>
        </div>
      </section>

      {/* Draft */}
      {result && (
        <section className="space-y-3 rounded-2xl border bg-muted/30 p-4">
          <div className="whitespace-pre-wrap text-sm leading-relaxed">{result.content}</div>
          {result.citations.length > 0 && (
            <div className="space-y-1.5 border-t pt-3">
              <p className="text-xs font-semibold text-muted-foreground">Sources</p>
              {result.citations.map((c, i) => (
                <div key={i} className="text-xs text-muted-foreground">
                  <span className="font-medium text-foreground">
                    [{i + 1}] {c.source_name}
                  </span>{" "}
                  — {c.snippet}
                </div>
              ))}
            </div>
          )}
        </section>
      )}
    </div>
  );
}
