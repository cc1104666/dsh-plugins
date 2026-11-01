# dsh-grok3ai

把 [www.grok3ai.org](https://www.grok3ai.org) 的聊天能力接进 DSH 的模型选择器。

## 先说清楚这个站是什么

**它自己没有模型。** 每个 `/xx/chat` 页面都是一个 SEO 壳（英文/西语/日语/中文…… 十几套），
里面只做一件事：把一个公开的 HuggingFace Space 塞进 `<iframe>`：

```js
function loadChatFrame() {
  let aiUrl = "https://openfree-qwen3-30b-a3b-research.hf.space/?__theme=system";
  aiUrl = "https://qwen-qwen-vl-max.hf.space/?__theme=system";          // 已删（404）
  aiUrl = "https://qwen-qwen2-5-max-demo.hf.space/?__theme=system";     // 已删（404）
  aiUrl = "https://qwen-qwq-32b-demo.hf.space/?__theme=system";         // 叫不醒（503）
  aiUrl = "https://huggingface-projects-llama-2-7b-chat.hf.space/";     // 还活着
  aiUrl = "https://minimaxai-minimax-vl-01.hf.space/";                  // ← 只有这行生效
  ...
}
```

六次赋值，**只有最后一行生效**。所以你在站上聊天，实际对话的是 **MiniMax 的 VL-01
（海螺 AI）**，不是 Grok。站点名和它跑的模型没有关系 —— 页面里唯一的广告和流量才跟它有关。

所以这个插件不是"反代 grok3ai.org"，而是**直连它会嵌的那几个 Space**，把它们各自
注册成一个模型。这也是唯一诚实且可行的做法：站点本身没有任何 API 可反代。

## 模型

| id | Space | 状态 | 说明 |
|---|---|---|---|
| `minimax-vl-01` | `minimaxai-minimax-vl-01.hf.space` | ✅ 活 | 站点现在实际嵌的。Gradio 5.0.1，中文好，支持图片输入 |
| `llama-2-7b` | `huggingface-projects-llama-2-7b-chat.hf.space` | ✅ 活 | 同一份清单里的老模型。Gradio 6.19，英文凑合，中文很差 |
| ~~`qwen3-30b`~~ | `openfree-qwen3-30b-a3b-research.hf.space` | ❌ | 上游 Fireworks 的 key 失效，接口回 412 |
| ~~`qwen2-5-max`~~ | `qwen-qwen2-5-max-demo.hf.space` | ❌ | Space 已删（404） |
| ~~`qwq-32b`~~ | `qwen-qwq-32b-demo.hf.space` | ❌ | 503，叫不醒 |

死掉的三个不注册，但面板上会解释为什么 —— 不然用户看到站点列表里有五个、这里只有两个，
会以为插件漏了。

## 它做了什么

```
DSH 模型选择器 ──OpenAI──▶ 本机反代 127.0.0.1:43695/v1
                              │  翻译：messages → 一段带角色标记的提示词
                              ▼
                     Space  POST /gradio_api/call/{fn}   {data:[...]}
                              │        → {"event_id": "..."}
                              ▼
                     GET  /gradio_api/call/{fn}/{event_id}   (SSE)
                              │  event: generating（累计全文） / complete / error
                              ▼
                     diff 成增量 → 重新包成标准 OpenAI chunk
```

为什么必须反代：Gradio 是「POST 拿 event_id → GET 订阅 SSE」的两段式，而且输出是
**累计**全文，不是增量。DSH 只会说标准 OpenAI，中间这一层就得负责这两件事。

## 两个 Space 的接口形状（写死在 `lib/spaces.js`）

| Space | fn | 入参 |
|---|---|---|
| minimax | `chat` | `[{text, files}, history, tokens, temperature, top_p]` |
| llama2 | `generate` | `[prompt, history, system, max_new_tokens, temperature, top_p, top_k, repetition]` |

两个坑：

1. minimax 的第一个输入是 `multimodaltextbox`，值必须是 `{text, files: []}` **对象**。
   直接传字符串，后端会抛一个 message 为 `null` 的 error 事件 —— 面板上只会看到
   "Space 报错，但没给原因"，非常难查。
2. 请求体里**不能**带 `session_hash`。带了的话 POST 会认，GET 订阅时却回
   `404: Session not found`（`/call` 这条路径不会帮你注册这个会话）。不带就通。

## 没有额度，但有别的代价

| 项 | 情况 |
|---|---|
| 花费 | 0。公开 Space，不要 key、不要登录 |
| 额度 | 没有条数限制（这是它比 grok.online 好的地方） |
| 冷启动 | Space 睡着时第一次要 10~30 秒，甚至回 503 |
| 排队 | 公开 Space 是共享的，别人在用你就得等 |
| 限流 | HuggingFace 对匿名访问按 IP 限（429）—— 出口池就是为这个准备的 |

**它和无状态**：每次请求都把完整历史压成一段文本发过去，不维护会话 state。
好处是换 Space / 换出口 / 重启插件都不断线；代价是模型看到的不是原生多轮模板
（对指令微调模型够用，对严格依赖 chat template 的模型会略差）。

## 出口池（可选，默认关）

HF 的匿名限流是按 IP 记的，所以留着和 `dsh-grok-online` 那套一样的出口池：

```
http://user:pass@1.2.3.4:8000
socks5://5.6.7.8:1080
http://账号-country_SG-r_1m-s_{session}:密码@gate.nstproxy.io:24125   ← {session} 每发换一个会话
```

不填也能用，只是高峰期偶尔要等。轮换规则同前：只在**还没吐字**时换出口，
只对 `busy` / `network` / `rate` / `timeout` / `empty` 换，`space_error` 换出口没用
（那是 Space 自己后端的锅，比如上游 key 失效）。

## 面板

输入框下方「Grok3AI」胶囊 / 插件页卡片，五块：

1. **这个站到底是什么** —— 把 iframe 那件事写在最前面，不解释清楚就是骗人
2. **模型** —— 两个 Space 的供应商、延迟、Gradio 版本；「探活」「全部探活」
3. **接进 DSH** —— 一键注册 + 反代地址 + 重启反代
4. **出口池** —— 粘贴、开关、测试、删除
5. **试一句** —— 真打一发（会真的占 Space 的队列）

「探活」只读一次 `/config`，不提问、不消费，5 分钟内复用结果。

## 接口

宿主半区挂在 `/plugins/dsh-grok3ai`：

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/status` | 模型、探活结果、反代端口、provider 注册状态、出口池 |
| POST | `/probe` | `{id?, force?}` 读各 Space 的 /config（不消耗） |
| POST | `/test` | `{model, text}` 真打一发 |
| POST | `/models/register` | 把 provider 写进 `llm-pi-ai` |
| POST | `/relay/restart` | 换端口重启反代并重注册 |
| POST | `/spaces/enable` | `{id, enabled}` 启用/停用某个 Space（至少留一个） |
| POST | `/proxy/save` | `{text, mode?}` 保存出口池（`{clear:true}` 才是清空） |
| POST | `/proxy/mode` | `{mode:'auto'\|'off'}` |
| POST | `/proxy/test` | `{id?}` 只测出口 IP（不碰 Space） |
| POST | `/proxy/remove` | `{id}` |

本机反代只监听 `127.0.0.1`：

| 方法 | 路径 |
|---|---|
| GET | `/v1/models` |
| POST | `/v1/chat/completions` |

## 想再加一个 Space

在 `lib/spaces.js` 的 `SPACES` 里加一项，需要三样东西：

```js
{
  id: 'xxx', name: 'Xxx', vendor: '谁做的', base: 'https://xxx.hf.space', fn: 'fn_name',
  build(prompt, opts) { return [/* 这个 Space /config 里 inputs 那几格 */] },
  pick(payload) { return payload[0] },   // 输出数组里哪一格是正文
}
```

`fn` 和 `inputs` 从 `curl https://xxx.hf.space/config | jq '.dependencies[]|select(.api_name)'` 里看。

## 测试

```
node scripts/smoke.mjs   # 42 项：store / 注册表 / 提示词翻译 / 假 Gradio 服务器（增量、error、
                         #        503、SSE 分片）/ 轮换 / 反代流式与非流式 / 宿主路由 / 面板渲染
```

冒烟全程不联网：`[4]` 起一个假 Gradio 服务器把 `call/event` 那套真跑一遍。

真机验证（`node scripts/…` 之外手跑的）：

- `probeSpace` 两个 Space 都 ✓（1.2s / 1.9~4.3s，Gradio 5.0.1 / 6.19.0）
- MiniMax 流式：200 / 4 chunk / 「我是海螺 AI，一个致力于理解和回应人类需求的人工智能助手。」
- Llama-2 非流式：200 / 「 Hi there!」
- 带 system + 三轮历史问 "7-2"：200 / 「5」（说明 history 拼接和 system 前置都对）
