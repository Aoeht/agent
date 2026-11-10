// src/utils/browser_device.ts
// 采证形态是采证参数，不是浏览器启动细节：移动端专用的落地页在桌面 UA/视口下
// 只会返回“请在手机/微信内打开”的占位页，换 UA 与视口才是拿到真实内容的前提。

export type BrowserDevice = "desktop" | "mobile" | "wechat";

export function parseBrowserDevice(value: string | undefined): BrowserDevice {
  const normalized = (value ?? "").trim().toLowerCase();
  return normalized === "mobile" || normalized === "wechat" ? normalized : "desktop";
}

const ANDROID_UA =
  "Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36";
// 微信内置浏览器的识别靠 MicroMessenger；只认微信 UA 的 H5 页在普通移动 UA 下仍是占位页
const WECHAT_UA = `${ANDROID_UA} MicroMessenger/8.0.49.2600(0x28003133) NetType/WIFI Language/zh_CN`;

export interface BrowserContextOptions {
  viewport: { width: number; height: number };
  locale: string;
  deviceScaleFactor?: number;
  isMobile?: boolean;
  hasTouch?: boolean;
  userAgent?: string;
}

/** 桌面形态保持原样（Edge 自带 UA）；移动形态固定 Android Chrome，避免 iOS UA 把站点引到 Safari 专用流程。 */
export function browserContextOptions(device: BrowserDevice): BrowserContextOptions {
  if (device === "desktop") {
    return { viewport: { width: 1280, height: 900 }, locale: "zh-CN" };
  }
  return {
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
    locale: "zh-CN",
    userAgent: device === "wechat" ? WECHAT_UA : ANDROID_UA,
  };
}

/** HTTP 采证的 UA 也跟随形态：只认移动 UA 的站点，静态抓取才能拿到与移动端一致的内容。 */
export function httpUserAgent(device: BrowserDevice, desktopUserAgent: string): string {
  if (device === "mobile") return ANDROID_UA;
  if (device === "wechat") return WECHAT_UA;
  return desktopUserAgent;
}
