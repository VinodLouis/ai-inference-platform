import {
  Button,
  Descriptions,
  Modal,
  Space,
  Table,
  Tag,
  Typography,
  message,
} from "antd";
import type { AxiosError } from "axios";
import { useCallback, useState } from "react";
import type { Dispatch, SetStateAction } from "react";
import type { InferenceJob, InferenceStatusResponse } from "../types";
import { fetchInferenceStatus } from "../services/inferenceApi";
import {
  formatMultilineOutput,
  getStatusTagColor,
  shortJobId,
  updateJobFromStatusResponse,
} from "../utils/inference";

const { Text } = Typography;

interface InferenceHistoryPanelProps {
  history: InferenceJob[];
  historyLoading: boolean;
  onHistoryChange: Dispatch<SetStateAction<InferenceJob[]>>;
  onRefreshHistory: () => Promise<void>;
}

interface DetailJob {
  jobId: string;
  modelId: string;
  rackId: string;
  status: string;
  updatedAt: string | number;
  prompt: string;
  output: string;
}

interface ApiErrorResponse {
  error?: string;
}

export default function InferenceHistoryPanel({
  history,
  historyLoading,
  onHistoryChange,
  onRefreshHistory,
}: InferenceHistoryPanelProps) {
  const [checkLoading, setCheckLoading] = useState(false);
  const [detailOpen, setDetailOpen] = useState(false);
  const [detailJob, setDetailJob] = useState<DetailJob | null>(null);

  const checkJobStatus = useCallback(
    async (jobId: string) => {
      if (!jobId) return;

      setCheckLoading(true);
      try {
        const response: InferenceStatusResponse =
          await fetchInferenceStatus(jobId);
        const now = Date.now();

        onHistoryChange((prev) =>
          prev.map((item) => {
            if (item.jobId !== jobId) return item;
            return updateJobFromStatusResponse(item, response, now);
          }),
        );

        setDetailJob({
          jobId,
          modelId: response.modelId || "-",
          rackId: response.rackId || "-",
          status: response.status || "unknown",
          updatedAt: response.updatedAt || now,
          prompt: response.prompt || "-",
          output: response?.result?.output || response?.output || "",
        });
        setDetailOpen(true);
        message.success(`Job ${jobId} status: ${response.status || "unknown"}`);
      } catch (err: unknown) {
        const apiError = err as AxiosError<ApiErrorResponse>;
        message.error(apiError.response?.data?.error || "Status check failed");
      } finally {
        setCheckLoading(false);
      }
    },
    [onHistoryChange],
  );

  return (
    <Space direction="vertical" size={10} style={{ width: "100%" }}>
      <Text strong>Your Inference History</Text>

      <Space>
        <Button onClick={onRefreshHistory} loading={historyLoading}>
          Sync History
        </Button>
      </Space>

      <Table
        size="small"
        loading={historyLoading}
        pagination={false}
        rowKey="jobId"
        dataSource={history}
        tableLayout="fixed"
        scroll={{ x: 760 }}
        columns={[
          {
            title: "JobId",
            dataIndex: "jobId",
            width: 120,
            render: (value: string) => (
              <Text code title={value}>
                {shortJobId(value)}
              </Text>
            ),
          },
          {
            title: "Model",
            dataIndex: "modelId",
            width: 220,
            render: (value: string) => (
              <Text
                style={{ display: "inline-block", maxWidth: 200 }}
                ellipsis={{ tooltip: value }}
              >
                {value || "-"}
              </Text>
            ),
          },
          {
            title: "Status",
            dataIndex: "status",
            width: 140,
            render: (value: string) => {
              const status = value || "unknown";
              const color = getStatusTagColor(status);
              return <Tag color={color}>{status}</Tag>;
            },
          },
          {
            title: "Updated",
            dataIndex: "updatedAt",
            width: 220,
            render: (value: string | number) =>
              value ? new Date(value).toLocaleString() : "-",
          },
          {
            title: "Action",
            key: "action",
            width: 120,
            render: (_: unknown, record: InferenceJob) => (
              <Button
                size="small"
                loading={checkLoading}
                onClick={() => checkJobStatus(record.jobId)}
              >
                Check
              </Button>
            ),
          },
        ]}
      />

      <Modal
        title="Inference Detail"
        open={detailOpen}
        onCancel={() => setDetailOpen(false)}
        footer={null}
        width={760}
      >
        {detailJob && (
          <Descriptions size="small" bordered column={1}>
            <Descriptions.Item label="Job ID">
              {detailJob.jobId}
            </Descriptions.Item>
            <Descriptions.Item label="Model">
              {detailJob.modelId}
            </Descriptions.Item>
            <Descriptions.Item label="Rack">
              {detailJob.rackId}
            </Descriptions.Item>
            <Descriptions.Item label="Status">
              <Tag color={getStatusTagColor(detailJob.status)}>
                {detailJob.status}
              </Tag>
            </Descriptions.Item>
            <Descriptions.Item label="Updated">
              {new Date(detailJob.updatedAt).toLocaleString()}
            </Descriptions.Item>
            <Descriptions.Item label="Prompt">
              <div style={{ whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
                {formatMultilineOutput(detailJob.prompt)}
              </div>
            </Descriptions.Item>
            <Descriptions.Item label="Result">
              {detailJob.output ? (
                <div
                  style={{ whiteSpace: "pre-wrap", wordBreak: "break-word" }}
                >
                  {formatMultilineOutput(detailJob.output)}
                </div>
              ) : (
                <Text type="secondary">No result yet</Text>
              )}
            </Descriptions.Item>
          </Descriptions>
        )}
      </Modal>
    </Space>
  );
}
