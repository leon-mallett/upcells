import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import ConnectionCard from "./ConnectionCard";
import { useUiStore } from "@/stores/uiStore";
import { useConnectionStore } from "@/stores/connectionStore";

export default function ConnectionList() {
  const connections = useConnectionStore((s) => s.connections);
  const openForm = useUiStore((s) => s.openConnectionForm);

  if (connections.length === 0) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-4 text-center">
        <div className="rounded-full bg-muted p-6">
          <Plus className="h-8 w-8 text-muted-foreground" />
        </div>
        <div className="max-w-sm">
          <p className="font-medium">No Salesforce orgs connected yet</p>
          <p className="mt-1 text-sm text-muted-foreground">
            Add one to start querying and updating data. You can connect
            multiple orgs (e.g. Production and Sandbox) and pick which to use
            per operation.
          </p>
        </div>
        <Button onClick={() => openForm()}>
          <Plus />
          Add org
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {connections.map((c) => (
        <ConnectionCard key={c.id} connection={c} />
      ))}
    </div>
  );
}
