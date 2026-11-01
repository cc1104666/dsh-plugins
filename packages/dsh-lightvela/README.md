# dsh-lightvela

把 **LightVela（lightvela.com）** 套餐里的模型，接管进 DSH 的模型选择器。

登录方式：微信扫码。支持**多账号**——扫几个号就存几个号，某个号积分用尽时
自动换下一个，对话不中断。花的是你套餐里的 **AI 积分**。

---

## 为什么要在本机转一手

上一版这个插件是「直连网关」的：把 `baseURL + key` 写进 `llm-pi-ai`，DSH 自己
把请求发去 `https://token.lightvela.com/v1`，中间什么都不经过。简单，但有个死穴：

> **额度用尽时网关返回 402，而插件那时候根本不在请求链路里** —— 这一轮对话
> 已经废了，插件没有任何机会换钥匙重试。

所以要多账号自动切换，就必须让请求先经过一个自己人。现在插件会在
`127.0.0.1` 上起一个**纯透传**的转发器（默认 43700 起，被占就顺延），
`llm-pi-ai` 的 `baseURL` 指向它：

```
DSH ──► 127.0.0.1:43700/v1 ──► token.lightvela.com/v1
              │
              └─ 在这层挑账号：当前 → 备用 → 没额度的
```

它**不是反代**：不翻译协议、不改请求体、不改响应体，SSE 也原样透传。
它唯一多做的事，就是换个 `Authorization` 再发一次。

> 只监听 `127.0.0.1`，不对外。转发器起不来时插件会退回直连网关 ——
> 那样还是能用，只是不会自动换账号（面板上会写明）。

---

## 多账号与额度用尽自动切换

`auth.json` 存的是一个账号池（v2；老的单账号文件会自动迁移，不用重扫）：

```json
{
  "version": 2,
  "activeId": "usr_xxx",
  "accounts": [
    { "id": "usr_xxx", "label": "主号", "apiKey": "sk-…", "quotaStatus": "ok", … },
    { "id": "usr_yyy", "label": "备用号", "apiKey": "sk-…", "quotaStatus": "exhausted",
      "quotaNote": "Insufficient credits（HTTP 402）" }
  ]
}
```

**加账号**：在面板 ① 里再扫一个**不同的**微信号就行（同一个微信重复扫只会刷新
它自己那条记录，不会变成两个号）。扫完插件会自动找实例、把钥匙拉回来。

**切换规则**（`lib/relay.js` + `store.candidates()`）：

| 上游返回 | 判定 | 处理 |
|---|---|---|
| `402` | 这个号没额度了 | 标成 `exhausted`，换下一个号重试 |
| `401` | 钥匙失效（实例重建过） | 标成 `error`，换下一个号重试 |
| `429` | 被限流 | 换下一个号重试，但**不标死** —— 下一条还能用它 |
| 其它 `4xx` | 参数/模型不对 | 直接回给 DSH，换号也没用 |

换成功之后 `activeId` 会跟着变，所以「当前账号」永远是最近真正出过字的那个。
面板 ② 里能看到每个号的状态，也能手动切、改名、重拉钥匙、删号、清掉
「没额度」标记（充完钱想立刻再用）。

> 全都没额度时不硬拦：转发器还是会把每个号试一遍，最后把真实的 402 报文
> 回给 DSH —— 至少你知道是额度问题，不是插件坏了。

---

## 真麻烦的部分：key 从哪来

LightVela 卖的**不是**模型 API，是「云上帮你跑一个 Hermes Agent 的实例」。
模型额度由平台代付（套餐里的 AI 积分），它**没有任何对外发 API Key 的接口**：

| 试过的路 | 结果 |
|---|---|
| `/v1/models`、`/v1/chat/completions` | 404，它压根不提供 |
| 登录后的 JWT / cookie 直接打网关 | 401 invalid bearer token |
| 复用实例的会话去调模型 | 对话走腾讯云 IM（sdkappid 1600167838），不是 REST |
| 游客模式 `/auth/guest` | 401，官方自己都登不进 |

箱子只有一个口子：实例沙箱里有一把 `CUSTOM_API_KEY`，那是 Hermes 调模型时
真正用的钥匙。所以插件做的事是：

```
扫码登录（拿 lc_session）
  → GET  /v1/instances                    找到在跑的那个实例
  → POST /v1/instances/{id}/debug/exec    进沙箱读 ~/.hermes/.env
  → 拿到 CUSTOM_API_KEY + config.yaml 里的 model.base_url
  → 打一发探针确认能出字
  → 写进 llm-pi-ai 的 providers.lightvela
```

`/debug/exec` 是 LightVela 自己的前端在用的调试通道（打开对话页就能看到它在
跑 `SOUL.md` 相关的 shell），鉴权和网页登录态一致，不是什么后门。

**注意**：钥匙跟着实例走。实例重建 / 换 Bot 之后要重新拉一次 —— 面板上
「② 模型钥匙 → 重新拉取」就是干这个的。

---

## 它是怎么扫码的

不是公众号带参二维码（那是 RunningHub 那套），这里是**微信开放平台网页应用
授权**（`snsapi_login`）：

```
1. GET  api.lightvela.com/auth/oauth/wechat/start
        → 307 到 open.weixin.qq.com，同时下发 4 个只用于回调路径的 cookie
          （lc_wechat_oauth_state / _mode / _scope / _return_to）
2. 请求那个 307 地址，页面 HTML 里带 connect/qrcode/<uuid>
3. 二维码 = https://open.weixin.qq.com/connect/qrcode/<uuid>
4. 长轮询 https://lp.open.weixin.qq.com/connect/l/qrconnect?uuid=<uuid>
        wx_errcode = 408 超时（继续轮）| 405 已扫待确认 | 403 已取消 | 0 成功 + wx_code
5. 拿 code + state 打 /auth/oauth/wechat/callback，**带上第 1 步那 4 个 cookie**
        → 站点下发 lc_session
```

第 5 步必须带那 4 个 cookie：服务端把 `state` 存在 cookie 里做 CSRF 校验，
只给 query 里的 `state` 匹配不上。

整个过程在宿主端跑完，不弹浏览器、不用复制 cookie。

---

## 安装

```bash
# 1. 把包放进 profile 的 node_modules
cp -r dsh-lightvela ~/.dsh/profiles/desktop/node_modules/

# 2. 登记到 profile（dependencies + dsh.profile.bundles 各加一条）
#    或者在 ~/.dsh/profiles/desktop/package.json 里手工加：
#      "dependencies":       { "dsh-lightvela": "file:<本目录绝对路径>" }
#      "dsh.profile.bundles": [ ..., "dsh-lightvela" ]

# 3. 重启 DSH（宿主半区不热更）
```

重启后，聊天框下方会出现一个 **LightVela** 胶囊；插件页里也有一张同款卡片。

---

## 用起来

1. 点「生成二维码」→ 微信扫 → 手机上点确认。**首次授权会自动建号**，直接扫就行。
2. 登录成功后插件会自己找实例、把钥匙拉回来（面板 ② 账号池里会显示实例名）。
3. 想加第二个号：再点一次「再扫一个号」，扫另一个微信号。**同一个微信重复扫不会变两个号**。
4. 点 ④ 的「读清单」→「逐个探测」→「注册」。
5. **刷新 DSH 页面**，模型选择器里就多出「LightVela」这一组。

想在注册前先确认这条链路通不通，用 ⑤ 的「试一句」。

---

## 邀请归因（拉新返积分）

LightVela 是邀请制返利：新账号在**微信授权回调那一刻**若带着 `lc_referral_context`
cookie，就记到邀请人名下。站点前端做的事只有两步：

```
GET  /v1/referrals/codes/{CODE}   校验这个码还在活动期内
POST /auth/referral/prepare       种 lc_referral_context（Path=/auth，30 分钟）
```

关键在于这两步**不依赖浏览器** —— 归因只看回调那一发请求带没带 cookie。而回调路径
`/auth/oauth/wechat/callback` 正好落在 `Path=/auth` 里，所以插件自己就能种：

- 扫码流程在**回调前**重新种一次 cookie 再发回调，所以经由插件扫码建号的新用户，
  自动算成邀请人的；
- 面板①底部多一颗「用邀请链接注册 / 邀请好友」按钮，点开就是
  `https://lightvela.com/?ref=<CODE>`，顺带能一键复制链接发人。

配置项在 `lib/store.js` 的 `DEFAULT_CONFIG.referralCode`，也可以在
`~/.dsh/plugin-data/dsh-lightvela/config.json` 里覆盖（运行期配置优先级更高）：

```json
{ "referralCode": "JAKDMLAGJR" }
```

改成空串 `""` 就彻底关掉 —— 归因不挂、按钮不显示，回归裸登录。

> 归因失败不会阻断登录：老用户本来就不需要归因，别为了拉新把老用户挡在门外。

---

## 它到底给你哪些模型

`/v1/models` 返回的是「这把 token 在当前分组里能调的名字」，实测只有四条：

| id | 说明 | 实测 |
|---|---|---|
| `auto` | 网关自己挑，会落到 glm-5.3-flash 一类 | ✅ 可调 |
| `deepseek-v4-pro-202606` | 真实型号 | ✅ 可调 |
| `ep-hyasr3` | 自定义端点 | ❌ No available channel |
| `llmgw-mock-chat` | 自检假模型 | ❌ 404，插件默认藏掉 |

`auto` 是最省心的选项：网关按可用性和负载挑，不用你猜哪个能用。

> 这批模型清单属于 LightVela 的套餐分组，跟你在它网站上付费档位有关。
> 换档位后回面板点一次「读清单」就能看到新的。

---

## 排错

| 现象 | 原因 / 处理 |
|---|---|
| 面板报「宿主端没有这条接口（HTTP 404/405）」 | 宿主还是旧代码。重启 DSH |
| 扫码一直停在「等扫码」 | 二维码 5 分钟过期。点「取消」再生成一张 |
| 扫码成功但 ② 显示「没钥匙」 | 实例没跑（`status` 不是 Running），或者这个 Bot 还没配模型 |
| ② 报「这个实例用的是你自己的服务商」 | 你在 LightVela 里改成了 BYOB（自带 key）。那把 key 是你自己的，拿出去没意义，插件会如实拒绝 |
| 聊天报 402 / `insufficient_funds` | 套餐积分用完了。这是上游账务，不是插件问题 |
| 聊天报 401 `invalid bearer token` | 实例重建过，钥匙变了。回 ② 点「重新拉取」，再回 ③ 注册一次 |
| 选择器里没有「LightVela」组 | ① 确认 ③ 显示「已注册 N 个」；② 刷新浏览器页面（不是重启 DSH） |
| 模型选择器里选了模型但报「model not found」 | 那个模型在当前分组没开。回 ③ 点「逐个探测」，看哪个是「可调」 |

---

## 安全说明

- 插件读的是**你自己账号、你自己实例**里的凭据，存在
  `~/.dsh/plugin-data/dsh-lightvela/auth.json`（权限 0600），跟 DSH 其他凭据一样在本机。
- 它不会把钥匙发到除 `token.lightvela.com` 以外的任何地方。
- 退出登录（面板「退出」）会同时清掉登录态、钥匙和模型缓存。

---

## 接口

宿主半区注册在 `/plugins/dsh-lightvela/` 下，共 14 条：

| 方法 | 路径 | 作用 |
|---|---|---|
| GET | `/status` | 全量快照（登录态、账号池、钥匙、实例、模型、二维码状态、转发器、邀请码） |
| GET | `/referral` | 校验邀请码 + 给出邀请链接（结果缓存 10 分钟） |
| POST | `/accounts` | 账号池操作：`{action:'switch'\|'label'\|'remove'\|'quota', id, label}` |
| POST | `/auth/qr/start` | 申请二维码，返回 dataURL |
| GET | `/auth/qr/status` | 只读二维码状态 |
| POST | `/auth/qr/cancel` | 取消本轮扫码 |
| POST | `/auth/bind` | 手贴 sessionToken（扫码失效时的兜底） |
| POST | `/key/pull` | 重新进实例取钥匙，可指定 `{accountId, instanceId}` |
| GET | `/instances` | 列出账号下的实例 |
| POST | `/models/refresh` | 重读网关模型清单 |
| POST | `/models/probe` | 逐个打一发，标可用性 |
| POST | `/models/register` | 写进 `llm-pi-ai` 的 `providers.lightvela` |
| POST | `/test` | 用当前钥匙打一发 `{model}` |
| POST | `/logout` | 清凭据与缓存 |

---

## 开发

```bash
node scripts/smoke.mjs      # 28 项，假网络打满全链路
```

冒烟测试覆盖：store 两半凭据、模型清单归一化、微信协议解析（Set-Cookie /
uuid / wx_errcode）、扫码全链路（假网络走完 start → poll → callback →
自动取钥匙）、注册写进 llm-pi-ai 的断言（特别是 `baseURL` 必须是公网网关
而不是 127.0.0.1）、浏览器半区的 factory 与插槽注册。
