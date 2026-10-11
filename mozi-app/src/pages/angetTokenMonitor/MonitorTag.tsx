import type { ReactNode } from "react";
import { CheckCircleOutlined, ClockCircleOutlined, ExclamationCircleOutlined, MinusCircleOutlined } from "@ant-design/icons";
import styles from "./token-monitor.module.css";

export type MonitorTone = "neutral" | "info" | "teal" | "purple" | "amber" | "green" | "red";

export function MonitorTag({ children, tone = "neutral", icon }: { children: ReactNode; tone?: MonitorTone; icon?: ReactNode }) {
  return <span className={styles.tag} data-tone={tone}>{icon}{children}</span>;
}

export function StatusTag({ status, label }: { status: string; label: string }) {
  const completed = status === "completed";
  const failed = status === "failed";
  const active = ["running", "accepted", "cancelling", "waiting_approval"].includes(status);
  const warning = ["cancelled", "interrupted", "incomplete"].includes(status);
  return <MonitorTag tone={completed ? "green" : failed ? "red" : active ? "info" : warning ? "amber" : "neutral"}
    icon={completed ? <CheckCircleOutlined /> : failed || warning ? <ExclamationCircleOutlined /> : active ? <ClockCircleOutlined /> : <MinusCircleOutlined />}>
    {label}
  </MonitorTag>;
}
