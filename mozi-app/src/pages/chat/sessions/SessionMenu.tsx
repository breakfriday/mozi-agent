import { useRef } from "react";
import { DropdownMenu } from "radix-ui";
import { MoreHorizontal, Pencil, Trash2 } from "lucide-react";
import styles from "./session-menu.module.css";

export function SessionMenu({
  title,
  className,
  running,
  disabled,
  onAction,
}: {
  title: string;
  className?: string;
  running: boolean;
  disabled: boolean;
  onAction: (kind: "rename" | "delete") => void;
}) {
  const openingDialog = useRef(false);
  return (
    <DropdownMenu.Root
      onOpenChange={(open) => {
        if (open) openingDialog.current = false;
      }}
    >
      <DropdownMenu.Trigger asChild>
        <button
          className={className}
          type="button"
          disabled={disabled}
          aria-label={`更多操作：${title}`}
          title="更多操作"
        >
          <MoreHorizontal size={17} />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          className={styles.menu}
          side="right"
          align="start"
          sideOffset={6}
          onCloseAutoFocus={(event) => {
            if (openingDialog.current) event.preventDefault();
          }}
        >
          <DropdownMenu.Item
            className={styles.menuItem}
            onSelect={() => {
              openingDialog.current = true;
              onAction("rename");
            }}
          >
            <Pencil size={14} />
            重命名
          </DropdownMenu.Item>
          <DropdownMenu.Separator className={styles.separator} />
          <DropdownMenu.Item
            className={`${styles.menuItem} ${styles.deleteItem}`}
            disabled={running}
            title={running ? "请先停止任务再删除" : undefined}
            onSelect={() => {
              openingDialog.current = true;
              onAction("delete");
            }}
          >
            <Trash2 size={14} />
            删除会话
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
