import { ConfigProvider } from "antd";
import zhCN from "antd/locale/zh_CN";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useMemo, type PropsWithChildren } from "react";
import { useThemeStore } from "@/store/useThemeStore";
import { createAntdTheme } from "./theme";
import { AssistantUiProvider } from "./AssistantUiProvider";

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false } },
});

export function AppProviders({ children }: PropsWithChildren) {
  const appTheme = useThemeStore((state) => state.theme);
  const antdTheme = useMemo(() => createAntdTheme(appTheme), [appTheme]);

  return (
    <QueryClientProvider client={queryClient}>
      <ConfigProvider
        locale={zhCN}
        theme={antdTheme}
      >
        <AssistantUiProvider>{children}</AssistantUiProvider>
      </ConfigProvider>
    </QueryClientProvider>
  );
}
