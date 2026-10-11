import styles from "./token-monitor.module.css";

export function TokenValue({ value }: { value?: number }) {
  return <span className={styles.tokenValue} data-known={value !== undefined}>
    <span>{value === undefined ? "—" : value.toLocaleString("en-US")}</span><small> token</small>
  </span>;
}
