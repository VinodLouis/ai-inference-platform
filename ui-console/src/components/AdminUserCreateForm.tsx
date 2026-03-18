import { Button, Card, Form, Input, message } from 'antd'
import type { AxiosError } from 'axios'
import api from '../api'
import { splitRoles } from '../lib/auth'
import type { CreateUserFormValues } from '../types'

interface ApiErrorResponse {
  error?: string
}

export default function AdminUserCreateForm () {
  const [adminForm] = Form.useForm<CreateUserFormValues>()

  async function createUser (values: CreateUserFormValues): Promise<void> {
    try {
      await api.post('/auth/signup', {
        email: values.email,
        password: values.password,
        signup_secret: values.signupSecret,
        roles: splitRoles(values.roles)
      })

      message.success('User created successfully')
      adminForm.resetFields(['email', 'password'])
    } catch (err: unknown) {
      const apiError = err as AxiosError<ApiErrorResponse>
      message.error(apiError.response?.data?.error || 'Failed to create user')
    }
  }

  return (
    <Card title='Admin: Create User' className='panel-card'>
      <Form
        layout='vertical'
        form={adminForm}
        onFinish={createUser}
        initialValues={{ roles: 'user' }}
      >
        <Form.Item
          label='Email'
          name='email'
          rules={[{ required: true, message: 'Email is required' }]}
        >
          <Input placeholder='new.user@example.com' />
        </Form.Item>

        <Form.Item
          label='Password'
          name='password'
          rules={[{ required: true, message: 'Password is required' }]}
        >
          <Input.Password placeholder='Minimum 6 characters' />
        </Form.Item>

        <Form.Item
          label='Signup Secret'
          name='signupSecret'
          rules={[{ required: true, message: 'Signup secret is required' }]}
        >
          <Input.Password placeholder='Must match backend signup secret' />
        </Form.Item>

        <Form.Item
          label='Roles (comma-separated)'
          name='roles'
          rules={[{ required: true, message: 'At least one role is required' }]}
        >
          <Input placeholder='user,premium,enterprise' />
        </Form.Item>

        <Button type='primary' htmlType='submit' block>
          Create User
        </Button>
      </Form>
    </Card>
  )
}
