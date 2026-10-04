import { theme, type ThemeConfig } from "antd";
import type { AppTheme } from "@/store/useThemeStore";

// CSS owns the palette. Resolve variables to color values because Ant Design's
// theme algorithm also uses them in color calculations (not only CSS output).
export function createAntdTheme(mode: AppTheme): ThemeConfig {
  const styles = getComputedStyle(document.documentElement);
  const color = (name: string) => styles.getPropertyValue(`--app-${name}`).trim();
  const popupShadow = `inset 0 0 0 1px ${color("border-color")}, 0 8px 24px ${color("shadow-color")}`;
  const inputTokens = {
    colorBgContainer: color("input-background"),
    hoverBg: color("input-background"),
    activeBg: color("input-background"),
    hoverBorderColor: color("border-hover-color"),
    activeBorderColor: color("focus-color"),
    activeShadow: `0 0 0 2px ${color("focus-ring-color")}`,
    addonBg: color("selected-background"),
  };
  const antd: ThemeConfig = {
    algorithm: mode === "dark" ? theme.darkAlgorithm : theme.defaultAlgorithm,
    token: {
      colorPrimary: color("primary-color"),
      colorPrimaryBorder: color("focus-color"),
      colorPrimaryBorderHover: color("focus-color"),
      colorBgLayout: color("page-background"),
      colorBgContainer: color("surface-background"),
      colorBgElevated: color("elevated-background"),
      colorBgContainerDisabled: color("hover-background"),
      colorBgMask: color("mask-color"),
      colorText: color("text-color"),
      colorTextHeading: color("heading-color"),
      colorTextSecondary: color("muted-color"),
      colorTextTertiary: color("muted-color"),
      colorTextQuaternary: color("disabled-color"),
      colorTextPlaceholder: color("muted-color"),
      colorTextDisabled: color("disabled-color"),
      colorBorder: color("border-color"),
      colorBorderSecondary: color("border-color"),
      colorSplit: color("border-color"),
      colorFillTertiary: color("hover-background"),
      colorFillQuaternary: color("selected-background"),
      colorLink: color("link-color"),
      colorLinkHover: color("link-hover-color"),
      colorLinkActive: color("link-color"),
      controlItemBgHover: color("hover-background"),
      controlItemBgActive: color("selected-background"),
      controlItemBgActiveHover: color("selected-background"),
      controlOutline: color("focus-ring-color"),
      boxShadow: popupShadow,
      boxShadowSecondary: popupShadow,
      borderRadius: 6,
      fontFamily: "Inter, system-ui, sans-serif",
    },
    components: {
      Menu: {
        activeBarBorderWidth: 0,
        itemMarginBlock: 10,
        itemBg: "transparent",
        itemColor: color("text-color"),
        itemHoverColor: color("heading-color"),
        itemHoverBg: color("hover-background"),
        itemSelectedColor: color("heading-color"),
        itemSelectedBg: color("selected-background"),
        itemActiveBg: color("selected-background"),
        subMenuItemBg: "transparent",
        subMenuItemSelectedColor: color("heading-color"),
        popupBg: color("elevated-background"),
      },
      Card: { headerBg: color("surface-background") },
      Input: inputTokens,
      InputNumber: inputTokens,
      DatePicker: inputTokens,
      Select: {
        selectorBg: color("input-background"),
        hoverBorderColor: color("border-hover-color"),
        activeBorderColor: color("focus-color"),
        activeOutlineColor: color("focus-ring-color"),
        optionActiveBg: color("hover-background"),
        optionSelectedBg: color("selected-background"),
        optionSelectedColor: color("heading-color"),
        multipleItemBg: color("selected-background"),
      },
      Modal: {
        headerBg: color("elevated-background"),
        contentBg: color("elevated-background"),
        footerBg: color("elevated-background"),
      },
      Drawer: { colorBgElevated: color("elevated-background") },
      Tooltip: { colorBgSpotlight: color("elevated-background"), colorTextLightSolid: color("text-color") },
      Tag: { defaultBg: color("selected-background"), defaultColor: color("text-color") },
      Alert: {
        colorInfoBg: color("surface-background"),
        colorInfoBorder: color("border-color"),
        colorInfo: color("link-color"),
      },
    },
  };
  return antd;
}
