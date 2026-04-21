import { Link } from "@tanstack/react-router";
import { CheckCircle2, Circle, ArrowRight, X, Sparkles } from "lucide-react";
import { cn } from "@/lib/utils";

export interface Milestone {
  id: string;
  label: string;
  done: boolean;
  /** Route to take the user when they click the item (incomplete only). */
  href: string;
  /** Optional hint shown under the label — e.g. "Takes ~5 minutes" */
  hint?: string;
}

export default function GettingStartedCard({
  milestones,
  onDismiss,
}: {
  milestones: Milestone[];
  onDismiss: () => void;
}) {
  const doneCount = milestones.filter((m) => m.done).length;
  const total = milestones.length;

  return (
    <div className="rounded-lg border border-primary/20 bg-primary/[0.03] p-5">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-start gap-3">
          <div className="rounded-md bg-primary/10 p-2 text-primary">
            <Sparkles className="h-5 w-5" />
          </div>
          <div>
            <p className="font-semibold">Getting started</p>
            <p className="mt-0.5 text-sm text-muted-foreground">
              {doneCount} of {total} complete — work through these to get
              comfortable with Upcells
            </p>
          </div>
        </div>
        <button
          onClick={onDismiss}
          aria-label="Dismiss getting started"
          className="rounded-md p-1 text-muted-foreground/60 transition-colors hover:bg-accent hover:text-foreground"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      {/* Progress bar */}
      <div className="mt-3 h-1 overflow-hidden rounded-full bg-muted">
        <div
          className="h-full bg-primary transition-all duration-300"
          style={{ width: `${(doneCount / total) * 100}%` }}
        />
      </div>

      {/* Checklist */}
      <ul className="mt-4 space-y-1">
        {milestones.map((m) => (
          <MilestoneRow key={m.id} milestone={m} />
        ))}
      </ul>
    </div>
  );
}

function MilestoneRow({ milestone }: { milestone: Milestone }) {
  const Icon = milestone.done ? CheckCircle2 : Circle;

  const body = (
    <div
      className={cn(
        "flex items-center gap-3 rounded-md px-2 py-1.5",
        !milestone.done && "hover:bg-accent/40 cursor-pointer group"
      )}
    >
      <Icon
        className={cn(
          "h-4 w-4 shrink-0",
          milestone.done
            ? "text-emerald-600 dark:text-emerald-400"
            : "text-muted-foreground/40"
        )}
      />
      <div className="min-w-0 flex-1">
        <p
          className={cn(
            "text-sm",
            milestone.done
              ? "text-muted-foreground line-through decoration-muted-foreground/30"
              : "font-medium"
          )}
        >
          {milestone.label}
        </p>
        {!milestone.done && milestone.hint && (
          <p className="text-xs text-muted-foreground">{milestone.hint}</p>
        )}
      </div>
      {!milestone.done && (
        <ArrowRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground/40 transition-transform group-hover:translate-x-0.5 group-hover:text-foreground" />
      )}
    </div>
  );

  if (milestone.done) {
    return <li>{body}</li>;
  }

  return (
    <li>
      <Link
        to={milestone.href}
        search={milestone.href === "/data" ? {} : undefined}
        className="block"
      >
        {body}
      </Link>
    </li>
  );
}
