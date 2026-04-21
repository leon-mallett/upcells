import { useEffect, useState } from "react";
import { Toaster } from "sonner";
import { hasStoredLicense } from "@/lib/tauri-commands";
import LicensePage from "@/pages/LicensePage";
import MainApp from "@/pages/MainApp";

const SKIP_LICENSE = import.meta.env.VITE_SKIP_LICENSE === "true";

type AppState = "loading" | "license-required" | "ready";

export default function App() {
  const [appState, setAppState] = useState<AppState>("loading");

  useEffect(() => {
    if (SKIP_LICENSE) {
      setAppState("ready");
      return;
    }

    hasStoredLicense()
      .then((hasLicense) => {
        setAppState(hasLicense ? "ready" : "license-required");
      })
      .catch(() => setAppState("license-required"));
  }, []);

  return (
    <>
      <Toaster position="bottom-right" richColors />
      {appState === "loading" && (
        <div className="flex h-screen items-center justify-center bg-background">
          <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
        </div>
      )}
      {appState === "license-required" && (
        <LicensePage onActivated={() => setAppState("ready")} />
      )}
      {appState === "ready" && <MainApp />}
    </>
  );
}
