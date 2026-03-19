import { Button, Space, Tag, Typography } from "antd";
import type { User } from "../types";

const { Title } = Typography;

interface AppHeaderProps {
  user: User | null;
  onLogout: () => void;
}

export default function AppHeader({ user, onLogout }: AppHeaderProps) {
  return (
    <div className="header-inner">
      <Title level={4} className="header-title">
        AI Inference Console
      </Title>
      <Space>
        {user?.email && <Tag color="blue">{user.email}</Tag>}
        {user?.roles?.map((role) => (
          <Tag key={role} color="geekblue">
            {role}
          </Tag>
        ))}
        {user ? (
          <Button onClick={onLogout}>Logout</Button>
        ) : (
          <Tag color="orange">Not logged in</Tag>
        )}
      </Space>
    </div>
  );
}
