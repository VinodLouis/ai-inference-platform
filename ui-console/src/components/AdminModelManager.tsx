import { useEffect, useState } from "react";
import {
  Button,
  Card,
  Form,
  Input,
  Select,
  Space,
  Table,
  Popconfirm,
  Checkbox,
  message,
} from "antd";
import {
  fetchModels,
  postRegisterModel,
  deleteModel,
} from "../services/inferenceApi";
import type { ModelInfo } from "../types";

const { Option } = Select;

export default function AdminModelManager() {
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [form] = Form.useForm();

  async function load() {
    setLoading(true);
    try {
      const m = await fetchModels();
      setModels(m);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  async function onRegister(values: any) {
    try {
      await postRegisterModel(values);
      message.success("Model registered");
      form.resetFields();
      await load();
    } catch (e: any) {
      message.error(e?.message || "Registration failed");
    }
  }

  async function onDeregister(id: string) {
    try {
      await deleteModel(id);
      message.success("Model deregistered");
      await load();
    } catch (e: any) {
      message.error(e?.message || "Deregister failed");
    }
  }

  const columns = [
    { title: "ID", dataIndex: "id", key: "id" },
    { title: "Name", dataIndex: "name", key: "name" },
    { title: "Provider", dataIndex: "provider", key: "provider" },
    {
      title: "Action",
      key: "action",
      render: (text: any, record: ModelInfo) => (
        <Space>
          <Popconfirm
            title={`Deregister model ${record.id}?`}
            onConfirm={() => onDeregister(record.id)}
          >
            <Button danger>Remove</Button>
          </Popconfirm>
        </Space>
      ),
    },
  ];

  return (
    <div>
      <Card
        title="Register Runtime Model"
        className="panel-card"
        style={{ marginBottom: 16 }}
      >
        <Form
          form={form}
          layout="vertical"
          onFinish={onRegister}
          initialValues={{
            type: "text-generation",
            provider: "ollama",
            autoload: false,
          }}
        >
          <Form.Item
            name="id"
            label="Model ID"
            rules={[
              {
                validator: (_: any, value: any) => {
                  if (value && value.toString().trim() !== "")
                    return Promise.resolve();
                  return Promise.reject(new Error("Model ID is required"));
                },
              },
            ]}
          >
            <Input />
          </Form.Item>
          <Form.Item name="name" label="Display Name">
            {" "}
            <Input />{" "}
          </Form.Item>
          <Form.Item
            name="provider"
            label="Provider"
            rules={[{ required: true }]}
          >
            <Select>
              <Option value="ollama">ollama</Option>
              <Option value="llama-cpp">llama-cpp</Option>
            </Select>
          </Form.Item>
          <Form.Item name="type" label="Type">
            {" "}
            <Input />{" "}
          </Form.Item>
          <Form.Item name="modelName" label="Ollama model name (modelName)">
            <Input placeholder="eg. gemma3:1b" />
          </Form.Item>

          <Form.Item
            noStyle
            shouldUpdate={(prevValues, currentValues) =>
              prevValues.provider !== currentValues.provider
            }
          >
            {() => {
              const provider = form.getFieldValue("provider");
              if (provider === "llama-cpp") {
                return (
                  <>
                    <Form.Item
                      name="modelPath"
                      label="Local model path (llama-cpp)"
                    >
                      <Input placeholder="eg. models/phi-2.gguf" />
                    </Form.Item>
                    <Form.Item name="autoload" valuePropName="checked">
                      <Checkbox>Autoload after registration</Checkbox>
                    </Form.Item>
                  </>
                );
              }
              return null;
            }}
          </Form.Item>
          <Form.Item>
            <Button type="primary" htmlType="submit">
              Register Model
            </Button>
          </Form.Item>
        </Form>
      </Card>

      <Card title="Runtime Models" className="panel-card">
        <Table
          rowKey="id"
          dataSource={models}
          columns={columns}
          loading={loading}
          pagination={false}
        />
      </Card>
    </div>
  );
}
