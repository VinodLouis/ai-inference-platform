import { Col, Layout, Row } from "antd";
import AdminUserCreateForm from "../components/AdminUserCreateForm";
import AdminModelManager from "../components/AdminModelManager";

const { Content } = Layout;

export default function AdminPage() {
  return (
    <Content className="content-wrap">
      <Row gutter={[16, 16]}>
        <Col xs={24} lg={14}>
          <AdminUserCreateForm />
        </Col>
        <Col xs={24} lg={10}>
          <AdminModelManager />
        </Col>
      </Row>
    </Content>
  );
}
