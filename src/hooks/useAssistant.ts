import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  addKnowledgeFile,
  addKnowledgeUrl,
  askDataPool,
  createDataPool,
  createDataPoolFromResults,
  deleteDataPool,
  deleteKnowledgeSource,
  downloadAiModel,
  generateReport,
  getActiveAiModel,
  getAiHardwareInfo,
  listAiModels,
  listDataPools,
  listKnowledgeSources,
  loadAiModel,
  recommendAiModel,
  writeProspecting,
} from "@/lib/tauri-commands";
import { errMsg } from "./useQueries";

// ── Cache keys ────────────────────────────────────────────────────────────────

export const aiModelsKey = ["ai_models"] as const;
export const aiHardwareKey = ["ai_hardware"] as const;
export const aiRecommendationKey = ["ai_recommendation"] as const;
export const activeModelKey = ["active_ai_model"] as const;
export const dataPoolsKey = ["data_pools"] as const;
export const knowledgeSourcesKey = ["knowledge_sources"] as const;

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

/** The currently-active (loaded) model id, or null. */
export function useActiveAiModel() {
  return useQuery({ queryKey: activeModelKey, queryFn: getActiveAiModel });
}

/** Download a model. Progress arrives on `model:download:{id}` events — listen in the UI. */
export function useDownloadAiModel() {
  return useMutation({
    mutationFn: (modelId: string) => downloadAiModel(modelId),
    onError: (e) => toast.error(`Download failed: ${errMsg(e)}`),
  });
}

export function useLoadAiModel() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (modelId: string) => loadAiModel(modelId),
    onSuccess: () => qc.invalidateQueries({ queryKey: activeModelKey }),
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

/** Create a pool from query results (the primary path — run a query, save the results). */
export function useCreateDataPoolFromResults() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { name: string; columns: string[]; rows: string[][] }) =>
      createDataPoolFromResults(args),
    onSuccess: (pool) => {
      qc.invalidateQueries({ queryKey: dataPoolsKey });
      toast.success(`Saved "${pool.name}" as a data pool (${pool.row_count.toLocaleString()} rows)`);
    },
    onError: (e) => toast.error(`Couldn't save pool: ${errMsg(e)}`),
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

/** Generate a report (template or freeform). Progress arrives on `report:progress` events. */
export function useGenerateReport() {
  return useMutation({
    mutationFn: (args: { pool_id: string; template?: string; request?: string }) =>
      generateReport(args),
    onError: (e) => toast.error(`Report failed: ${errMsg(e)}`),
  });
}

// ── Knowledge base (RAG / prospecting) ────────────────────────────────────────

export function useKnowledgeSources() {
  return useQuery({ queryKey: knowledgeSourcesKey, queryFn: listKnowledgeSources });
}

export function useAddKnowledgeFile() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (filePath: string) => addKnowledgeFile(filePath),
    onSuccess: (s) => {
      qc.invalidateQueries({ queryKey: knowledgeSourcesKey });
      toast.success(`Added "${s.name}" (${s.chunk_count} chunks)`);
    },
    onError: (e) => toast.error(`Couldn't add source: ${errMsg(e)}`),
  });
}

export function useAddKnowledgeUrl() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (url: string) => addKnowledgeUrl(url),
    onSuccess: (s) => {
      qc.invalidateQueries({ queryKey: knowledgeSourcesKey });
      toast.success(`Added "${s.name}" (${s.chunk_count} chunks)`);
    },
    onError: (e) => toast.error(`Couldn't add page: ${errMsg(e)}`),
  });
}

export function useDeleteKnowledgeSource() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (sourceId: string) => deleteKnowledgeSource(sourceId),
    onSuccess: () => qc.invalidateQueries({ queryKey: knowledgeSourcesKey }),
    onError: (e) => toast.error(`Couldn't delete source: ${errMsg(e)}`),
  });
}

export function useWriteProspecting() {
  return useMutation({
    mutationFn: (brief: string) => writeProspecting(brief),
    onError: (e) => toast.error(`Couldn't write that: ${errMsg(e)}`),
  });
}

export function useAskDataPool() {
  return useMutation({
    mutationFn: (args: {
      pool_id: string;
      question: string;
      history: { question: string; sql: string }[];
    }) => askDataPool(args),
    onError: (e) => toast.error(`Query failed: ${errMsg(e)}`),
  });
}
