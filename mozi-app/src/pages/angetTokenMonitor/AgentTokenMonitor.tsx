import { useAgentStore } from "@/agent/agentStore";
import type { ReactNode } from "react";
import { ArrowDownOutlined, ArrowUpOutlined, DatabaseOutlined, ThunderboltOutlined, SearchOutlined, FileTextOutlined, ClockCircleOutlined, BarChartOutlined, MessageOutlined } from "@ant-design/icons";
import type { ModelCallView, ServerStepView, UsageTotals } from "../../../../shared/agent";
import { useElapsed, seconds } from "./format";
import { MonitorTag, StatusTag, type MonitorTone } from "./MonitorTag";
import { TokenValue } from "./TokenValue";
import styles from "./token-monitor.module.css";

const number = (value?: number) => value === undefined ? "—" : value.toLocaleString("en-US");
const statusNames: Record<string, string> = { running: "执行中", accepted: "等待执行", waiting_approval: "等待审批",
  cancelling: "正在停止", completed: "已完成", failed: "失败", cancelled: "已取消", interrupted: "已中断" };

function Totals({ total }: { total?: UsageTotals }) {
  const known = !!total?.reportedCalls;
  const input = total ? total.input + total.cacheRead + total.cacheWrite : 0;
  const cells: [string, number | undefined, ReactNode][] = [
    ["总输入（含缓存）", known ? input : undefined, <ArrowDownOutlined />],
    ["缓存命中", known ? total?.cacheRead : undefined, <DatabaseOutlined />],
    ["总输出（含推理）", known ? total?.output : undefined, <ArrowUpOutlined />],
    ["其中推理", total?.reasoning, <ThunderboltOutlined />],
  ];
  return <>
    <div className={styles.hero}><span className={styles.heroLabel}><BarChartOutlined /> 已确认消耗</span><strong><TokenValue value={known ? total.totalTokens : undefined} /></strong>
      <span>{total?.calls ?? 0} 次应用侧模型请求 · {total?.reportedCalls ?? 0} 次已返回用量</span>
    </div>
    <div className={styles.metrics}>{cells.map(([label, value, icon]) => <div key={label} data-tone={value === undefined ? "neutral" : "info"}><span>{icon}{label}</span><strong><TokenValue value={value} /></strong></div>)}</div>
    <div className={styles.secondary}>
      <span>缓存写入 <TokenValue value={known ? total?.cacheWrite : undefined} /></span>
      <MonitorTag tone={total?.webSearch === undefined ? "neutral" : "info"} icon={<SearchOutlined />}>搜索 {number(total?.webSearch)} 次</MonitorTag>
      <MonitorTag tone={total?.webExtractor === undefined ? "neutral" : "teal"} icon={<FileTextOutlined />}>网页提取 {number(total?.webExtractor)} 次</MonitorTag>
    </div>
    {!!total?.pendingCalls && <p className={styles.notice} data-tone="info" role="status">{total.pendingCalls} 次调用进行中，完成后更新服务端统计。</p>}
    {!!total?.unknownCalls && <p className={styles.notice} data-tone="amber">用量不完整：{total.unknownCalls} 次调用未返回统计，未按零消耗计算。</p>}
    {!!total?.reportedCalls && total.reasoningCalls < total.reportedCalls && <p className={styles.note}>部分调用未提供推理明细；推理数仅累计已知部分。</p>}
  </>;
}

const stepNames: Record<ServerStepView["type"], string> = {
  reasoning: "思考片段", message: "回复片段", web_search: "联网搜索", web_extractor: "网页提取",
};
const stepStatuses: Record<ServerStepView["status"], string> = {
  running: "进行中", completed: "已完成", failed: "失败", incomplete: "未完成", unknown: "状态未提供",
};
const stepTones: Record<ServerStepView["type"], MonitorTone> = { reasoning: "purple", message: "neutral", web_search: "info", web_extractor: "teal" };
const stepIcons: Record<ServerStepView["type"], ReactNode> = { reasoning: <ThunderboltOutlined />, message: <MessageOutlined />, web_search: <SearchOutlined />, web_extractor: <FileTextOutlined /> };
const countSource = (source?: "provider" | "events") => source === "provider" ? "服务端统计"
  : source === "events" ? "已完成事件计数" : "未记录来源";

function UrlList({ title, urls }: { title: string; urls?: string[] }) {
  const safe = urls?.filter(value => {
    try { const url = new URL(value); return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password; }
    catch { return false; }
  });
  if (!safe?.length) return null;
  return <div className={styles.stepMetadata}><span>{title}</span><ul>{safe.map(url =>
    <li key={url}><a href={url} target="_blank" rel="noopener noreferrer">{url}</a></li>)}</ul></div>;
}

function ServerSteps({ call }: { call: ModelCallView }) {
  return <div className={styles.steps}>
    <div className={styles.stepSectionTitle}><h4>服务端步骤</h4>{!!call.steps?.length && <MonitorTag>{call.steps.length} 项</MonitorTag>}</div>
    {call.steps?.length ? <>
      <p className={styles.note}>按流事件首次收到的顺序排列；仅在完成响应中提供的项另有标记。片段数不代表内部模型调用次数，接口未提供逐步 token。</p>
      <ol className={styles.stepList}>{call.steps.map(step => <li key={step.id} data-tone={stepTones[step.type]}>
        <div className={styles.stepHeading}><MonitorTag tone={stepTones[step.type]} icon={stepIcons[step.type]}>{stepNames[step.type]}</MonitorTag><StatusTag status={step.status} label={stepStatuses[step.status]} /></div>
        {step.observed === "final" && <small>完成响应补充</small>}
        {!!step.queries?.length && <div className={styles.stepMetadata}><span>搜索词</span><ul className={styles.queryList}>{step.queries.map(query => <li key={query}>{query}</li>)}</ul></div>}
        <UrlList title="搜索来源" urls={step.sources} />
        <UrlList title="提取网址" urls={step.urls} />
      </li>)}</ol>
    </> : <p className={styles.note}>{call.status === "running" ? "请求完成后展示服务端步骤。" : "该请求未保存服务端步骤明细。"}</p>}
    {call.stepsTruncated && <p className={styles.notice} data-tone="amber">步骤明细过长，部分未保存；工具统计独立保留。</p>}
  </div>;
}

function CallDetails({ call, index }: { call: ModelCallView; index: number }) {
  const usage = call.usage;
  return <details className={styles.call} data-status={call.status}>
    <summary><span className={styles.callIndex}>{String(index + 1).padStart(2, "0")}</span>
      <span className={styles.callTitle}><strong>{call.model}</strong><span className={styles.callTags}>
        <StatusTag status={call.status} label={statusNames[call.status]} />
        <MonitorTag>{call.provider}</MonitorTag>
        {call.thinkingLevel && <MonitorTag tone={call.thinkingLevel === "off" ? "neutral" : "purple"} icon={<ThunderboltOutlined />}>{call.thinkingLevel === "off" ? "思考关闭" : `思考 ${call.thinkingLevel}`}</MonitorTag>}
        <span className={styles.duration}><ClockCircleOutlined /> {seconds(call.durationMs)}</span>
      </span></span>
      <span className={styles.callTokens} data-known={!!usage}>{usage ? <strong><TokenValue value={usage.totalTokens} /></strong> : call.status === "running" ? "等待统计" : "未返回"}</span>
    </summary>
    <div className={styles.callBody}>
    <dl className={styles.details}>
      <dt>服务商</dt><dd>{call.provider}</dd>
      <dt>请求模型</dt><dd>{call.model}</dd>
      <dt>返回模型</dt><dd>{call.responseModelId ?? "未提供"}</dd>
      <dt>思考等级</dt><dd><MonitorTag tone={call.thinkingLevel && call.thinkingLevel !== "off" ? "purple" : "neutral"}>{call.thinkingLevel ?? "未记录"}</MonitorTag></dd>
      <dt>开始时间</dt><dd>{new Date(call.startedAt).toLocaleString("zh-CN")}</dd>
      <dt>普通输入</dt><dd><TokenValue value={usage?.input} /></dd>
      <dt>缓存命中</dt><dd><TokenValue value={usage?.cacheRead} /></dd>
      <dt>缓存写入</dt><dd><TokenValue value={usage?.cacheWrite} /></dd>
      <dt>输出（含推理）</dt><dd><TokenValue value={usage?.output} /></dd>
      <dt>其中推理</dt><dd><TokenValue value={usage?.reasoning} /></dd>
      <dt>非推理输出</dt><dd><TokenValue value={usage?.reasoning === undefined ? undefined : Math.max(0, usage.output - usage.reasoning)} /></dd>
      <dt>服务端搜索</dt><dd><MonitorTag tone={call.webSearch === undefined ? "neutral" : "info"}>{number(call.webSearch)} 次</MonitorTag>{call.webSearch !== undefined && <small className={styles.countSource}>{countSource(call.webSearchSource)}</small>}</dd>
      <dt>网页提取</dt><dd><MonitorTag tone={call.webExtractor === undefined ? "neutral" : "teal"}>{number(call.webExtractor)} 次</MonitorTag>{call.webExtractor !== undefined && <small className={styles.countSource}>{countSource(call.webExtractorSource)}</small>}</dd>
    </dl>
    <ServerSteps call={call} />
    </div>
  </details>;
}

export function AgentTokenMonitor({ runId, onSelectRun }: {
  runId?: string; onSelectRun: (runId?: string) => void;
}) {
  const usage = useAgentStore(state => state.usage);
  const runs = useAgentStore(state => state.runs);
  const messages = useAgentStore(state => state.messages);
  const run = runs.find(item => item.id === runId);
  const elapsed = useElapsed(run);
  const calls = usage?.calls.filter(call => !runId || call.runId === runId) ?? [];
  const total = runId ? usage?.runs.find(item => item.runId === runId)?.total : usage?.total;
  const runIds = [...new Set([...runs.map(item => item.id), ...(usage?.runs.map(item => item.runId) ?? [])])];
  const title = (id: string) => messages.find(message => message.runId === id && message.role === "user")?.content.map(part => part.text).join("") || "历史指令";
  return <div className={styles.panel}>
    <aside className={styles.overview}>
      <label className={styles.filter}>统计范围
        <select aria-label="用量统计范围" value={runId ?? ""} onChange={event => onSelectRun(event.target.value || undefined)}>
          <option value="">整个会话</option>
          {runIds.map((id, index) => <option value={id} key={id}>{index + 1}. {title(id).slice(0, 60)}</option>)}
        </select>
      </label>
      {runId ? <div className={styles.scope}><strong>{title(runId)}</strong>
        {run && <div className={styles.callTags}><StatusTag status={run.status} label={statusNames[run.status]} /><span className={styles.duration}>总耗时 {seconds(elapsed)}</span><MonitorTag tone={run.model?.thinkingLevel && run.model.thinkingLevel !== "off" ? "purple" : "neutral"}>思考 {run.model?.thinkingLevel ?? "未记录"}</MonitorTag></div>}
      </div> : <p className={styles.note}>累计已记录的调用，含重试与历史分支；不是当前上下文占用。</p>}
      <Totals total={total} />
    </aside>
    <section className={styles.requests}>
      <div className={styles.sectionTitle}><h3>应用侧模型请求明细</h3><MonitorTag>{calls.length} 次</MonitorTag></div>
      {calls.length ? calls.map((call, index) => <CallDetails key={call.id} call={call} index={index} />)
        : <p className={styles.empty}>暂无调用记录。发送消息后，用量会在这里汇总。</p>}
      <p className={styles.note}>推理已包含在输出中，缓存已包含在总输入中，不重复相加。“—”表示未提供。非推理输出可能包含工具参数。Token 用量不等同于套餐扣费。</p>
      <p className={styles.note}>一次应用侧请求可包含多段思考、搜索及网页提取。一次搜索可包含多个关键词和来源网址，工具次数不等于网页数量。服务端内部模型调用次数未提供。</p>
    </section>
  </div>;
}
