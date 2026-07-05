import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  askDataPool,
  createDataPool,
  deleteDataPool,
  downloadAiModel,
  getAiHardwareInfo,
  listAiModels,
  listDataPools,
  loadAiModel,
  recommendAiModel,
} from "@/lib/tauri-commands";
import { errMsg } from "./useQueries";

// ── Cache keys ────────────────────────────────────────────────────────────────

export const aiModelsKey = ["ai_models"] as const;
export const aiHardwareKey = ["ai_hardware"] as const;
export const aiRecommendationKey = ["ai_recommendation"] as const;
export const dataPoolsKey = ["data_pools"] as const;

// ── Models ────────────────────────────────────────────────────────────────────

export function useAiModels() {
  return useQuery({ queryKey: aiModelsKey, queryFn: listAiModels, staleTime: Infinity });
}

export function useAiHardware() {
  return useQuery({ queryKey: aiHardwareKey, queryFn: getAiHardwareInfo });
}

export function useAiRecommendation() {
  return useQuery({ queryKey: aiRecommendationKey, queryFn: recommendAiModel });
}

/** Download a model. Progress arrives on `model:download:{id}` events — listen in the UI. */
export function useDownloadAiModel() {
  return useMutation({
    mutationFn: (modelId: string) => downloadAiModel(modelId),
    onError: (e) => toast.error(`Download failed: ${errMsg(e)}`),
  });
}

export function useLoadAiModel() {
  return useMutation({
    mutationFn: (modelId: string) => loadAiModel(modelId),
    onError: (e) => toast.error(`Couldn't load model: ${errMsg(e)}`),
  });
}

// ── Data pools ────────────────────────────────────────────────────────────────

export function useDataPools() {
  return useQuery({ queryKey: dataPoolsKey, queryFn: listDataPools });
}

export function useCreateDataPool() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { name: string; file_path: string }) => createDataPool(args),
    onSuccess: (pool) => {
      qc.invalidateQueries({ queryKey: dataPoolsKey });
      toast.success(`Imported "${pool.name}" (${pool.row_count.toLocaleString()} rows)`);
    },
    onError: (e) => toast.error(`Import failed: ${errMsg(e)}`),
  });
}

export function useDeleteDataPool() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (poolId: string) => deleteDataPool(poolId),
    onSuccess: () => qc.invalidateQueries({ queryKey: dataPoolsKey }),
    onError: (e) => toast.error(`Couldn't delete pool: ${errMsg(e)}`),
  });
}

export function useAskDataPool() {
  return useMutation({
    mutationFn: (args: { pool_id: string; question: string }) => askDataPool(args),
    onError: (e) => toast.error(`Query failed: ${errMsg(e)}`),
  });
}
