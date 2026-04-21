import { useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import {
  Loader2,
  ShieldCheck,
  AlertTriangle,
  Database,
  FileSpreadsheet,
  GitCompareArrows,
  Users,
  ExternalLink,
  ChevronDown,
} from "lucide-react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { licenseKeySchema, type LicenseKeyFormValues } from "@/lib/validators";
import { activateLicense } from "@/lib/tauri-commands";
import { toast } from "sonner";
import UpcellsLogo from "@/components/layout/UpcellsLogo";
import { cn } from "@/lib/utils";

const ACCOUNT_ID = import.meta.env.VITE_KEYGEN_ACCOUNT_ID ?? "";
const PRODUCT_ID = import.meta.env.VITE_KEYGEN_PRODUCT_ID ?? "";
const PURCHASE_URL = "https://upcells.app";

interface Props {
  onActivated: () => void;
}

const FEATURES = [
  {
    icon: Database,
    title: "Browse & export",
    description:
      "Query any Salesforce object, pick fields, add filters, and export to xlsx or csv",
  },
  {
    icon: FileSpreadsheet,
    title: "Edit locally",
    description:
      "Use Excel, Numbers, or any spreadsheet app — your data stays on your machine",
  },
  {
    icon: GitCompareArrows,
    title: "Safe diff preview",
    description:
      "See exactly what will change before writing anything back to Salesforce",
  },
  {
    icon: Users,
    title: "Share with your team",
    description:
      "Export saved queries as portable files for colleagues to import into their own app",
  },
];

export default function LicensePage({ onActivated }: Props) {
  const [loading, setLoading] = useState(false);
  const [showKeyInput, setShowKeyInput] = useState(false);
  const configured = !!ACCOUNT_ID && !!PRODUCT_ID;

  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<LicenseKeyFormValues>({
    resolver: zodResolver(licenseKeySchema),
  });

  const onSubmit = async (values: LicenseKeyFormValues) => {
    setLoading(true);
    try {
      await activateLicense({
        license_key: values.license_key,
        account_id: ACCOUNT_ID,
        product_id: PRODUCT_ID,
      });
      toast.success("License activated successfully");
      onActivated();
    } catch (e: unknown) {
      const err = e as { message?: string };
      toast.error(`Activation failed: ${err.message ?? String(e)}`);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex h-screen items-center justify-center bg-background p-4">
      <div className="w-full max-w-md space-y-8">
        {/* ── Hero ───────────────────────────────────────────────────── */}
        <div className="flex flex-col items-center gap-4 text-center">
          <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-primary/10">
            <UpcellsLogo className="h-10 w-10 text-primary" />
          </div>
          <div>
            <h1 className="text-2xl font-bold tracking-tight">
              Upcells <span className="text-muted-foreground font-normal">for Salesforce</span>
            </h1>
            <p className="mt-1 text-sm text-muted-foreground">
              Spreadsheet editing for your Salesforce data.
              <br />
              Export, edit, and sync — all locally.
            </p>
          </div>
        </div>

        {/* ── Feature highlights ─────────────────────────────────────── */}
        <div className="space-y-3">
          {FEATURES.map(({ icon: Icon, title, description }) => (
            <div
              key={title}
              className="flex items-start gap-3 rounded-lg border bg-card p-3"
            >
              <div className="rounded-md bg-primary/10 p-1.5 text-primary">
                <Icon className="h-4 w-4" />
              </div>
              <div className="min-w-0">
                <p className="text-sm font-medium">{title}</p>
                <p className="text-xs text-muted-foreground">{description}</p>
              </div>
            </div>
          ))}
        </div>

        {/* ── Purchase CTA ──────────────────────────────────────────── */}
        <div className="space-y-3">
          <Button
            className="w-full"
            size="lg"
            onClick={() => openUrl(PURCHASE_URL)}
          >
            <ExternalLink className="h-4 w-4" />
            Purchase a license
          </Button>

          {/* ── "I already have a key" toggle ────────────────────────── */}
          <div className="text-center">
            <button
              type="button"
              onClick={() => setShowKeyInput((v) => !v)}
              className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground transition-colors"
            >
              Already have a license key?
              <ChevronDown
                className={cn(
                  "h-3.5 w-3.5 transition-transform",
                  showKeyInput && "rotate-180"
                )}
              />
            </button>
          </div>

          {showKeyInput && (
            <div className="rounded-lg border bg-card p-4">
              {/* Dev / misconfiguration warning */}
              {!configured && (
                <div className="mb-4 rounded-md border border-amber-300 bg-amber-50 p-3 text-xs text-amber-900 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
                  <p className="flex items-start gap-2">
                    <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
                    <span>
                      <strong>Licensing not configured.</strong> Set{" "}
                      <code>VITE_KEYGEN_ACCOUNT_ID</code> and{" "}
                      <code>VITE_KEYGEN_PRODUCT_ID</code> in <code>.env</code>,
                      or use <code>VITE_SKIP_LICENSE=true</code> for
                      development.
                    </span>
                  </p>
                </div>
              )}

              <form onSubmit={handleSubmit(onSubmit)} className="space-y-3">
                <div className="space-y-1.5">
                  <Label htmlFor="license_key">License key</Label>
                  <Input
                    id="license_key"
                    placeholder="XXXX-XXXX-XXXX-XXXX"
                    className="font-mono tracking-wider"
                    {...register("license_key")}
                    autoFocus
                    disabled={!configured}
                  />
                  {errors.license_key && (
                    <p className="text-xs text-destructive">
                      {errors.license_key.message}
                    </p>
                  )}
                </div>

                <Button
                  type="submit"
                  variant="outline"
                  className="w-full"
                  disabled={loading || !configured}
                >
                  {loading ? (
                    <Loader2 className="animate-spin" />
                  ) : (
                    <ShieldCheck />
                  )}
                  Activate license
                </Button>
              </form>
            </div>
          )}
        </div>

        {/* ── Footer ────────────────────────────────────────────────── */}
        <p className="text-center text-xs text-muted-foreground/60">
          © {new Date().getFullYear()} Mallmont · Built with Tauri
        </p>
      </div>
    </div>
  );
}
