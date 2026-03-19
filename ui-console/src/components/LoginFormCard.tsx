import { Button, Card, Form, Input, message } from "antd";
import type { AxiosError } from "axios";
import api, { setAuthToken } from "../api";
import { saveSession } from "../lib/session";
import type { LoginFormValues, LoginResponse, User } from "../types";

interface LoginFormCardProps {
  onLoginSuccess: (token: string, user: User) => void;
}

interface ApiErrorResponse {
  error?: string;
}

export default function LoginFormCard({ onLoginSuccess }: LoginFormCardProps) {
  const [loginForm] = Form.useForm<LoginFormValues>();

  async function login(values: LoginFormValues): Promise<void> {
    try {
      const result = await api.post<LoginResponse>("/auth/login", {
        email: values.email,
        password: values.password,
      });

      const token = result.data?.token;
      const user = result.data?.user || null;

      if (!token || !user) {
        throw new Error("Invalid login response");
      }

      setAuthToken(token);
      saveSession(token, user);
      onLoginSuccess(token, user);
      message.success("Login successful");
    } catch (err: unknown) {
      const apiError = err as AxiosError<ApiErrorResponse>;
      const fallback = err instanceof Error ? err.message : "Login failed";
      message.error(apiError.response?.data?.error || fallback);
    }
  }

  return (
    <Card title="Login" className="panel-card">
      <Form layout="vertical" form={loginForm} onFinish={login}>
        <Form.Item
          label="Email"
          name="email"
          rules={[{ required: true, message: "Email is required" }]}
        >
          <Input placeholder="user@example.com" />
        </Form.Item>

        <Form.Item
          label="Password"
          name="password"
          rules={[{ required: true, message: "Password is required" }]}
        >
          <Input.Password placeholder="Your account password" />
        </Form.Item>

        <Button type="primary" htmlType="submit" block>
          Login
        </Button>
      </Form>
    </Card>
  );
}
