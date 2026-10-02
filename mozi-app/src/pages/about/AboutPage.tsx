import { Card, List, Tag, Typography } from "antd";

export function AboutPage() {
  return <Card title="关于 DualVite"><Typography.Paragraph>这是脚手架自带的第二个页面，用于演示文件路由、菜单高亮和 Layout Outlet。</Typography.Paragraph><List bordered dataSource={["src/app：全局 Provider", "src/api：apiClient、apiConfig 与 services", "src/store：主题与认证状态", "src/runtime：Web / Filelocal 平台差异", "src/routes：TanStack 文件路由"]} renderItem={(item) => <List.Item><Tag color="blue">目录</Tag>{item}</List.Item>} /></Card>;
}
