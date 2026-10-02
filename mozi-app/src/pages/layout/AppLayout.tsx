import { BulbOutlined, CodeOutlined, HomeOutlined, MenuFoldOutlined, MenuUnfoldOutlined } from "@ant-design/icons";
import { Button, Layout, Menu, Space, Switch, Typography } from "antd";
import { Link, Outlet, useLocation } from "@tanstack/react-router";
import { useState } from "react";
import { useThemeStore } from "@/store/useThemeStore";
import styles from "./AppLayout.module.css";

const menuItems = [
  { key: "/", icon: <HomeOutlined />, label: <Link to="/">首页</Link> },
  { key: "/about", icon: <CodeOutlined />, label: <Link to="/about">关于模板</Link> },
];

export function AppLayout() {
  const [collapsed, setCollapsed] = useState(false);
  const location = useLocation();
  const appTheme = useThemeStore((state) => state.theme);
  const toggleTheme = useThemeStore((state) => state.toggleTheme);

  return (
    <Layout className={styles.shell}>
      <Layout.Sider className={styles.sider} trigger={null} collapsible collapsed={collapsed} width={236}>
        <div className={styles.brand}><span className={styles.mark}>D</span>{!collapsed && <Typography.Text strong>DualVite</Typography.Text>}</div>
        <Menu theme={appTheme === "dark" ? "dark" : "light"} mode="inline" selectedKeys={[location.pathname]} items={menuItems} className={styles.menu} />
      </Layout.Sider>
      <Layout>
        <Layout.Header className={styles.header}>
          <Button type="text" aria-label="切换菜单" icon={collapsed ? <MenuUnfoldOutlined /> : <MenuFoldOutlined />} onClick={() => setCollapsed((value) => !value)} />
          <Space>
            <BulbOutlined />
            <Switch checked={appTheme === "dark"} onChange={toggleTheme} checkedChildren="暗" unCheckedChildren="亮" aria-label="切换主题" />
          </Space>
        </Layout.Header>
        <Layout.Content className={styles.content}><Outlet /></Layout.Content>
      </Layout>
    </Layout>
  );
}
