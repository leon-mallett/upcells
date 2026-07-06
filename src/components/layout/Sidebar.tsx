import { Link } from "@tanstack/react-router";
import {
  Database,
  Upload,
  History,
  Settings,
  LayoutDashboard,
  ShieldCheck,
  Sparkles,
} from "lucide-react";
import UpcellsLogo from "@/components/layout/UpcellsLogo";
import { cn } from "@/lib/utils";
import { useConnectionStore } from "@/stores/connectionStore";
import { useAdminStore } from "@/stores/adminStore";
import { useSalesAccelerator } from "@/hooks/useLicense";

// ── Sidebar ───────────────────────────────────────────────────────────────────

export default function Sidebar() {
  const connections = useConnectionStore((s) => s.connections);
  const connectedCount = connections.filter((c) => c.status === "connected").length;
  const expiredCount = connections.filter((c) => c.status === "error").length;
  const adminEnabled = useAdminStore((s) => s.enabled);
  const salesAccelerator = useSalesAccelerator();

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

          {/* Sales Data */}
          <Link
            to="/data"
            search={{}}
            className={cn(
              "flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground",
              "[&.active]:bg-accent [&.active]:text-accent-foreground"
            )}
          >
            <Database className="h-4 w-4 shrink-0" />
            Sales Data
          </Link>

          {/* Update CRM */}
          <SimpleNavLink to="/update" icon={Upload} label="Update CRM" />

          {/* Sales Accelerator (local AI) — only for licences with the tier */}
          {salesAccelerator && (
            <SimpleNavLink to="/assistant" icon={Sparkles} label="Assistant" />
          )}

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
