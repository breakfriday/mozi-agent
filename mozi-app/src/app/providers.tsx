import { ConfigProvider, theme } from "antd";
import zhCN from "antd/locale/zh_CN";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { PropsWithChildren } from "react";
import { useThemeStore } from "@/store/useThemeStore";

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false } },
});

export function AppProviders({ children }: PropsWithChildren) {
  const appTheme = useThemeStore((state) => state.theme);
  return (
    <QueryClientProvider client={queryClient}>
      <ConfigProvider
        locale={zhCN}
        theme={{
          algorithm: appTheme === "dark" ? theme.darkAlgorithm : theme.defaultAlgorithm,
          token: { colorPrimary: "#1677ff", borderRadius: 8, fontFamily: "Inter, system-ui, sans-serif" },
        }}
      >
        {children}
      </ConfigProvider>
    </QueryClientProvider>
  );
}
