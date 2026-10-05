import { CodeOutlined, HomeOutlined, MenuFoldOutlined, MenuUnfoldOutlined, MessageOutlined, MoonOutlined, SunOutlined } from "@ant-design/icons";
import { Button, Grid, Menu, Switch } from "antd";
import { Link, Outlet, useLocation } from "@tanstack/react-router";
import { useState } from "react";
import { useThemeStore } from "@/store/useThemeStore";
import styles from "./AppLayout.module.css";

const menuItems = [
  { key: "/", icon: <HomeOutlined />, label: <Link to="/">首页</Link> },
  { key: "/chat", icon: <MessageOutlined />, label: <Link to="/chat">智能对话</Link> },
  { key: "/about", icon: <CodeOutlined />, label: <Link to="/about">关于模板</Link> },
];

export function AppLayout() {
  const [collapsed, setCollapsed] = useState(true);
  const screens = Grid.useBreakpoint();
  const isCompact = screens.md === false;
  const menuCollapsed = isCompact || collapsed;
  const location = useLocation();
  const appTheme = useThemeStore((state) => state.theme);
  const setTheme = useThemeStore((state) => state.setTheme);
  const selectedPath = location.pathname.replace(/\/+$/, "") || "/";

  return (
    <div className={styles.appShell} data-collapsed={menuCollapsed}>
      <header className={styles.header}>
        <div className={styles.brand}>
          <span className={styles.brandMark}>M</span>
          <span className={styles.brandName}>Mozi Agent</span>
        </div>
        <Switch
          checked={appTheme === "dark"}
          onChange={(checked) => setTheme(checked ? "dark" : "light")}
          checkedChildren={<MoonOutlined />}
          unCheckedChildren={<SunOutlined />}
          aria-label="切换主题"
        />
      </header>
      <div className={styles.mainLayout}>
        <aside className={styles.sideBar} aria-label="主导航">
          <div className={styles.sideBarTop}>
            <Button
              type="text"
              icon={menuCollapsed ? <MenuUnfoldOutlined /> : <MenuFoldOutlined />}
              onClick={() => setCollapsed((value) => !value)}
              className={styles.collapseButton}
              aria-label={menuCollapsed ? "展开菜单" : "收起菜单"}
              aria-expanded={!menuCollapsed}
              aria-controls="app-menu"
              disabled={isCompact}
            />
          </div>
          <Menu
            id="app-menu"
            mode="inline"
            inlineCollapsed={menuCollapsed}
            selectedKeys={[selectedPath]}
            items={menuItems}
            className={styles.menu}
          />
        </aside>
        <main className={styles.content}>
          <div className={styles.contentInner}><Outlet /></div>
        </main>
      </div>
    </div>
  );
}
