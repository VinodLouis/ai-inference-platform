import { Alert, Card, Col, Layout, Row, Typography } from "antd";
import AdminUserCreateForm from "../components/AdminUserCreateForm";

const { Content } = Layout;
const { Paragraph } = Typography;

export default function AdminPage() {
  return (
    <Content className="content-wrap">
      <Row gutter={[16, 16]}>
        <Col xs={24} lg={14}>
          <AdminUserCreateForm />
        </Col>
        <Col xs={24} lg={10}>
          <Card title="Admin Notes" className="panel-card">
            <Paragraph>
              Create users with roles `user`, `premium`, or `enterprise` from
              this panel.
            </Paragraph>
            <Alert
              type="info"
              showIcon
              message="Role Access"
              description="Only admin users can access /admin. Non-admin users are redirected to /inference."
            />
          </Card>
        </Col>
      </Row>
    </Content>
  );
}
