# docs/ · 项目物料

| 路径 | 用途 |
|---|---|
| `screenshots/*.png` | README 展示截图（玻璃主题 / 烛夜私语 / 设置面板） |
| `social-preview.png` | GitHub 社交预览图（1280×640，仓库 Settings → Social preview 手动上传） |
| `icons/icon-b-chat-bubble.svg` | 应用图标源文件（`public/assets/icon-*.png` 由它导出） |
| `icons/icon-a-double-bubble.svg` \| `icons/icon-c-keyhole.svg` | 另两版候选方案（未采用，留档） |

## 截图说明与素材致谢

截图中作为聊天背景的两张照片**不随仓库分发**（只出现在截图像素里），均为可自由使用的授权：

- `screenshots/chat-glass.png`、`screenshots/settings.png`：*Misty Morning Sunrise, Lake Andes National Wildlife Refuge* —— **Public domain**（US Fish & Wildlife Service，via Wikimedia Commons）。
- `screenshots/chat-candle.png`、`social-preview.png`：*Stars and Milky Way over Åbyfjorden 8* —— **CC0**（via Wikimedia Commons）。

## 图标重生成

编辑 `icons/icon-b-chat-bubble.svg` 后重新导出五个尺寸（任意 SVG 工具 / 浏览器均可）：

```
public/assets/icon-512.png      512×512
public/assets/icon-192.png      192×192
public/assets/apple-touch-icon.png 180×180
public/assets/favicon-32.png    32×32（无点简化版，小尺寸更清晰）
public/assets/favicon-16.png    16×16
```

Tauri / 安卓图标由 CI 从 `public/assets/icon-512.png` 自动生成，无需手工维护。
