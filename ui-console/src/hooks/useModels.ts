import { message } from "antd";
import type { AxiosError } from "axios";
import { useCallback, useEffect, useState } from "react";
import { fetchModels } from "../services/inferenceApi";
import type { ModelInfo } from "../types";

interface ApiErrorResponse {
  error?: string;
}

export function useModels(refreshKey?: string) {
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [modelsLoading, setModelsLoading] = useState(false);

  const loadModels = useCallback(async (): Promise<void> => {
    setModelsLoading(true);
    try {
      const result = await fetchModels();
      setModels(result);
    } catch (err: unknown) {
      const apiError = err as AxiosError<ApiErrorResponse>;
      message.error(apiError.response?.data?.error || "Failed to load models");
    } finally {
      setModelsLoading(false);
    }
  }, []);

  useEffect(() => {
    loadModels().catch(() => {});
  }, [refreshKey, loadModels]);

  return {
    models,
    modelsLoading,
    loadModels,
  };
}
