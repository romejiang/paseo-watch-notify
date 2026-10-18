# 国内网关部署（China-mainland gateway）

`services/gateway` 是一个**纯 Node.js 服务**：**运行时零 npm 依赖**，只用 Node 内置模块
（`node:http` / `node:http2` / `node:crypto` / `node:fs` / `node:net` / `node:path`）。
所以 Docker、PM2、systemd 都能跑。构建只用到 `typescript`（devDependency）。

## 需要什么

| 项 | 建议 |
| --- | --- |
| 运行时 | **Node.js 20+**（推荐 22 LTS） |
| CPU / 内存 | **1 vCPU / 512MB** 起（1GB 更稳）——它就是个小小的转发器 |
| 磁盘 | 10GB（设备表 `devices.json` 很小） |
| 出网 | 需要访问 **`api.push.apple.com`** / `api.sandbox.push.apple.com`（HTTP/2 + 443） |
| 入网 | 443（由你的反代终结 TLS 后转发到 `127.0.0.1:8787`） |
| 持久化 | `DEVICES_FILE` 指向的目录要**持久**（容器要挂 volume） |
| 密钥 | Apple 的 `.p8` 放服务器上，**只读挂载**，不要打进镜像 |

> 大陆服务器上，`api.push.apple.com` 是可达的（苹果推送在中国大陆正常可用），所以国内网关可以正常推送。

## 一键部署脚本（推荐）

`deploy/deploy-remote.sh` 会把网关部署到远端并交给 PM2 管理（本地构建 → 只传 `dist/`）：

```bash
cd services/gateway
./deploy/deploy-remote.sh
```

可用环境变量覆盖默认值：

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `SSH_HOST` | `yang` | 目标 SSH |
| `REMOTE_DIR` | `/root/paseo-notify-gateway` | 远端目录 |
| `APP_NAME` | `paseo-notify-gateway` | PM2 应用名 |
| `NODE_BIN` | `/root/.nvm/versions/node/v20.20.2/bin/node` | 用哪个 Node 跑 |
| `PM2_BIN` | `/root/.nvm/versions/node/v20.20.2/bin/pm2` | 用哪个 pm2 |

脚本会：本地 `npm ci && npm run build` → `rsync dist/` → 若 `.env` 不存在则从模板生成并**停下让你填** →
若 `secrets/AuthKey.p8` 不存在则提示上传 → `pm2 start/reload --interpreter <NODE_BIN> --update-env` → `pm2 save` → `curl /healthz`。

> 非交互 SSH 没有 nvm 的 PATH，所以脚本用**绝对路径**调用 node/pm2；并且用 `--interpreter` 把应用
> **锁定在你指定的 Node 版本**（守护进程本身跑在 v25 也没关系）。

## 方式一：Docker（备选）

```bash
# 1) 取代码（只需 services/gateway）
git clone https://github.com/romejiang/paseo-watch-notify.git
cd paseo-watch-notify/services/gateway

# 2) 准备配置与密钥
cp deploy/gateway.env.example .env      # 填 APNS_KEY_ID / APNS_TEAM_ID（注意：没有网关级 token）
mkdir -p data secrets
cp /path/AuthKey_XXXXXXXXXX.p8 secrets/AuthKey.p8

# 3) 启动（只监听 127.0.0.1:8787，反代由你配）
docker compose up -d --build
curl -s http://127.0.0.1:8787/healthz   # => {"ok":true}
```

## 方式二：systemd（最省资源）

```bash
# 1) 构建
cd /opt/paseo-notify-gateway
npm ci --ignore-scripts && npm run build

# 2) 用户与目录
sudo useradd --system --home /opt/paseo-notify-gateway --shell /usr/sbin/nologin paseo-notify
sudo mkdir -p /etc/paseo-notify /var/lib/paseo-notify
sudo chown -R paseo-notify:paseo-notify /var/lib/paseo-notify /opt/paseo-notify-gateway
sudo cp deploy/gateway.env.example /etc/paseo-notify/gateway.env   # 填值
sudo chmod 600 /etc/paseo-notify/gateway.env

# 3) .p8 放到 /etc/paseo-notify/ ，env 里 APNS_KEY_PATH 指向它
# 4) 安装服务
sudo cp deploy/paseo-notify-gateway.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now paseo-notify-gateway
systemctl status paseo-notify-gateway
curl -s http://127.0.0.1:8787/healthz
```

## 方式三：PM2

```bash
npm ci --ignore-scripts && npm run build
pm2 start dist/index.js --name paseo-notify-gateway
pm2 save && pm2 startup
```

## 反代与 HTTPS（你自己配）

反代把 `https://notify.everythingisnumber.cn` 转发到 `127.0.0.1:8787`。
Caddy 示例：

```
notify.everythingisnumber.cn {
    reverse_proxy 127.0.0.1:8787
}
```

Nginx 示例：

```nginx
server {
    listen 443 ssl;
    server_name notify.everythingisnumber.cn;
    # ssl_certificate ...; ssl_certificate_key ...;
    location / {
        proxy_pass http://127.0.0.1:8787;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    }
}
```

## 限流

内置**零依赖**的内存固定窗口限流（无需 Redis）：

| 环境变量 | 默认 | 说明 |
| --- | --- | --- |
| `RATE_LIMIT_ENABLED` | `1` | 是否开启 |
| `RATE_LIMIT_PER_CHANNEL` | `60` | 每个**渠道密钥**每窗口可请求次数（真正的保护：一个用户刷不影响别人） |
| `RATE_LIMIT_PER_IP` | `120` | 每个 **IP** 每窗口可请求次数（挡未鉴权的洪水） |
| `RATE_LIMIT_WINDOW_MS` | `60000` | 窗口长度（毫秒） |

超限返回 **HTTP 429** + `Retry-After` 头。按 IP 那条依赖反代传 `X-Forwarded-For`（Caddy/Nginx 默认会带）。

## 验证

```bash
curl -s https://notify.everythingisnumber.cn/healthz
# => {"ok":true}
```

然后在 iPhone App 里点「**重新检测网关**」，状态行应变成
`网关可用：https://notify.everythingisnumber.cn`，再点「**复制配置**」把地址 + 密钥粘到 Paseo 插件。

## 多租户（重要）

这是个**给所有用户用的公共网关**，所以**没有「网关级 token」**：

- `/api/notify` 与 `/api/devices` 的 `Authorization: Bearer <...>` **就是该用户自己的渠道密钥**
  （即 App 里生成的 `pn_...`）；
- 设备按 `sha256(渠道密钥)` 分渠道存储，**每个用户只会看到/推送到自己的设备**；
- 与 Cloudflare 上的全球网关**同一套模型**，同一个密钥在两边都有效（但设备表各自独立）。

## 说明

- **设备表是独立的**：这台国内网关与 Cloudflare 上的全球网关各存一份设备表。手表注册到哪台，
  插件就必须发到**同一台**。用 App 的「复制配置」保证两边地址一致，就不会踩坑。
- `APNS_ENV` 只是兜底默认；设备注册时会带上自己的环境（Debug 构建 = sandbox，App Store 构建 = production），
  网关按设备记录的环境决定发往 sandbox 还是正式。因此 `Sandbox & Production` 的那把 Key 两边都能用。
- 不要提交 `.p8`、`.env`、`data/`（仓库的 `.gitignore` 已忽略）。
