import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  activateLicense,
  checkLicenseStatus,
  deactivateLicense,
  getMachineFingerprint,
  hasStoredLicense,
} from "@/lib/tauri-commands";
import { errMsg } from "@/hooks/useQueries";

export const LICENSE_KEY = ["license"] as const;

const ACCOUNT_ID = import.meta.env.VITE_KEYGEN_ACCOUNT_ID ?? "";
const PRODUCT_ID = import.meta.env.VITE_KEYGEN_PRODUCT_ID ?? "";
const SKIP_LICENSE = import.meta.env.VITE_SKIP_LICENSE === "true";

/** Checks the current license status. Skipped entirely in dev/skip mode. */
export function useLicenseStatus() {
  return useQuery({
    queryKey: LICENSE_KEY,
    queryFn: async () => {
      if (!ACCOUNT_ID || !PRODUCT_ID) {
        return null;
      }
      const stored = await hasStoredLicense();
      if (!stored) return null;
      return checkLicenseStatus({
        account_id: ACCOUNT_ID,
        product_id: PRODUCT_ID,
      });
    },
    enabled: !SKIP_LICENSE,
    staleTime: 60 * 60 * 1000, // 1 hour — avoid hammering Keygen on navigation
  });
}

/** Whether the current licence includes the Sales Accelerator tier. Always true in dev
 *  (skip mode) so the feature is available without a licence during development. */
export function useSalesAccelerator(): boolean {
  const license = useLicenseStatus();
  if (SKIP_LICENSE) return true;
  return license.data?.sales_accelerator ?? false;
}

export function useMachineFingerprint() {
  return useQuery({
    queryKey: ["machine_fingerprint"],
    queryFn: getMachineFingerprint,
    staleTime: Infinity,
  });
}

export function useActivateLicense() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: activateLicense,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: LICENSE_KEY });
    },
    onError: (err: unknown) => {
      toast.error(`Activation failed: ${errMsg(err)}`);
    },
  });
}

export function useDeactivateLicense() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: deactivateLicense,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: LICENSE_KEY });
      toast.success("License deactivated on this machine");
    },
    onError: (err: unknown) => {
      toast.error(`Deactivation failed: ${errMsg(err)}`);
    },
  });
}
