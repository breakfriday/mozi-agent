import styles from "./MoziIcon.module.css";

export function MoziIcon({ animated = false }: { animated?: boolean }) {
  return (
    <span
      className={styles.icon}
      data-animated={animated || undefined}
      aria-hidden="true"
    >
      <span className={styles.float}>
        <span className={styles.face}>
          <span className={styles.mark} />
        </span>
      </span>
    </span>
  );
}
