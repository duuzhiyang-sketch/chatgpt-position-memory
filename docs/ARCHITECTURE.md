# 架构说明

## 目标

V0.1 只解决 ChatGPT 对话阅读位置的本地保存与恢复。所有能力都运行在 Chrome 扩展内，不依赖后端或第三方服务。

## 组件

### `src/shared/core.js`

纯 JavaScript 领域逻辑：

- 规范化 ChatGPT 对话身份；
- 校验版本化进度记录和设置；
- 按 `recordedAt` 执行最后写入优先；
- 判断进度变化是否值得持久化；
- 计算滚动比例与锚点恢复位置。

该文件同时由 background、content、popup 和 Node 测试加载，不依赖 DOM 或 Chrome API。

### `src/background.js`

唯一持久化入口。使用串行 Promise 队列包装 `chrome.storage.local`，处理：

- `settings:get` / `settings:set`
- `progress:get` / `progress:upsert`
- `progress:delete` / `progress:clear-all` / `progress:count`

进度存储键为 `positionMemory.progress.v1`，设置键为 `positionMemory.settings.v1`。

### `src/content.js`

运行于 ChatGPT 页面：

1. 每 500ms 检查 SPA 路由，只接受 `/c/<conversation-id>`。
2. 监听实际对话滚动容器；任何滚动都会采样，不要求先点击按钮或出现特定输入事件。
3. 页面可见时每 2.5 秒核对当前视口，补偿滚动条拖动、宿主滚动和事件遗漏。
4. 在视口高度 35% 处选择最近消息作为锚点，750ms 防抖后经 background 保存。
5. 重新进入对话时，优先匹配强消息 ID；强 ID 未出现时不会误降级到旧会话的同序号节点。
6. SPA 切换会等待旧 DOM 被替换；命中目标后持续校准约 900ms，防止 ChatGPT 后续自动滚动覆盖。
7. 恢复最长等待 15 秒；用户主动滚动立即取消。

内容脚本不读取或保存消息文本。

### `src/popup/`

最小管理界面，只承载本功能的设置和数据清除，不添加其他产品功能。

## 数据模型

```json
{
  "version": 1,
  "platform": "chatgpt",
  "conversationKey": "chatgpt:conversation:<id>",
  "target": {
    "messageId": "optional",
    "turnTestId": "optional",
    "position": 12,
    "role": "assistant"
  },
  "viewport": {
    "referenceYRatio": 0.35,
    "offsetPx": 42,
    "scrollRatio": 0.61
  },
  "status": "reading",
  "recordedAt": 1788310000000,
  "source": "user-scroll"
}
```

## 失败处理

- 非 ChatGPT 对话页：不工作、不写入。
- 无消息 DOM：等待，达到 15 秒后停止。
- 精确锚点未挂载：应用滚动比例并继续寻找，最终明确提示“接近上次的位置”。
- background 暂时不可用：吞掉扩展生命周期错误，不干扰 ChatGPT 页面。
- 恢复期间用户操作：取消恢复，用户控制权优先。
