import { Alert, Card, Col, Layout, Row, Space, Tag, Typography } from "antd";
import InferenceComposer from "../components/InferenceComposer";
import InferenceHistoryPanel from "../components/InferenceHistoryPanel";
import type { User } from "../types";
import { useInferenceHistory } from "../hooks/useInferenceHistory";
import { useModels } from "../hooks/useModels";

const { Content } = Layout;
const { Text } = Typography;

interface UserPageProps {
  user: User | null;
}

export default function UserPage({ user }: UserPageProps) {
  const { models, modelsLoading, loadModels } = useModels(user?.email);
  const { history, historyLoading, setHistory, loadHistory, appendHistory } =
    useInferenceHistory(user?.email);

  return (
    <Content className="content-wrap">
      <Row gutter={[16, 16]}>
        <Col xs={24} lg={7}>
          <Card title="Inference" className="panel-card">
            <Space direction="vertical" style={{ width: "100%" }}>
              <Text>
                Logged in as <Tag color="blue">{user?.email}</Tag>
              </Text>
              <Alert
                type="info"
                showIcon
                message="Scoped View"
                description="This page shows only inference jobs owned by your authenticated account from backend storage."
              />
              <InferenceComposer
                models={models}
                modelsLoading={modelsLoading}
                onRefreshModels={loadModels}
                onJobCreated={appendHistory}
              />
            </Space>
          </Card>
        </Col>

        <Col xs={24} lg={17}>
          <Card title="History and Status" className="panel-card">
            <InferenceHistoryPanel
              history={history}
              historyLoading={historyLoading}
              onHistoryChange={setHistory}
              onRefreshHistory={loadHistory}
            />
          </Card>
        </Col>
      </Row>
    </Content>
  );
}
