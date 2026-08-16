# dsh-wecom-notify

DSH（DeepSeek Harness）插件：当 **任务完成**、**任务报错** 或 **需要用户选择/确认** 时，自动通过**企业微信群机器人 webhook** 发送通知到企业微信群。默认发送 `text` 消息，可配置为 `markdown`。

## 工作原理

插件监听 Harness 的事件信号：

| 时机 | 信号 | 通知 |
|---|---|---|
| 任务完成 | `agent/status` running → idle，且最后一个 `turn/end` reason 为 `completed` | ✅ 任务完成（附最后一段回复摘要） |
| 任务出错 | `agent/error` | ❌ 任务出错（附错误信息） |
| 需要用户选择 | `session/event` 中 `ask_user_question` 工具调用 / 回合被阻塞等待输入 | ❓ 需要您的确认（附问题与选项） |

每次通知都经 `fetch` POST 到企业微信 webhook，发送失败只记日志，绝不影响 Harness 主流程。

## 安装

从 GitHub 拉取安装（可固定到某个 commit；去掉 `#<commit>` 则跟随默认分支最新提交）：

```sh
dsh plugin --profile web add github:ljnljn2005/dsh-wecom-notify#f729370121d333794a5a76734ea77021535a7b6e
dsh plugin --profile headless add github:ljnljn2005/dsh-wecom-notify   # 可选
```

然后在 profile 的 `cordis.patch.yml` 中启用并配置：

```yaml
- insert:
    - id: wecom-notify
      name: 'dsh-wecom-notify'
      config:
        webhookUrl: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=你的key'
        msgType: 'text'
```

**重启对应 profile 的服务后生效**（如 `dsh web` / `dsh --profile headless ...`）。

## 配置项

| 字段 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `webhookUrl` | string | 必填 | 企业微信群机器人 webhook 地址 |
| `msgType` | `text` \| `markdown` | `text` | 消息类型 |
| `notifyComplete` | boolean | `true` | 任务完成时通知 |
| `notifyError` | boolean | `true` | 任务出错时通知 |
| `notifyQuestion` | boolean | `true` | 需要用户选择/确认时通知 |
| `title` | string | `DSH 通知` | 通知标题前缀 |
| `mentionAll` | boolean | `false` | @所有人（text 用 `mentioned_list: ["@all"]`；markdown 用 `<@all>`） |
| `mentionedList` | string[] | `[]` | @指定成员（企业 userid；markdown 模式在正文追加 `<@userid>`） |
| `mentionedMobileList` | string[] | `[]` | @指定手机号成员（text 模式） |
| `timeoutMs` | number | `5000` | HTTP 超时（毫秒） |
| `maxContentLength` | number | `500` | 消息正文最大字符数 |

## 示例：markdown 模式

```yaml
- insert:
    - id: wecom-notify
      name: 'dsh-wecom-notify'
      config:
        webhookUrl: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=你的key'
        msgType: 'markdown'
        title: 'DSH 任务通知'
        mentionAll: true
```

## 本地测试

仓库内提供 `test/test.mjs`：起一个本地 HTTP 服务扮演企业微信 webhook，用真实 cordis 事件总线模拟三类信号，断言收到的消息体。

```sh
node test/test.mjs
```
