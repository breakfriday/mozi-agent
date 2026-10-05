import {
  CloseOutlined,
  FullscreenExitOutlined,
  FullscreenOutlined,
  MinusOutlined,
} from "@ant-design/icons";
import { Button, message } from "antd";
import { useEffect, useState } from "react";
import { bridgeApi } from "@/runtime/bridge";
import styles from "./AppLayout.module.css";

export function WindowControls() {
  const [isFullScreen, setIsFullScreen] = useState(false);
  const [pending, setPending] = useState(false);
  const [messageApi, contextHolder] = message.useMessage();

  useEffect(() => {
    if (!bridgeApi.available) return;
    let active = true;
    let receivedEvent = false;
    const off = bridgeApi.window.onStateChanged((state) => {
      receivedEvent = true;
      if (active) setIsFullScreen(state.isFullScreen);
    });
    void bridgeApi.window
      .getState()
      .then((state) => {
        if (active && !receivedEvent && state)
          setIsFullScreen(state.isFullScreen);
      })
      .catch(() => {
        if (active) void messageApi.error("无法获取窗口状态");
      });
    return () => {
      active = false;
      off();
    };
  }, [messageApi]);

  async function toggleFullScreen() {
    setPending(true);
    try {
      const accepted = await bridgeApi.window.setFullScreen(!isFullScreen);
      if (!accepted) void messageApi.error("无法切换全屏");
      // Native enter/leave-full-screen events provide the actual state.
    } catch {
      void messageApi.error("切换全屏失败，请重试");
    } finally {
      setPending(false);
    }
  }

  if (!bridgeApi.available) return null;

  return (
    <div className={styles.windowControls} role="group" aria-label="窗口控制">
      {contextHolder}
      <Button
        type="text"
        className={styles.windowButton}
        icon={<MinusOutlined />}
        onClick={() => bridgeApi.window.minimize()}
        aria-label="最小化窗口"
        title="最小化窗口"
      />
      <Button
        type="text"
        className={styles.windowButton}
        icon={
          isFullScreen ? <FullscreenExitOutlined /> : <FullscreenOutlined />
        }
        onClick={() => void toggleFullScreen()}
        disabled={pending}
        aria-label={isFullScreen ? "退出全屏" : "进入全屏"}
        title={isFullScreen ? "退出全屏" : "进入全屏"}
      />
      <Button
        type="text"
        className={`${styles.windowButton} ${styles.closeButton}`}
        icon={<CloseOutlined />}
        onClick={() => bridgeApi.window.close()}
        aria-label="关闭窗口"
        title="关闭窗口"
      />
    </div>
  );
}
