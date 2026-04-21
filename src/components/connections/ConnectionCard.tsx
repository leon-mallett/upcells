import { useState, useEffect } from "react";
import { listen } from "@tauri-apps/api/event";
import { Cable, CheckCircle, AlertCircle, Clock, Loader2, Trash2, RefreshCw, LogOut, Pencil, X, Copy, Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { Connection } from "@/lib/tauri-commands";
import { cancelOAuth } from "@/lib/tauri-commands";
import { formatDate } from "@/lib/utils";
import { useDeleteConnection, useStartOAuth, useTestConnection, useDisconnect } from "@/hooks/useConnections";
import { useUiStore } from "@/stores/uiStore";

interface Props {
  connection: Connection;
}

function StatusBadge({ status }: { status: Connection["status"] }) {
  switch (status) {
    case "connected":
      return (
        <Badge variant="success" className="gap-1">
          <CheckCircle className="h-3 w-3" />
          Connected
        </Badge>
      );
    case "error":
      return (
        <Badge variant="destructive" className="gap-1">
          <AlertCircle className="h-3 w-3" />
          Error
        </Badge>
      );
    default:
      return (
        <Badge variant="secondary" className="gap-1">
          <Clock className="h-3 w-3" />
          Untested
        </Badge>
      );
  }
}

export default function ConnectionCard({ connection }: Props) {
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [authUrl, setAuthUrl] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const openForm = useUiStore((s) => s.openConnectionForm);

  const deleteConn = useDeleteConnection();
  const startOAuth = useStartOAuth();
  const testConn = useTestConnection();
  const disconnectConn = useDisconnect();

  const isLoading =
    startOAuth.isPending || testConn.isPending || disconnectConn.isPending;

  // Register the oauth_url_ready listener once on mount so it's ready
  // before Rust emits the event (avoids a race with isPending effect timing)
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    listen<string>("oauth_url_ready", (event) => {
      setAuthUrl(event.payload);
    }).then((fn) => {
      unlisten = fn;
    });
    return () => { unlisten?.(); };
  }, []);

  // Clear the URL when the OAuth flow is no longer pending
  useEffect(() => {
    if (!startOAuth.isPending) {
      setAuthUrl(null);
    }
  }, [startOAuth.isPending]);

  const copyUrl = async () => {
    if (!authUrl) return;
    await navigator.clipboard.writeText(authUrl);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <>
      <div className="rounded-lg border bg-card p-4 shadow-sm">
        <div className="flex items-start justify-between gap-4">
          <div className="flex items-center gap-3 min-w-0">
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-primary/10">
              <Cable className="h-5 w-5 text-primary" />
            </div>
            <div className="min-w-0">
              <p className="truncate font-medium">{connection.name}</p>
              <p className="truncate text-xs text-muted-foreground">
                {connection.instance_url ?? "No URL set"}
              </p>
            </div>
          </div>
          <StatusBadge status={connection.status} />
        </div>

        {connection.username && (
          <p className="mt-2 text-xs text-muted-foreground">
            Signed in as <span className="font-medium">{connection.username}</span>
          </p>
        )}

        <p className="mt-1 text-xs text-muted-foreground">
          Last tested: {formatDate(connection.last_tested)}
        </p>

        <div className="mt-3 flex flex-wrap gap-2">
          {connection.status !== "connected" && !startOAuth.isPending && (
            <Button
              size="sm"
              onClick={() =>
                startOAuth.mutate({
                  connection_id: connection.id,
                  instance_url: connection.instance_url ?? "",
                  client_id: connection.client_id ?? "",
                })
              }
              disabled={isLoading || !connection.instance_url || !connection.client_id}
            >
              Authenticate
            </Button>
          )}

          {startOAuth.isPending && (
            <div className="w-full space-y-2">
              <div className="flex items-center gap-2">
                <Loader2 className="h-4 w-4 animate-spin text-muted-foreground shrink-0" />
                <span className="text-xs text-muted-foreground">
                  Waiting for browser login…
                </span>
                <Button
                  size="sm"
                  variant="ghost"
                  className="ml-auto h-7 px-2 text-xs text-muted-foreground"
                  onClick={async () => { await cancelOAuth().catch(() => {}); startOAuth.reset(); }}
                >
                  <X className="h-3 w-3" />
                  Cancel
                </Button>
              </div>

              {authUrl && (
                <div className="rounded-md border bg-muted/50 p-2">
                  <p className="mb-1.5 text-xs text-muted-foreground">
                    Or copy this URL into your preferred browser:
                  </p>
                  <div className="flex items-center gap-2">
                    <p className="min-w-0 flex-1 truncate font-mono text-xs selectable">
                      {authUrl}
                    </p>
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-7 shrink-0 px-2 text-xs"
                      onClick={copyUrl}
                    >
                      {copied ? (
                        <Check className="h-3 w-3 text-green-600" />
                      ) : (
                        <Copy className="h-3 w-3" />
                      )}
                      {copied ? "Copied" : "Copy"}
                    </Button>
                  </div>
                </div>
              )}
            </div>
          )}

          {connection.status === "connected" && (
            <>
              <Button
                size="sm"
                variant="outline"
                onClick={() => testConn.mutate(connection.id)}
                disabled={isLoading}
              >
                {testConn.isPending ? <Loader2 className="animate-spin" /> : <RefreshCw />}
                Test
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => disconnectConn.mutate(connection.id)}
                disabled={isLoading}
              >
                <LogOut />
                Disconnect
              </Button>
            </>
          )}

          <Button
            size="sm"
            variant="ghost"
            onClick={() => openForm(connection.id)}
          >
            <Pencil />
            Edit
          </Button>

          <Button
            size="sm"
            variant="ghost"
            className="ml-auto text-destructive hover:text-destructive"
            onClick={() => setConfirmDelete(true)}
          >
            <Trash2 />
          </Button>
        </div>
      </div>

      {/* Delete confirmation */}
      <Dialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete connection?</DialogTitle>
            <DialogDescription>
              This will permanently delete <strong>{connection.name}</strong> and
              clear all stored credentials. This action cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmDelete(false)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                deleteConn.mutate(connection.id);
                setConfirmDelete(false);
              }}
            >
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
