import { useState } from "react";
import { ShieldCheck, ShieldAlert, ShieldOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import { deactivateLicense } from "@/lib/tauri-commands";
import { toast } from "sonner";
import type { LicenseInfo } from "@/lib/tauri-commands";

interface Props {
  license: LicenseInfo | null;
  onDeactivated: () => void;
}

export default function LicenseStatus({ license, onDeactivated }: Props) {
  const [loading, setLoading] = useState(false);

  const handleDeactivate = async () => {
    setLoading(true);
    try {
      await deactivateLicense();
      toast.success("License deactivated");
      onDeactivated();
    } catch (e: unknown) {
      const err = e as { message?: string };
      toast.error(`Failed to deactivate: ${err.message ?? String(e)}`);
    } finally {
      setLoading(false);
    }
  };

  if (!license) return null;

  const isActive = license.status === "valid" || license.status === "trial";

  return (
    <div className="flex items-center gap-3 rounded-lg border p-3">
      {isActive ? (
        <ShieldCheck className="h-5 w-5 text-green-600 shrink-0" />
      ) : license.status === "expired" ? (
        <ShieldOff className="h-5 w-5 text-yellow-500 shrink-0" />
      ) : (
        <ShieldAlert className="h-5 w-5 text-destructive shrink-0" />
      )}

      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium capitalize">
          {license.status.replace("_", " ")}
          {license.status === "trial" ? " (Trial)" : ""}
        </p>
        {license.expiry && (
          <p className="text-xs text-muted-foreground">
            Expires: {new Date(license.expiry).toLocaleDateString()}
          </p>
        )}
        {license.machine_limit && (
          <p className="text-xs text-muted-foreground">
            Seats: {license.machine_count ?? "?"} / {license.machine_limit}
          </p>
        )}
      </div>

      <Button
        size="sm"
        variant="ghost"
        className="text-muted-foreground text-xs shrink-0"
        onClick={handleDeactivate}
        disabled={loading}
      >
        Deactivate
      </Button>
    </div>
  );
}
