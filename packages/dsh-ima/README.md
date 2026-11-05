# dsh-ima

把 **ima.qq.com（腾讯 IMA 知识管家）网页版**的对话模型接管进 DSH 模型选择器：
微信扫码登录 → 读模型清单 → 本机反代把 OpenAI 请求译成 ima 的 SSE 协议。

## 一句话原理

ima 的对话接口**不是** OpenAI 兼容的，鉴权也不是简单的 Bearer：

| 项目 | 说明 |
|---|---|
| 对话接口 | `POST /cgi-bin/assistant/qa`（SSE 命名事件流） |
| 鉴权 | `x-ima-cookie` + `from_browser_ima: 1` + `x-ima-bkn` 三个自定义头 |
| 登录 | 微信开放平台扫码（snsapi_login，appid `wx0d63f5de059f1d52`） |

所以插件在 127.0.0.1 起了一个**本机翻译层**（和 dsh-grok-online 同一形态），
模型选择器看到的还是标准 OpenAI 接口。

## 模型（免登录可读）

来自 `POST /cgi-bin/intelligent_assistant_http_nl/get_models`：

| id | 名称 | 备注 |
|---|---|---|
| `official_3` | DeepSeek V3.2 | 默认 |
| `official_1` | DeepSeek V3.2 Think | 输出思考过程（reasoning_content） |
| `official_0` | Tencent HY 2.0 | 混元 |
| `official_2` | Tencent HY 2.0 Think | 混元思考版 |

## 用法

1. 聊天框下方 dock 出现「ima」胶囊 → 点开面板（或去插件页打开卡片）。
2. ① 微信扫码登录（和 ima.qq.com 网页登录同一套开放平台授权）。
3. ② 模型清单会自动读（免登录接口）。
4. ③ 点「注册」→ 反代拉起 + 写进 llm-pi-ai，刷新页面后模型选择器多出「腾讯 ima」组。
5. ④ 「试一句」不经过 DSH 直接打一发，排查问题用它。

扫码用不了时，支持手贴兜底：浏览器登录 ima.qq.com 后，
从任意请求的 `x-ima-cookie` 请求头整串复制粘进面板即可。

## 关键事实（都实测过，别再去翻 bundle）

- **登录接口在 `auth_login` 服务前缀下**：`/cgi-bin/auth_login/login`，裸 `/cgi-bin/login` 是 404。
  请求体：`{account_type:2, code:<wx_code>, auth_appid, client_info:{guid, platform:4, qimei36}}`。
- **会话接口在 `session_logic` 前缀下**：`/cgi-bin/session_logic/init_session` 等，响应是扁平 snake_case。
- **微信长轮询回传**：jssdk 模式下用户确认后回包是 `wx_errcode=405` **且带 wx_code** ——
  405 不再是「等确认」，判断必须 code 优先（这坑真机踩过一次）。
- **bkn**：经典 g_tk —— `e=5381; e += (e<<5)+code; e & 2147483647`，对 IMA-TOKEN 全量哈希。
- **MESSAGE.Text 是增量**；THINKING 形状是 `{Message, Status:1思考中/2结束, Tips}`。
- **enable_enhancement 默认关掉**：开着会全网搜索并往正文插 `[N](@ref)` 引用，不适合 API 转发。
  想开的话把 `config.json` 里 `enableEnhancement` 置 true。
- 对话结束有 `COMPLETED`（Code=0 成功）和 `CLOSE`（`data: [DONE]`）事件；中途有 HEARTBEAT。
- 每次对话建临时会话，结束后自动删掉，不在 ima 历史里留垃圾。
- token 有效期由 `token_valid_time`（秒）给出，到期前 10 分钟插件自动用
  `/cgi-bin/auth_login/refresh` 续期。

## 文件

```
lib/store.js     配置/登录态持久化（~/.dsh/plugin-data/dsh-ima/）
lib/ima.js       ima HTTP 客户端（bkn、cookie、登录、模型、会话、SSE 解析）
lib/login.js     微信扫码状态机（二维码 → 长轮询 → 换 IMA-TOKEN）
lib/models.js    模型清单归一化
lib/upstream.js  OpenAI messages → ima QA；SSE → 增量回调（增量/快照自适应）
lib/relay.js     127.0.0.1 OpenAI 兼容反代
lib/index.js     dsh 宿主（路由 + llm-pi-ai 注册）
lib/client.js    面板（dock 胶囊 + 插件页卡片）
scripts/smoke.mjs  离线冒烟 24 项
scripts/e2e.mjs    真机 e2e（扫码 → 登录 → 清单 → 真实问答）
scripts/probe-qa.mjs / probe-chat.mjs  调试用探针
```

## 开发

```bash
node scripts/smoke.mjs   # 24 项，不联网
node scripts/e2e.mjs     # 要联网 + 扫一次码
```
