import {
  Button,
  Divider,
  Form,
  Input,
  InputNumber,
  Select,
  Space,
  message,
} from "antd";
import type { AxiosError } from "axios";
import { submitInferenceRequest } from "../services/inferenceApi";
import type {
  InferenceComposerFormValues,
  InferenceJob,
  ModelInfo,
} from "../types";
import { buildOptimisticJob } from "../utils/inference";

interface InferenceComposerProps {
  models: ModelInfo[];
  modelsLoading: boolean;
  onRefreshModels: () => Promise<void>;
  onJobCreated: (job: InferenceJob) => void;
}

interface ApiErrorResponse {
  error?: string;
}

export default function InferenceComposer({
  models,
  modelsLoading,
  onRefreshModels,
  onJobCreated,
}: InferenceComposerProps) {
  const [inferenceForm] = Form.useForm<InferenceComposerFormValues>();

  const modelOptions = models.map((model) => ({
    label: `${model.name || model.id} (${model.provider || "provider-unknown"})`,
    value: model.id,
  }));

  async function submitInference(
    values: InferenceComposerFormValues,
  ): Promise<void> {
    try {
      const result = await submitInferenceRequest(values);

      if (!result.jobId) {
        throw new Error("Inference submission failed");
      }

      onJobCreated(
        buildOptimisticJob(
          {
            jobId: result.jobId,
            rackId: result.rackId,
            status: result.status,
          },
          values,
        ),
      );
      message.success("Inference submitted");
    } catch (err: unknown) {
      const apiError = err as AxiosError<ApiErrorResponse>;
      message.error(
        apiError.response?.data?.error || "Inference submission failed",
      );
    }
  }

  return (
    <Form
      layout="vertical"
      form={inferenceForm}
      onFinish={submitInference}
      initialValues={{
        maxTokens: 64,
        temperature: 0.7,
        topP: 0.95,
        modelId: models[0]?.id,
      }}
    >
      <Form.Item
        label="Available Models"
        name="modelId"
        rules={[{ required: true }]}
      >
        <Select
          placeholder="Load and select a model"
          loading={modelsLoading}
          options={modelOptions}
          dropdownRender={(menu) => (
            <>
              {menu}
              <Divider style={{ margin: "8px 0" }} />
              <Space style={{ padding: "0 8px 8px" }}>
                <Button
                  size="small"
                  onClick={onRefreshModels}
                  loading={modelsLoading}
                >
                  Refresh Models
                </Button>
              </Space>
            </>
          )}
        />
      </Form.Item>

      <Form.Item label="Prompt" name="prompt" rules={[{ required: true }]}>
        <Input.TextArea rows={5} placeholder="Write a prompt..." />
      </Form.Item>

      <Space size={12} wrap>
        <Form.Item label="max_tokens" name="maxTokens">
          <InputNumber min={1} max={4096} />
        </Form.Item>
        <Form.Item label="temperature" name="temperature">
          <InputNumber min={0} max={2} step={0.1} />
        </Form.Item>
        <Form.Item label="top_p" name="topP">
          <InputNumber min={0} max={1} step={0.05} />
        </Form.Item>
      </Space>

      <Button type="primary" htmlType="submit" block>
        Submit Inference
      </Button>
    </Form>
  );
}
