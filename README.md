# instabox-keepalive

[InstaBox](https://instabox.sh) 的机器空闲 30 分钟就会自动休眠（`auto-suspend`）。本仓库一个 `keepalive.sh` 搞定保活：用官方 **activity lease** 定期续租，让机器一直醒着；另有 **Cloudflare Worker** 版，不想自己找台常开机器时用；**Docker** 版给 NAS / 群晖 / 1Panel 这类容器环境。三种跑法都支持多账号（多把 key 无限叠加）和 409 自愈（被挂起自动唤醒再续租）。

> **为什么不能直接把休眠关掉**（`autoSuspendAfterSeconds=0`）？2026-10-18 实测：普通/邀请制账号的 `/v1/me` 里有 `"fixedAutoSuspendSeconds": 1800`、`"manualLifecycle": false`，服务端把空闲挂起阈值**锁死在账号级**，因此对 `PATCH /v1/machines/{id}` 传 `autoSuspendAfterSeconds: 0`（或任何值，含官方 `instabox auto-suspend <box> 0` 与 SDK `setAutoSuspend`）**一律被静默忽略**：返回 200，值仍是 1800。所以只能用租约这条官方口子。

> 想用官方 `instabox` CLI 手动建机 / 进机 / 快照 / 开端口——见 [docs/CLI.md](docs/CLI.md)（CLI 操作手册）。

> 为什么不在机器里面跑保活：机器一 suspend，里面的 cron/systemd 定时器全都冻住，谁也叫不醒自己。续租必须来自**外部**、靠那次出网请求带出去 —— 这也是 Worker 版要放到 Cloudflare 的原因；`keepalive.sh` 装在你自己的常开机器上，同样满足。

## 获取账号的 API key

三种跑法都得先有一把 InstaBox 账号的 API key（形如 `ibk_...`）——下面命令里的 `ibk_xxx` 都指它。key 不是脚本生成的，要在 InstaBox 网页控制台里创建，入口藏得有点深：

1. 打开 [instabox.sh](https://instabox.sh)，用 GitHub 或 Google 登录进控制台
2. 点右上角**账号菜单 → Profile → API keys**
3. 点 **Create Key**，权限二选一：
   - **Full access** —— 全权限，省事
   - **Restricted** —— 自己勾 scope；**只做保活用 `machines:write` 就够**（write 含 read；`machines:delete`、`images:*` 都不需要）
4. 建完**立刻复制**：key 只在创建时显示一次，弹窗关了网页上再也看不到，丢了只能删掉重建

几个容易踩的点：

- key 长这样 `ibk_...`；GitHub/Google 登录只用来进控制台和建 key，**不能拿登录态当 key 用**
- 一把 key 对应一个账号。多个账号就建多把，安装时逗号连起来：`key=ibk_aaa,ibk_bbb`
- key 泄露或要换：到同一个 **API keys** 页面 revoke 旧的、建新的，然后改本机 `.env`（见下文）
- 官方文档：<https://instabox.sh/docs/keys-sdk>

## VPS 版 keepalive.sh：一键安装

把脚本装到任何一台常开的机器（VPS/NAS/路由器），cron/systemd 定时续租，也支持多账号：

```sh
# 保活名下全部机器（有几台保几台，机器名都不用填）
key=ibk_xxx bash <(curl -Ls https://raw.githubusercontent.com/pingmike2/instabox-keepalive/main/keepalive.sh)

# 只保某一台
key=ibk_xxx machine=qqq bash <(curl -Ls https://raw.githubusercontent.com/pingmike2/instabox-keepalive/main/keepalive.sh)

# 非 root： curl -Ls <同一个地址> | sudo -E env key=ibk_xxx machine=qqq sh

# 多账号：key 逗号分隔多把，每把 key 各保各的，无限叠加、单个也能跑
key=ibk_aaa,ibk_bbb,ibk_ccc bash <(curl -Ls https://raw.githubusercontent.com/pingmike2/instabox-keepalive/main/keepalive.sh)
```

就一个文件：不带参数＝安装/更新，`uninstall`＝卸载，`--once` / `--watch` / `--status` / `--release`＝手动用，`--help` 看全部参数。装完会立刻做一次续租自检，失败就不装；服务形式按系统自动挑 **systemd → OpenRC → cron**。

想升级直接再跑一次安装命令（按现有 `.env` 重装，key 不会丢）；以后加账号就是往 `.env` 的 `INSTABOX_API_KEY` 后面续 `,ibk_xxx`。

**机器筛选**

- 不填 `machine`（推荐）：脚本用你的 key 调 `GET /v1/machines` 自己列出名下所有机器，全部保活，新加机器下一轮自动跟上
- 填 `machine=qqq` 只保这一台；也可以填机器 id（`m_...`）；`machine=all` 和不填一样
- 多把 key 时 `machine` 对每把 key 各自生效（比如 `machine=qqq` 就是每把 key 各保自己名下的 `qqq`）

**日常**

```sh
sh /root/instabox-keepalive/keepalive.sh --status    # 机器状态（不填机器=全部）
sh /root/instabox-keepalive/keepalive.sh --once      # 手动续一次
sh /root/instabox-keepalive/keepalive.sh --release   # 放掉租约，恢复空闲休眠
sh /root/instabox-keepalive/keepalive.sh uninstall   # 彻底卸载（停服务、删 unit、清 cron、放租约、删目录）
```

**变量**（`.env` 或安装环境变量；`--dir` 默认 `/root/instabox-keepalive`，`--service` 默认 `instabox-keepalive`，还有 `--lease` `--ttl` `--raw` `--cron` `--no-start`）

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `INSTABOX_API_KEY` | 无（必填） | `ibk_...`，多把逗号分隔 |
| `INSTABOX_MACHINE` | 空＝全部 | 机器名 / id / `all` |
| `INSTABOX_LEASE` | `keepalive` | 租约名 |
| `INSTABOX_LEASE_TTL` | `300` | 秒，30–3600 |
| `INSTABOX_RENEW_EVERY` | `0.6 × ttl` | 续租间隔 |
| `INSTABOX_AUTO_RESUME` | `1` | 遇 409 先 resume（stopped 用 start 兜底）再续；`0` 只报错不唤醒 |
| `INSTABOX_WAKE_GAP` / `INSTABOX_WAKE_TRIES` | `5` / `3` | 唤醒后轮询间隔/次数 |
| `INSTABOX_API_URL` | `https://api.instabox.sh` | 换私有网关时才用 |

**密钥安全**：key 只落本机 `<安装目录>/.env`（0600，不进进程列表）；安装时 key 会出现在命令行一次，装完记得 `history -c`；建议只用 `machines:write` 权限的 key。

## 多个账号（三种跑法通用）

每个账号要一把**各自独立**的 key——都在同一个 **Profile → API keys** 页面里分别 Create Key（换台账号就先用那个账号登录一次网页建 key，见上文《获取账号的 API key》）。

`keepalive.sh` 和 Worker 都支持多账号：**第 N 个账号的变量名 = 单账号变量名 + `_N` 后缀**（脚本里也可以直接 `key=ibk_aaa,ibk_bbb`）。

| 1 号账号（和单账号完全一样） | 2 号账号 | 说明 |
| --- | --- | --- |
| `INSTABOX_API_KEY` | `INSTABOX_API_KEY_2` | **Secret**，必填 |
| `INSTABOX_MACHINE` | `INSTABOX_MACHINE_2` | 可选，留空 = 该账号全部机器 |
| `INSTABOX_LEASE` | `INSTABOX_LEASE_2` | 可选，默认 `keepalive` |
| `INSTABOX_LEASE_TTL` | `INSTABOX_LEASE_TTL_2` | 可选，默认 `900` |
| `INSTABOX_AUTO_RESUME` | `INSTABOX_AUTO_RESUME_2` | 可选，默认 `1` |

- 加一个账号 = 往 `INSTABOX_API_KEY` 里续 `,ibk_xxx`（脚本和 Worker 同款写法），或面板上加一个 `INSTABOX_API_KEY_2` Secret
- 带后缀的优先，没写的自动继承不带后缀的全局值；`INSTABOX_MACHINE` 也会继承，所以两个账号机器名不一样时记得写 `INSTABOX_MACHINE_2`
- 编号可以不连续（只配 `_2` 也能跑）；`INSTABOX_API_KEY_1` 等同于 `INSTABOX_API_KEY`
- 同一把 key 配了两次只续一次
- **一个变量塞多把也行（推荐，无限叠加）**：`INSTABOX_API_KEY = "ibk_aaa,ibk_bbb,ibk_ccc"`（逗号分隔）→ 自动按顺序当 1、2、3 号账号，加账号就是往里续一段 `,ibk_xxx`。两种写法混着用也行：显式 `_N` 变量永远占自己的编号，多出来的往外推空位（比如 `INSTABOX_API_KEY="kA,kB"` 且 `_2=kX` → 1=kA、2=kX、3=kB）。单把 key 的老用法不变
- 每个账号的机器列表分开缓存、分开续租：某个账号 key 失效或机器被挂起，不影响其它账号
- `/accounts` 看现在认到了几个账号（key 打码）；`?account=2` 只操作 2 号（`/`、`/status`、`/release` 都支持）

**Worker 侧补充**（只对 Worker 生效；VPS 版没有 KV 和子请求限制）

- KV 绑定不用动：还是 `LOG`、还是每小时最多 1 条，多账号只是让每条日志里多几个 `account` 编号
- 免费版 Worker 每次调用最多 50 个子请求：一个账号大约「1 次列机器 + 每台 1 次续租」，账号/机器多的时候别超（付费版 1000 次）

**配置示例：三把 key，其它全用全局值（Worker 面板）**

面板 `Variables and Secrets` 里最终就这几条（key 和 token 都是 Secret）：

| 变量 | 类型 | 值 |
| --- | --- | --- |
| `INSTABOX_API_KEY` | Secret | `ibk_aaa…`（1 号账号） |
| `INSTABOX_API_KEY_2` | Secret | `ibk_bbb…`（2 号账号） |
| `INSTABOX_API_KEY_3` | Secret | `ibk_ccc…`（3 号账号） |
| `TOKEN` | Secret | 自己起一串随机值，例如 `openssl rand -hex 16` 的输出 |
| `INSTABOX_LEASE_TTL` | Text | `900` |
| `INSTABOX_LOG_MODE` | Text | `hourly` |

`INSTABOX_MACHINE` / `INSTABOX_LEASE` / `INSTABOX_AUTO_RESUME` 都不写，效果就是：每个账号保活自己名下**全部机器**、租约名 `keepalive`、碰到挂起/停掉自动唤醒。

**懒人写法（推荐）**：三种等价 —— 要几个加几个。

```sh
# 单变量塞多把（推荐）：加账号就是往里续 ",ibk_xxx"
INSTABOX_API_KEY = ibk_aaa,ibk_bbb,ibk_ccc
# 或每把一个 secret（老写法，效果一样）
INSTABOX_API_KEY   = ibk_aaa
INSTABOX_API_KEY_2 = ibk_bbb
INSTABOX_API_KEY_3 = ibk_ccc
# 或混着用（显式 _N 的编号优先，多出来的往外推空位）
INSTABOX_API_KEY   = ibk_aaa,ibk_bbb
INSTABOX_API_KEY_2 = ibk_xxx      # 占死 2 号位；任务变成 1=aaa 2=xxx 3=bbb
```

反过来，如果几个账号都只想保活同名的那台机器（比如都叫 `qqq`）：Worker 只写 `INSTABOX_MACHINE=qqq`，脚本写 `machine=qqq`，所有账号都会继承这个筛选。

## Docker 部署（NAS / 群晖 / 1Panel）

宿主机不想装东西就丢进容器：镜像里装的就是这个仓库的 `keepalive.sh`。

```sh
cd docker
cp .env.example .env && chmod 600 .env   # 填 INSTABOX_API_KEY=ibk_xxx
docker compose up -d --build
docker compose logs -f
```

变量名、多账号写法和 VPS 版完全一致，一份 `.env` 两边通用；`--status` / `--once` / `--release` 也能当一次性命令跑：

```sh
docker compose run --rm instabox-keepalive --status
```

## Cloudflare Worker 部署（附加方案）

没有常开的机器也不影响保活：把续租放到 Cloudflare Worker 上，cron 每 5 分钟自动跑一次，和你的任何机器无关。推荐网页面板部署（不用装 wrangler），想用命令行看最后面的《CLI 部署》。

### 部署步骤

1. Cloudflare 面板 → `Workers & Pages` → `Create` → `Worker` → 起个名字（例如 `instabox-keepalive`）→ `Deploy`
2. `Edit code`，把 `worker/worker.js` 的内容整段粘进去（覆盖默认代码）→ `Deploy`
3. `Settings` → `Variables and Secrets`，加这几条（`INSTABOX_API_KEY` 多账号写法见《多个账号》）：

   | 变量 | 类型 | 值 |
   | --- | --- | --- |
   | `INSTABOX_API_KEY` | **Secret（加密）** | 你的 `ibk_...`（多账号见下面《多个账号》） |
   | `TOKEN` | Secret（自己起一串随机值） | 之后所有请求都要带 `?token=` |
   | `INSTABOX_MACHINE` | Text | 留空 = 保活该 key 名下全部机器；填 `qqq` 只保一台（多台用逗号分隔） |
   | `INSTABOX_LEASE` | Text | `keepalive`（可选） |
   | `INSTABOX_LEASE_TTL` | Text | `900`（建议；不填默认 300，会比 cron 间隔小） |
   | `INSTABOX_LOG_MODE` | Text | `hourly`（默认）/ `every` / `off`，控制写 KV 的频次 |
   | `INSTABOX_AUTO_RESUME` | Text | `1`（默认）。机器被平台挂起/停掉时，先 `resume`（stopped 用 `start` 兜底）再续租；设 `0` 只报错不唤醒 |
   | `INSTABOX_API_URL` | Text | `https://api.instabox.sh`（换私有网关时才用加这个变量） |

   > `TOKEN` 强烈建议一定要设：不设的话，任何知道你 Worker 域名的人都能触发续租/释放。
   > `INSTABOX_LEASE_TTL` 要比 cron 间隔大：cron 是 5 分钟，填 `900` 有 3 倍余量。
4. `Settings` → `Triggers` → `Cron Triggers` → `Add Cron Trigger`，填 `*/5 * * * *`（每 5 分钟）→ 保存。这就是自动保活的开关
5. 想看 `/log`：`Storage & Databases` → `KV` → `Create namespace`，然后在 Worker 的 `Settings` → `Bindings` 里加一个 KV 绑定，**变量名填 `LOG`**、选刚建的空间。不绑也能用，只是 `/log` 是空的

部署完打开 `/accounts?token=...`，看到 `#1`、`#2`、`#3` 三行（key 打码）就说明三把 key 都认到了；再打开 `/status?token=...` 看每个账号下的机器。

**机器筛选**

- 不填 `INSTABOX_MACHINE`（推荐）：Worker 用你的 key 调 `GET /v1/machines` 自己列出名下所有机器，全部保活 —— 一个账号默认 支持多台，新加机器下一轮自动跟上
- 填 `qqq` 只保这一台；也可以填机器 id（`m_...`）；多台用逗号分隔，例如 `qqq,box2`
- 机器名由你创建机器时指定（`instabox ls` 或网页面板都能看到）
- 租约是**每台机器各一份**，名字相同也不会互相干扰

## 机器被挂起/停掉会怎样

续租对 `suspended` / `stopped` 的机器一律回 `409 machine_not_running`——光续租是空转，机器不会自己醒。默认 `INSTABOX_AUTO_RESUME=1`：碰到这个错就先 `POST /resume`（`stopped` 的用 `/start` 兜底），等它变成 `running` 再立刻续租；日志里这条会带 `"resumed":true` 和 `"wake":["resume:202"]`。设成 `0` 就只报错、不唤醒。

## 停机检修轮转（Worker 版默认开）

机器长期不重启会撞上平台的「最长运行」冷却；Worker 现在默认带**检修轮转**：到点主动把机器 suspend 再 resume，一分钟一台、错开进行，避开你的使用高峰。

- 默认时间表（本地时间 `Asia/Shanghai`）：`01:30 / 08:00 / 13:00 / 19:00`，到点后 30 分钟内允许触发，同一个点每台只转一次
- 连续运行**剩 20 分钟**到上限时兜底轮转（`INSTABOX_CYCLE_MARGIN_MIN` 可调，0 = 关掉兜底只按时间点）
- **只续租、绝不主动重启**（回到旧行为）：加一个 Text 变量 `INSTABOX_CYCLE = "0"`
- 懒人版自动排点：`INSTABOX_PEAK_HOURS = "10-12,14-18,20-23"`，Worker 自己把重启点排进空档
- 随机抖动（默认关）：`INSTABOX_CYCLE_JITTER_MIN`（开始时间）、`INSTABOX_CYCLE_HOLD_SEC`（停机时长）、`INSTABOX_WAKE_JITTER_MIN`（平台冷却后额外等待）
- 多账号可单独覆盖：`INSTABOX_CYCLE_2`、`INSTABOX_CYCLE_MARGIN_MIN_2`…（同 `_N` 后缀规则）
- `/status` 里能看到每台的 `nextCycle`（下次轮转时间）；`CYCLE=0` 却配了时间点时会有 `cycleWarning` 提示

## 接口

```
https://<你的worker>.workers.dev/?token=xxx                   所有账号各续租一次
https://<你的worker>.workers.dev/status?token=xxx             所有账号的机器状态
https://<你的worker>.workers.dev/accounts?token=xxx           配了哪些账号（key 打码）
https://<你的worker>.workers.dev/log?token=xxx                最近 48 条保活日志
https://<你的worker>.workers.dev/log?token=xxx&format=text    纯文本，方便 grep
https://<你的worker>.workers.dev/release?token=xxx            放掉租约
https://<你的worker>.workers.dev/status?token=xxx&account=2   只看 2 号账号（/、/release 同样支持）
```

`?token=` 就是上面那个 `TOKEN` 变量；设了就必须带，不带返回 `401 token 不对`。不带 `format=text` 时返回 JSON，任何路由都能加 `&format=text` 看纯文本。cron 跑的结果和 `/` 一样，也写进 `/log`（绑了 KV 才有），每条记着时间、租约、几台、每台到期时间；多账号时每台机器还带 `account` 编号（`1`、`2`…）。

## KV 额度够不够

免费版 KV 每天 1000 次写、10 万次读。默认 `hourly` 模式下，同一小时的连续成功只写 1 条：每天约 24 次写（失败会立刻写，不受去重影响），占额度 2.4%，怎么跑都不会满。手动 `/?token=` 触发一定写日志，不参与去重。

多账号不会增加写次数：一条日志装的是所有账号的汇总，`hourly` 模式下仍然每小时最多 1 条，额度算法和单账号完全一样。KV 绑定名、namespace、`log` 这个 key 也都不用改。

| cron 间隔 | 次数/天 | `every` 模式写/天 | `hourly` 模式写/天 |
| --- | --- | --- | --- |
| `*/5` | 288 | 288 | ~24 |
| `*/4` | 360 | 360 | ~24 |
| `* * * * *` | 1440 | **1440（超了）** | ~24 |

也就是说：间隔 4 分钟以上用默认值随便跑；间隔 1 分钟的 `every` 会超额度，这时候要么留 `hourly`，要么把 `INSTABOX_LOG_MODE` 设成 `off` 完全不写。

## CLI 部署（可选，用 wrangler）

多账号（`worker/wrangler.toml` 里已带 cron 和 `INSTABOX_LEASE_TTL=900`）：

```sh
cd worker
npx wrangler secret put INSTABOX_API_KEY       # 1 号账号（key 只进 secret，不写进 wrangler.toml）
npx wrangler secret put INSTABOX_API_KEY_2     # 2 号账号，要几个加几个
npx wrangler secret put TOKEN
npx wrangler deploy
```

`worker/wrangler.toml` 里已经设好 `crons = ["*/5 * * * *"]` 和 `INSTABOX_LEASE_TTL = "900"`，按需改就行。

## 致谢

| 项目 | 在本项目里干什么活 |
| --- | --- |
| [InstaBox](https://instabox.sh) | 提供机器与官方 `activity lease` 接口，[文档](https://instabox.sh/docs/keys-sdk)里写清了 key 与租约用法 |
| [jyucoeng/instabox-keepalive](https://github.com/jyucoeng/instabox-keepalive) | 早期 Worker 版的多账号实现，本项目在其基础上合并了 VPS 版与 409 自愈 |

## 免责声明

仅用于管理你自己账号下的 InstaBox 机器。请自行确认每把 key 的权限范围与所在机器的可信程度 —— Worker 能读到这些 key，能读到它们的人也能操作你的机器。使用本项目产生的一切后果由使用者自行承担。

## License

[MIT](./LICENSE) © 2026 [pingmike2](https://github.com/pingmike2)
