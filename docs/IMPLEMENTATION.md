# 消息翻译实现说明

产品体验与成功标准见[产品设计](../DESIGN.md)。

## 扩展点接入

- 助手消息使用 `conversation.chat.assistant-actions` 列表插槽，直接在原生操作行内渲染触发按钮，位置、
  悬停显隐与尺寸由 Chat 负责。
- 用户消息缺少逐消息操作插槽，因此通过 `conversation.chat.user.before` 挂载隐藏锚点，
  读取 `data-chat-node-key` 定位当前 Chat 节点与正文，再将按钮 portal 到原生用户操作行中 Copy 按钮之后。
- 两个入口都将结果卡片宿主元素插在操作行之后，使译文位于消息下方而非图标条内部；
  用户消息卡片宽度按内容收缩并受原生气泡上限约束，助手消息卡片铺满消息列。
- 上述内部形状按 DSH `0.2.2-rc.5` 核对，细节见 `src/client/ui.tsx` 文件头。

## 翻译请求与错误处理

- 浏览器直接向 `translate.googleapis.com/translate_a/single` 发起 `POST` 请求；
  目标语言由当前界面语言映射（`zh` → `zh-CN`，繁体区域或 `Hant` → `zh-TW`，其余取主语言子标签）。
- 请求按 `src/lib/translate.ts` 的行边界切块，每块不超过 2800 字符；返回片段拼接后，多块之间以换行连接。
- 响应先校验为数组再逐段读取首个字符串；空结果、非 200 状态、网络异常与解析失败折算为结构化失败，
  分别提示网络、HTTP 与其他错误。

## 状态与生命周期

- 译文状态保存在组件本地，每个按钮持有独立的 `AbortController`。
- `apply` 通过 `ctx.effect` 注册语言字典、样式表与两个插槽入口，停用插件时一并释放。
- 卡片使用 `role="status"` 的实时区域播报加载和译完状态，触发按钮通过 `aria-controls` 关联卡片。

## 升级验证点

DSH 升级后重新确认：用户操作行的 `[data-clock="start"]` 与首个按钮为 Copy、助手操作行的 `[data-clock="end"]`、
`data-chat-node-key` 位于 Chat 节点外层，以及 `assistant-actions` 与 `user.before` 两个插槽仍然存在。
