import type { DeviceItem } from "@/types/devicesConfig";

export const devicesData: DeviceItem[] = [
  {
    "id": "oneplus-1",
    "name": "OnePlus 13T",
    "brand": "OnePlus",
    "category": "mobile",
    "status": "active",
    "specs": "Gray / 16G + 1TB",
    "description": "Flagship performance, Hasselblad imaging, 80W SuperVOOC.",
    "image": "/images/device/oneplus13t.webp",
    "link": "https://www.oneplus.com/cn/13t"
  },
  {
    "id": "router-1",
    "name": "GL-MT3000",
    "brand": "Router",
    "category": "network",
    "status": "active",
    "specs": "1000Mbps / 2.5G",
    "description": "Portable WiFi 6 router suitable for business trips and home use.",
    "image": "/images/device/mt3000.webp",
    "link": "https://www.gl-inet.cn/products/gl-mt3000/"
  }
];

export function getDevicesList(): DeviceItem[] { return devicesData; }
