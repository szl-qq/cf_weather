# ⛅ cf-weather

商用级天气应用 · **聚合 8 个免费气象数据源** · 推送到 GitHub 自动部署到 Cloudflare Pages

无需 API Key，无需注册，无需自己买服务器。前端 + 后端（Pages Functions）全部跑在 Cloudflare 免费额度上。

---

## 部署方式一：GitHub 自动部署（推荐，本机零配置）

代码推到 GitHub 后，**由 GitHub 的服务器执行部署命令**，你本机什么都不用装。

### 需要做的（一次性，约 3 分钟）

**第 1 步 · 拿到 Cloudflare 的两个值**

打开 [Cloudflare Dashboard](https://dash.cloudflare.com/profile/api-tokens)：

1. 右上角头像 → **My Profile** → **API Tokens** → **Create Token**
2. 选模板 **Edit Cloudflare Workers**（或自定义，需含 `Cloudflare Pages:Edit` 权限）
3. 创建后**复制 Token**（只显示一次）
4. 再复制 **Account ID**：在 Dashboard 首页右侧栏，或任意域名的 Overview 页面右下角

**第 2 步 · 填进 GitHub Secrets**

在你刚创建的 GitHub 仓库页面：

```
Settings → Secrets and variables → Actions → New repository secret
```

添加两条：

| Name | Value |
|------|-------|
| `CLOUDFLARE_API_TOKEN` | 上一步复制的 Token |
| `CLOUDFLARE_ACCOUNT_ID` | 上一步复制的 Account ID |

**第 3 步 · 推送代码**

```bash
git push origin main
```

推送完成即自动部署。进度在仓库的 **Actions** 标签页查看，成功后终端会显示访问地址：

```
https://cf-weather.pages.dev
```

> 以后每次 `git push` 都会自动重新部署，不需要再碰任何配置。

---

## 部署方式二：本地命令行

如果更习惯在本机直接推：

```bash
npm run deploy
```

首次运行会自动安装 `wrangler`、打开浏览器让你登录 Cloudflare，然后完成创建项目与部署。

前置条件：**Node.js 18+**。

---

## 本地开发

```bash
npm install
npm run dev
```

打开 http://localhost:8788 即可预览（同时启动前端和 API）。

---

## 数据源

全部**免费、无需 Key、商用友好**。按优先级自动降级，任一源故障自动切换下一个。

| # | 数据源 | 区域 | 提供 |
|---|--------|------|------|
| 1 | **Open-Meteo** | 全球 | 实时 + 逐小时 + 7 天 + 日出日落 + 紫外线 |
| 2 | **MET Norway** | 全球 | 挪威气象局官方数据 |
| 3 | **wttr.in** | 全球 | 广泛覆盖的备源 |
| 4 | **Bright Sky (DWD)** | 全球 | 德国气象局官方数据 |
| 5 | **7Timer!** | 全球 | 云量 / 观星指数 |
| 6 | **NWS** | 美国 | 美国国家气象局官方数据 |
| — | **Open-Meteo Air Quality** | 全球 | PM2.5 / PM10 / AQI |
| — | **Open-Meteo Geocoding** | 全球 | 城市搜索（中文支持） |
| — | **Cloudflare Edge + ip-api** | 全球 | IP 定位 |

页面底部会显示**当前实际生效的数据源**；发生降级时会明确标注切换情况。

---

## API

| 端点 | 说明 |
|------|------|
| `GET /api/weather?lat=&lon=&name=` | 聚合天气（自动选源） |
| `GET /api/weather?lat=&lon=&source=met-no` | 指定数据源 |
| `GET /api/search?q=上海` | 城市搜索 |
| `GET /api/locate` | 按来访 IP 定位 |
| `GET /api/sources` | 查看所有数据源及优先级 |

响应示例：

```json
{
  "source": "Open-Meteo",
  "location": { "name": "北京", "lat": 39.9, "lon": 116.4, "timezone": "Asia/Shanghai" },
  "current": {
    "temp": 20, "feelsLike": 16, "humidity": 30,
    "text": "晴", "icon": "clear", "wind": 11.6, "windDir": "西南"
  },
  "hourly": [ { "time": "2026-10-05T21:00", "temp": 20, "pop": 0 } ],
  "daily":  [ { "date": "2026-10-05", "max": 25, "min": 11 } ],
  "air":    { "aqi": 99, "level": "良", "pm25": 76 },
  "meta":   { "degraded": false, "fallbackFrom": [] }
}
```

---

## 功能

- **三种视图**：完整（全部数据）/ 精简（核心指标）/ 极简（一屏大字），偏好本地保存
- **城市搜索**：支持中文、英文、拼音，显示行政区与国家
- **IP 定位**：一键定位当前城市
- **动态天空**：背景随天气与昼夜实时变化
- **空气质量**：AQI + PM2.5 / PM10
- **日出日落 / 紫外线**：7 天预报含每日详情
- **矢量图标**：全站内联 SVG，零字体依赖，跨平台一致
- **响应式**：桌面 / 平板 / 手机完整适配
- **无障碍**：语义化标签、ARIA 标注、尊重 `prefers-reduced-motion`

---

## 项目结构

```
cf-weather/
├── .github/workflows/
│   └── deploy.yml          # GitHub Actions：push 后自动部署
├── deploy.mjs              # 本地部署脚本（npm run deploy）
├── wrangler.toml           # Cloudflare Pages 配置
├── package.json
├── functions/
│   └── api/
│       └── [[path]].js     # 后端：8 源聚合 API（自动降级）
└── public/
    ├── index.html          # 前端：单文件应用
    ├── _headers            # 安全响应头
    └── _routes.json        # Functions 路由规则
```

---

## 自定义

**换项目名**：改 `wrangler.toml` 的 `name` 与 `deploy.mjs` 的 `PROJECT`。

**改默认城市**：`public/index.html` 中搜索 `39.9042`（北京坐标）。

**调整源优先级**：`functions/api/[[path]].js` 中的 `FORECAST_SOURCES` 数组，顺序即优先级。

**加自定义域名**：部署后在 Cloudflare 控制台 → Pages → 项目 → Custom domains 添加。

---

## 说明

所有数据源均为公开免费接口，本项目仅做聚合转发与格式统一，不存储任何用户数据。部署产生的流量走 Cloudflare 免费额度（每日 10 万次请求）。

## License

MIT
