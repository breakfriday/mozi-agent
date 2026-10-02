import { ConfigProvider, theme } from "antd";
import zhCN from "antd/locale/zh_CN";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useLayoutEffect, type PropsWithChildren } from "react";
import { useThemeStore } from "@/store/useThemeStore";

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false } },
});

export function AppProviders({ children }: PropsWithChildren) {
  const appTheme = useThemeStore((state) => state.theme);
  const isDarkTheme = appTheme === "dark";

  useLayoutEffect(() => {
    document.documentElement.dataset.theme = appTheme;
  }, [appTheme]);

  return (
    <QueryClientProvider client={queryClient}>
      <ConfigProvider
        locale={zhCN}
        theme={{
          algorithm: isDarkTheme ? theme.darkAlgorithm : theme.defaultAlgorithm,
          token: { colorPrimary: "#2563eb", borderRadius: 6, fontFamily: "Inter, system-ui, sans-serif" },
          components: {
            Menu: {
              activeBarBorderWidth: 0,
              itemMarginBlock: 10,
              itemBg: "transparent",
              itemColor: isDarkTheme ? "#cbd5e1" : "#333333",
              itemHoverColor: isDarkTheme ? "#ffffff" : "#111827",
              itemHoverBg: isDarkTheme ? "rgba(255,255,255,0.06)" : "rgba(0,0,0,0.04)",
              itemSelectedColor: isDarkTheme ? "#2285ff" : "#2563eb",
              itemSelectedBg: isDarkTheme ? "rgba(37,99,235,0.18)" : "rgba(37,99,235,0.1)",
              subMenuItemBg: "transparent",
              subMenuItemSelectedColor: isDarkTheme ? "#2285ff" : "#2563eb",
              popupBg: isDarkTheme ? "#1d1d1d" : "#ffffff",
            },
          },
        }}
      >
        {children}
      </ConfigProvider>
    </QueryClientProvider>
  );
}
