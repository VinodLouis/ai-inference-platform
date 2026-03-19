import { Col, Layout, Row } from "antd";
import { useNavigate } from "react-router-dom";
import LoginFormCard from "../components/LoginFormCard";
import { isAdmin, isInferenceUser } from "../lib/auth";
import type { User } from "../types";

const { Content } = Layout;

interface LoginPageProps {
  onLogin: (token: string, user: User) => void;
}

export default function LoginPage({ onLogin }: LoginPageProps) {
  const navigate = useNavigate();

  function handleLoginSuccess(token: string, user: User): void {
    onLogin(token, user);

    if (isAdmin(user)) {
      navigate("/admin", { replace: true });
      return;
    }

    if (isInferenceUser(user)) {
      navigate("/inference", { replace: true });
      return;
    }

    navigate("/login", { replace: true });
  }

  return (
    <Content className="content-wrap">
      <Row justify="center">
        <Col xs={24} md={16} lg={12}>
          <LoginFormCard onLoginSuccess={handleLoginSuccess} />
        </Col>
      </Row>
    </Content>
  );
}
