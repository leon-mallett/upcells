import { AlertTriangle, Loader2, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useStartOAuth } from "@/hooks/useConnections";
import type { Connection } from "@/lib/tauri-commands";

/**
 * Shown above the Data and Update pages when the active org's stored
 * refresh token has been rejected (status='error' in the DB). Gives the
 * user an immediate, obvious path back to working — a Reconnect button
 * that kicks off OAuth with the same credentials — instead of an opaque
 * "API failed" toast followed by hunting through Settings.
 */
export default function SessionExpiredBanner({
  connection,
}: {
  connection: Connection;
}) {
  const startOAuth = useStartOAuth();

  function handleReconnect() {
    if (!connection.instance_url || !connection.client_id) return;
    startOAuth.mutate({
      connection_id: connection.id,
      instance_url: connection.instance_url,
      client_id: connection.client_id,
    });
  }

  return (
    <div className="flex items-center gap-3 border-b bg-amber-50 px-6 py-2.5 dark:bg-amber-950/30">
      <AlertTriangle className="h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" />
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium text-amber-900 dark:text-amber-200">
          Your Salesforce session has expired
        </p>
        <p className="text-xs text-amber-800 dark:text-amber-300">
          Reconnect <span className="font-medium">{connection.name}</span> to
          continue querying and updating data.
        </p>
      </div>
      <Button
        size="sm"
        onClick={handleReconnect}
        disabled={startOAuth.isPending}
      >
        {startOAuth.isPending ? (
          <Loader2 className="h-3 w-3 animate-spin" />
        ) : (
          <RefreshCw className="h-3 w-3" />
        )}
        Reconnect
      </Button>
    </div>
  );
}
