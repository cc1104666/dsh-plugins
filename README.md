# dsh-plugins

Four [DSH](https://github.com/deepseek-ai) (DeepSeek Harness) plugins that put third-party chat
services into the model picker. Each subpackage under `packages/` is independently installable and
declares its own `dsh.bundle` manifest.

四个把第三方对话服务接进 DSH 模型选择器的插件。`packages/` 下每个子包都可独立安装，各自声明
`dsh.bundle`。

| Package | What it connects | Needs an API key |
|---|---|---|
| [`dsh-grok-online`](packages/dsh-grok-online) | grok.online | no |
| [`dsh-grok3ai`](packages/dsh-grok3ai) | the public Hugging Face Spaces that grok3ai.org embeds | no |
| [`dsh-lightvela`](packages/dsh-lightvela) | LightVela (lightvela.com) | your plan's own key, read from your instance |
| [`dsh-ima`](packages/dsh-ima) | ima.qq.com (Tencent IMA), via WeChat QR sign-in | no |

## Install / 安装

```sh
dsh plugin add dsh-grok-online
dsh plugin add dsh-grok3ai
dsh plugin add dsh-lightvela
dsh plugin add dsh-ima
```

Each package ships a `cordis.patch.yml` and registers a settings panel; nothing outside the DSH
profile is written except the plugin's own data directory.

每个子包都自带 `cordis.patch.yml` 和一块设置面板；除插件自己的数据目录外不写任何位置。

## What these plugins are not / 它们不是什么

- Not official. They are unaffiliated with grok.online, grok3ai.org, LightVela, xAI, MiniMax,
  Hugging Face or Tencent.
- Not a way to bypass billing. They forward requests to a service you can already reach; the quota
  you spend is that service's own, and it can change or disappear at any time.
- Not a security boundary. Like every DSH plugin, they run with your user's permissions.

- 非官方。与 grok.online、grok3ai.org、LightVela、xAI、MiniMax、Hugging Face、腾讯均无关系。
- 不能绕过计费。它们只是把请求转给一个你本来就能访问的服务，花的是那个服务自己的额度，随时可能变化或消失。
- 不是安全边界。和所有 DSH 插件一样，它们以当前用户权限运行。

## License

MIT
