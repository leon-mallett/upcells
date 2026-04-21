import { useEffect, useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import {
  Loader2,
  HelpCircle,
  ChevronDown,
  Copy,
  Check,
  ExternalLink,
} from "lucide-react";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { connectionSchema, type ConnectionFormValues } from "@/lib/validators";
import { useCreateConnection, useUpdateConnection } from "@/hooks/useConnections";
import { useConnectionStore } from "@/stores/connectionStore";
import { useUiStore } from "@/stores/uiStore";
import { cn } from "@/lib/utils";

const REDIRECT_URI = "http://localhost:7878/callback";
const REQUIRED_SCOPES = "api, refresh_token";

export default function ConnectionForm() {
  const { connectionFormOpen, editingConnectionId, closeConnectionForm } =
    useUiStore();
  const connections = useConnectionStore((s) => s.connections);
  const editing = connections.find((c) => c.id === editingConnectionId);

  const createConn = useCreateConnection();
  const updateConn = useUpdateConnection();

  const {
    register,
    handleSubmit,
    reset,
    watch,
    formState: { errors },
  } = useForm<ConnectionFormValues>({
    resolver: zodResolver(connectionSchema),
    defaultValues: {
      name: "",
      instance_url: "",
      client_id: "",
    },
  });

  // Setup-help collapsible state. Defaults open the first time a user adds an
  // org (no orgs exist yet), closed otherwise — admins re-adding sandboxes
  // shouldn't have it expanded by default.
  const [helpOpen, setHelpOpen] = useState<boolean>(
    () => !editing && connections.length === 0
  );
  const [copied, setCopied] = useState(false);

  const instanceUrlValue = watch("instance_url");

  async function copyRedirect() {
    await navigator.clipboard.writeText(REDIRECT_URI);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  async function openSalesforceSetup() {
    const url =
      instanceUrlValue && instanceUrlValue.startsWith("http")
        ? `${instanceUrlValue.replace(/\/$/, "")}/lightning/setup/ConnectedApplication/home`
        : "https://help.salesforce.com/s/articleView?id=sf.connected_app_create.htm";
    await openUrl(url);
  }

  // Populate form when editing
  useEffect(() => {
    if (editing) {
      reset({
        name: editing.name,
        instance_url: editing.instance_url ?? "",
        client_id: editing.client_id ?? "",
      });
    } else {
      reset({ name: "", instance_url: "", client_id: "" });
    }
  }, [editing, reset]);

  const isSubmitting = createConn.isPending || updateConn.isPending;

  const onSubmit = (values: ConnectionFormValues) => {
    if (editing) {
      updateConn.mutate(
        { id: editing.id, ...values },
        { onSuccess: closeConnectionForm }
      );
    } else {
      createConn.mutate(values, { onSuccess: closeConnectionForm });
    }
  };

  return (
    <Dialog open={connectionFormOpen} onOpenChange={(open) => !open && closeConnectionForm()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>
            {editing ? "Edit Salesforce org" : "Add Salesforce org"}
          </DialogTitle>
          <DialogDescription>
            {editing
              ? "Update the details for this Salesforce org."
              : "Connect a Salesforce org. You'll need the instance URL and the Consumer Key from a Connected App in that org."}
          </DialogDescription>
        </DialogHeader>

        {/* Connected App setup help — collapsible */}
        {!editing && (
          <div className="rounded-md border border-dashed bg-muted/30">
            <button
              type="button"
              onClick={() => setHelpOpen((o) => !o)}
              className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs font-medium"
            >
              <HelpCircle className="h-3.5 w-3.5 text-muted-foreground" />
              First time? How to create a Connected App
              <ChevronDown
                className={cn(
                  "ml-auto h-3 w-3 text-muted-foreground transition-transform",
                  helpOpen && "rotate-180"
                )}
              />
            </button>
            {helpOpen && (
              <div className="space-y-3 border-t px-3 py-3 text-xs text-muted-foreground">
                <ol className="ml-4 list-decimal space-y-2">
                  <li>Open Salesforce Setup as an admin user</li>
                  <li>
                    Search for <code className="text-foreground">App Manager</code>{" "}
                    →{" "}
                    <strong className="text-foreground">New Connected App</strong>
                  </li>
                  <li>
                    Enable OAuth Settings and paste this <strong>Callback URL</strong>:
                    <div className="mt-1.5 flex items-center gap-2 rounded-md border bg-background px-2 py-1.5">
                      <code className="flex-1 truncate text-foreground">
                        {REDIRECT_URI}
                      </code>
                      <button
                        type="button"
                        onClick={copyRedirect}
                        className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
                        aria-label="Copy callback URL"
                      >
                        {copied ? (
                          <Check className="h-3 w-3 text-emerald-600 dark:text-emerald-400" />
                        ) : (
                          <Copy className="h-3 w-3" />
                        )}
                      </button>
                    </div>
                  </li>
                  <li>
                    Add the OAuth scopes:{" "}
                    <code className="text-foreground">{REQUIRED_SCOPES}</code>
                  </li>
                  <li>
                    Save and wait <strong>~10 minutes</strong> for Salesforce to
                    propagate the new app
                  </li>
                  <li>
                    Open the Connected App and copy the{" "}
                    <strong className="text-foreground">Consumer Key</strong>{" "}
                    into the field below
                  </li>
                </ol>

                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={openSalesforceSetup}
                  className="w-full"
                >
                  <ExternalLink className="h-3 w-3" />
                  Open Salesforce Setup
                </Button>
              </div>
            )}
          </div>
        )}

        <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="name">Nickname</Label>
            <Input
              id="name"
              placeholder="e.g. Production, Sandbox, Dev"
              {...register("name")}
            />
            {errors.name && (
              <p className="text-xs text-destructive">{errors.name.message}</p>
            )}
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="instance_url">Instance URL</Label>
            <Input
              id="instance_url"
              placeholder="https://myorg.my.salesforce.com"
              {...register("instance_url")}
            />
            {errors.instance_url && (
              <p className="text-xs text-destructive">
                {errors.instance_url.message}
              </p>
            )}
            <p className="text-xs text-muted-foreground">
              Use <code>https://test.salesforce.com</code> for sandboxes.
            </p>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="client_id">Consumer Key (Client ID)</Label>
            <Input
              id="client_id"
              placeholder="3MVG9..."
              {...register("client_id")}
            />
            {errors.client_id && (
              <p className="text-xs text-destructive">
                {errors.client_id.message}
              </p>
            )}
            <p className="text-xs text-muted-foreground">
              Found in your Salesforce Connected App settings.
            </p>
          </div>

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={closeConnectionForm}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={isSubmitting}>
              {isSubmitting && <Loader2 className="animate-spin" />}
              {editing ? "Save changes" : "Add org"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
