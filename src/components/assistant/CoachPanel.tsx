import { useState } from "react";
import { Loader2, Send } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { useCoach } from "@/hooks/useAssistant";
import type { CoachTurn } from "@/lib/tauri-commands";

const IDEAS = [
  "How do I handle a \"we have no budget\" objection?",
  "Help me prioritise my pipeline this week",
  "Give me a pep talk before a big call",
];

/** A freeform sales-coach chat — strategy, ideas, and motivation (no data/retrieval). */
export default function CoachPanel() {
  const coach = useCoach();
  const [message, setMessage] = useState("");
  const [turns, setTurns] = useState<CoachTurn[]>([]);

  const canSend = !!message.trim() && !coach.isPending;

  async function send(text: string) {
    const m = text.trim();
    if (!m || coach.isPending) return;
    setMessage("");
    const history = turns; // prior turns (excludes this message, sent separately)
    setTurns((t) => [...t, { role: "user", content: m }]);
    const reply = await coach.mutateAsync({ message: m, history }).catch(() => null);
    setTurns((t) => [
      ...t,
      { role: "assistant", content: reply ?? "Sorry, I couldn't respond just now." },
    ]);
  }

  return (
    <div className="flex flex-1 flex-col gap-4">
      <div className="flex-1 space-y-3">
        {turns.length === 0 ? (
          <div className="space-y-3 pt-2">
            <p className="text-sm text-muted-foreground">
              Your sales coach — ask for strategy, ideas, or a boost.
            </p>
            <div className="flex flex-wrap gap-2">
              {IDEAS.map((i) => (
                <button
                  key={i}
                  onClick={() => setMessage(i)}
                  className="rounded-full border px-3 py-1.5 text-xs transition hover:bg-accent"
                >
                  {i}
                </button>
              ))}
            </div>
          </div>
        ) : (
          turns.map((t, i) => (
            <div key={i} className={cn(t.role === "user" && "flex justify-end")}>
              <div
                className={cn(
                  t.role === "user"
                    ? "max-w-[85%] rounded-2xl bg-primary px-4 py-2 text-sm text-primary-foreground"
                    : "max-w-[90%] whitespace-pre-wrap rounded-2xl border bg-muted/30 px-4 py-2 text-sm leading-relaxed",
                )}
              >
                {t.content}
              </div>
            </div>
          ))
        )}
        {coach.isPending && (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Thinking…
          </div>
        )}
      </div>

      <div className="sticky bottom-0 flex items-center gap-2 bg-background pt-2">
        {turns.length > 0 && (
          <button
            onClick={() => setTurns([])}
            className="shrink-0 text-xs text-muted-foreground hover:text-foreground"
          >
            New chat
          </button>
        )}
        <Input
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && canSend) send(message);
          }}
          placeholder="Ask your coach…"
        />
        <Button onClick={() => send(message)} disabled={!canSend}>
          {coach.isPending ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Send className="h-4 w-4" />
          )}
        </Button>
      </div>
    </div>
  );
}
