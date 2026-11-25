// 正则包的模板与脚本速查

const MACROS: [string, string][] = [
  ['{{setvar::名::值}}  {{getvar::名}}', '写入 / 读取请求级变量（同一次请求里各包、各步骤共用）'],
  ['{{addvar::名::值}}  {{incvar::名}}  {{decvar::名}}', '数字相加或文本追加；加一 / 减一并输出新值'],
  ['{{param::名}}  或  {{名}}', '读取本包的参数'],
  ['{{model}}  {{upstreamModel}}  {{ua}}  {{format}}', '请求的模型、映射后的上游模型、客户端 User-Agent、入口格式'],
  ['{{channel}}  {{key}}  {{source}}', '渠道名、调用 Key 名、调用来源'],
  ['{{system}}  {{messageCount}}', '系统提示词文本、消息条数'],
  ['{{lastMessage}}  {{lastUserMessage}}  {{lastCharMessage}}  {{firstUserMessage}}', '最后一条 / 最后一条用户 / 最后一条助手 / 第一条用户消息的文本'],
  ['{{random::a::b::c}}  {{pick::a::b::c}}', '随机选一项；pick 在同一段对话里始终选同一项'],
  ['{{roll::2d6}}', '掷骰子'],
  ['{{time}}  {{date}}  {{weekday}}  {{isotime}}  {{isodate}}  {{time_UTC+8}}', '网关所在机器的当前时间'],
  ['{{newline}}  {{trim}}  {{noop}}  {{// 注释}}', '换行；吃掉前后的空行；空；注释'],
  ['$1  $&  $<名字>  $$', '仅正则步骤：第 n 个捕获组、整个匹配、命名捕获组、字面量 $'],
]

const EJS: [string, string][] = [
  ['<% 代码 %>', '执行 JS，可用 if / for 控制后面的文本是否输出，支持 await'],
  ['<%= 表达式 %>', '输出表达式的值'],
  ['<%# 注释 %>', '注释'],
  ['<%_ … _%>  … -%>', '吃掉标签前 / 后的空白与换行'],
]

const API: [string, string][] = [
  ['req.system', '系统提示词文本，可读可写（空串 = 移除）'],
  ['req.prependSystem(t)  req.appendSystem(t)', '在系统提示词开头 / 结尾加一段'],
  ['req.messages', '消息列表，每项有 role、text（可写）、raw（原始对象）、index、remove()'],
  ['req.lastMessage(role?)', '最后一条有文本的消息'],
  ['req.insert(i, role, text)  req.append(role, text)  req.prepend(role, text)', '插入消息；insertAtDepth(n, role, text) 插到倒数第 n 条之前'],
  ['req.remove(msg 或 判断函数)', '移除消息，工具调用与结果成对清理，返回移除条数'],
  ['req.tools  req.tool(名字)', '工具定义，每项有 name、description（可写）、schema（参数 Schema 对象）、raw、remove()'],
  ['body', '原始请求体对象，可直接读写任意字段；形状见 ctx.shape'],
  ['vars  getvar(名, 默认)  setvar(名, 值)  incvar(名)', '请求级变量'],
  ['params', '本包的参数，如 params.tone'],
  ['ctx', 'model、upstreamModel、ua、format、shape、passthrough、channelId、channelName、source、keyId、keyName、stream、headers'],
  ['match  $0  $1 …', '仅正则步骤的替换模板：当前匹配与各捕获组'],
  ['render(模板)', '渲染一段宏 / EJS 模板，返回 Promise'],
  ['console.log(…)', '输出写进请求日志的「正则包」页签和试运行结果'],
  ['fetch  require  signal', '完整的 Node 能力；signal 在请求被取消时触发，可传给 fetch'],
]

function Table({ rows }: { rows: [string, string][] }) {
  return (
    <div className="ah-pk-help-table">
      {rows.map(([code, text]) => (
        <div key={code} className="ah-pk-help-row">
          <code>{code}</code>
          <span>{text}</span>
        </div>
      ))}
    </div>
  )
}

export function RegexPackHelp() {
  return (
    <div className="ah-pk-help">
      <div className="ah-pk-help-title">宏</div>
      <div className="ah-mini ah-muted">
        可用在正则步骤的「替换为」、注入步骤的内容里。只解析你写的模板本身：请求里原有的 <code>{'{{…}}'}</code> 与 <code>{'<% %>'}</code> 不会被执行，未知的宏原样保留。
      </div>
      <Table rows={MACROS} />
      <div className="ah-pk-help-title">EJS</div>
      <Table rows={EJS} />
      <div className="ah-pk-help-title">脚本与 EJS 里可用的对象</div>
      <div className="ah-mini ah-muted">
        脚本步骤是一段异步 JS，可直接 <code>await</code>。脚本在请求体的副本上运行，执行成功才写回；抛错或超过 30 秒时这一步不生效，后面的步骤照常执行。
        <code>req</code> 在三种请求形状下用法一致：<code>anthropic</code>（Claude 直通，顶层 system）、<code>responses</code>（Responses 直通，instructions + input）、
        <code>chat</code>（OpenAI Chat 直通，或跨协议转换时的中间表示）。
      </div>
      <Table rows={API} />
      <div className="ah-pk-help-title">例子</div>
      <pre className="ah-code ah-code-block ah-pk-code">{`// 正则步骤：抓出 harness 写进系统提示词的工作目录，存成变量，原文不动
查找    Working directory: (\\S+)
替换为  {{setvar::cwd::$1}}$&

// 注入步骤：按包参数决定加哪段话
<% if (params.concise) { %>回答尽量简短，不要复述问题。<% } %>
当前目录：{{getvar::cwd}}，现在是 {{isodate}} {{isotime}}。

// 脚本步骤：整段重写系统提示词里的某一节，并精简工具描述
req.system = req.system.replace(/# Tone and style[\\s\\S]*?(?=\\n# )/, params.tone_section)
for (const tool of req.tools) tool.description = tool.description.split('\\n\\n')[0]
req.remove(m => m.role === 'user' && m.text.startsWith('<system-reminder>'))`}</pre>
    </div>
  )
}
