import { ApiOutlined, CloudOutlined, DesktopOutlined, RightOutlined } from "@ant-design/icons";
import { Alert, Card, Col, Divider, Row, Space, Tag, Typography } from "antd";
import { Link } from "@tanstack/react-router";
import { API_BASE_URL } from "@/api/apiClient";
import { isFileLocalRuntime } from "@/runtime/pageUrl";
import styles from "./Homepage.module.css";

const cards = [
  { title: "路由已就绪", description: "TanStack 文件路由与可复用 Layout。", icon: <ApiOutlined /> },
  { title: "数据层已就绪", description: "Axios、React Query 与统一错误模型。", icon: <CloudOutlined /> },
  { title: "双目标构建", description: "Web 与 File Local / Electron 使用同一份代码。", icon: <DesktopOutlined /> },
];

export function Homepage() {
  const runtime = isFileLocalRuntime ? "File Local" : "Web";
  return (
    <div className={styles.page}>
      <section className={styles.hero}>
        <Tag>DualVite Application Starter</Tag>
        <Typography.Title level={1}>开箱即用的双目标 React 应用</Typography.Title>
        <Typography.Paragraph>这里是无业务绑定的默认首页。页面通过 <code>src/api/services</code> 调用统一请求层。</Typography.Paragraph>
        <Space wrap><Tag color="green">运行模式：{runtime}</Tag><Tag>API：{API_BASE_URL}</Tag></Space>
      </section>
      <Row gutter={[18, 18]}>{cards.map((card) => <Col xs={24} md={8} key={card.title}><Card className={styles.card}><span className={styles.icon}>{card.icon}</span><Typography.Title level={4}>{card.title}</Typography.Title><Typography.Paragraph type="secondary">{card.description}</Typography.Paragraph></Card></Col>)}</Row>
      <Divider />
      <Alert type="info" showIcon message="下一步" description={<span>修改 <code>.env.web</code> 中的部署前缀和 API 地址；然后访问 <Link to="/about">关于模板 <RightOutlined /></Link> 查看目录约定。</span>} />
    </div>
  );
}
