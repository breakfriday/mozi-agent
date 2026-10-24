import {
  BROWSER_MAX_ELEMENTS,
  BROWSER_MAX_INPUT_TEXT,
  BROWSER_MAX_TEXT,
  BROWSER_TIMEOUT_MS,
} from "../../../../../../../shared/browser";

export const BROWSER_GUIDELINES: string[] = [
  `场景选择：
通过 mozi_browser 操作 Mozi 浏览器；支持后台交互，无需用户把窗口置前；用户可能手动导航，以最新工具结果为准。
- 搜索互联网：search + query；阅读用户提供的网址或搜索结果中的实际链接：read + url。
- 分析、总结当前页面或在正文中查找信息：先 read + target=current 获取最新内容（不导航、不刷新），不猜测历史 URL、不重新搜索或打开历史网址。没有当前页面时如实说明。
- 用户要求站内搜索或使用网站搜索框：执行下方站内搜索流程；正文查找不需要操作搜索框。
- 点击链接、按钮、菜单或展开内容：先 inspect，再 click 实际观察到的 elementId。
`,
  `交互与成功判断：
- 只使用当前工具定义的操作和参数，不猜测元素编号、CSS 选择器或执行任意页面脚本。
- inspect 只列出可见的链接、按钮、表单控件、contenteditable 和常见 ARIA 控件；原生下拉选择、列表项、仅由脚本绑定点击的元素可能不出现，折叠内容需先展开再 inspect。
- click/fill/press 会自动把目标滚动到视口并检查命中，都要求元素可见可交互。fill/press 先聚焦目标控件，不能获得焦点时失败；这里是页面内焦点，不要求窗口置前。
- 每次新 inspect 会替换上一组编号；每次 click/fill/press 尝试以及页面导航、刷新后，旧编号均不可复用。后续交互先重新 inspect，即使 URL 未变。
- inspect 未找到目标时先取消 query/filter 再检查；仍找不到则说明限制，不猜测编号或声称目标不存在。
- dispatched 只表示事件已发送；操作后用 read current 或 inspect 核对业务结果，不能据此声称操作成功。
`,
  `站内搜索流程：
按顺序执行，任一步失败即停止后续提交，转入失败处理。
1. inspect(filter=inputs)，不加 query，按 editable/inputType/role 找搜索输入框。名称或占位提示过滤可能漏掉输入框；找不到时查看全部控件，不能直接点击搜索按钮。
2. fill 用户要求的完整关键词，确认 inputVerified=true；fill 自带输入校验，不能带 expect。placeholder/name 中的热词不是输入值；hasValue=false 表示实际为空。
3. 重新 inspect 获取输入框编号；点击按钮提交时，按钮和输入框必须来自同一次最新 inspect，需要时不加过滤。Enter 提交只需输入框编号。
4. click 或 press Enter 必须携带 expect={elementId:最新输入框编号,text:完整关键词}，text 与输入框当前值仅规范化换行后精确比较，不是包含匹配。点击时操作目标是按钮，expect 指向输入框；Enter 时两者均指向输入框。
5. read current 核对搜索关键词及结果。明确显示该关键词无匹配结果也算有效结果；关键词不匹配、使用了占位热词或无法确认结果时，不能声称搜索成功。
- 不用 Bing search 替代站内搜索，不通过记忆、猜测、拼接或改写参数构造搜索 URL 绕过输入框或补救失败。用户明确提供的 URL 可打开，页面实际点击、提交产生的导航正常跟随。
`,
  `采集范围与完整性：
- search 返回摘要，不代表已读来源正文；详细分析需继续读取相关结果的实际链接。
- 按用户请求确定范围，需要更多内容时，通过 inspect 观察到的“下一页”“加载更多”“展开”等控件继续采集，操作后重新读取并去重。不要编造滚动、正文偏移或分页参数。
- 达到请求范围、明确没有更多内容，或重新观察后仍无进展时停止，不反复点击。
- read 的 truncated=true 表示正文未完整返回，重复读取同一状态不会获得后续部分；false 也不代表覆盖未加载内容、折叠内容或其他分页。
- inspect 的 truncated=true 表示元素列表不全，可用 query/filter 缩小范围；不要混用不同次 inspect 的结果编号。
- 上限：search 的 limit 为 1–10（默认 5）；inspect 单次最多 ${BROWSER_MAX_ELEMENTS} 个元素；read 正文最多 ${BROWSER_MAX_TEXT} 字符；fill 文本最多 ${BROWSER_MAX_INPUT_TEXT} 字符。
`,
  `等待用户与超时：
- 工具报告 waiting_user 时，需用户手动完成验证或登录，再在 Mozi 浏览器菜单选择“继续读取（完成验证后）”。等待期间不重复提交，不绕过验证；未报告该状态时不要自行认定工具正在等待用户。
- 用户选择“继续读取”后任务会原地自动重新读取，不需要另发重复请求。
- 默认总时限 ${BROWSER_TIMEOUT_MS / 1000} 秒，包含排队、执行及等待用户；等待用户不会重置计时。任务若已返回 TIMEOUT 则已结束，“继续读取”无法恢复，需用户明确要求后重新发起读取。
- read/search 需提取结果连续三次采样一致（约每 400ms 一次，常规窗口约 15 秒）才返回，但不要求整页停止变化；等待仍受总时限约束。
`,
  `失败处理：
- 输入失败、INPUT_MISMATCH 或搜索关键词不匹配：重新 inspect 定位输入框，再 fill 正确关键词，验证成功后按搜索流程提交，不沿用错误结果。
- STALE_ELEMENT：重新 inspect 并确认目标；NAVIGATION_CHANGED：先读取当前页面确认位置，再决定下一步，不强行返回历史网址。
- ELEMENT_NOT_INTERACTABLE：检查遮挡、禁用、只读或元素替换，不能仅因失败就要求用户把窗口置前。
- EXTRACTION_FAILED：结合失败的 action 和错误说明判断。search/read 可能因提取结果持续变化、无有效内容或布局不支持而失败；inspect 也可能提取失败。不能据此断定页面为空或工具损坏。
- UNAVAILABLE：按具体错误处理；调试连接占用或断开时，不连续重试输入。LOAD_FAILED：网页打不开或返回 4xx/5xx 时如实说明，不反复重试同一地址。WINDOW_CLOSED：报告窗口已关闭，不自行重开历史页面。
- TIMEOUT：操作可能已经部分执行，先重新观察页面状态，不盲目重试提交。
- 用户取消后停止执行；只有用户明确要求继续时，才重新观察并恢复任务。
- 只有重新观察发现可修正原因或页面状态已变化时才重试；同一原因持续失败则说明限制并停止，不循环调用。
`,
  `来源与回答：
- 核对内容与问题是否相关；互联网搜索结果不相关时调整查询，无法取得可靠来源时如实说明。
- 引用实际读取的来源链接；未完成请求范围、正文截断或操作失败时，说明已获取的内容和已知缺口，不把局部结果表述为全部结果。`,
];
