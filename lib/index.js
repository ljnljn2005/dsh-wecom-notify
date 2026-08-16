// dsh-wecom-notify
// DSH 插件：任务完成 / 报错 / 需要用户选择时，通过企业微信群机器人 webhook 发送通知。
// 默认发送 text 消息，可通过配置切换为 markdown。
//
// 事件信号：
//   - agent/status   running -> idle 且最后一个 turn/end reason 为 completed => 任务完成
//   - agent/error    出错                                          => 报错通知
//   - session/event  tool/call (ask_user_question) 或 turn/end reason blocked => 需要用户选择
import z from "@deepseek-ai/schemastery";

const name = "wecom-notify";
/** 本插件不依赖任何注入服务（ctx.logger 为 cordis 内置）。 */
const inject = [];

const Config = z.object({
	/** 企业微信群机器人 webhook 地址（必填），形如 https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=xxxx */
	webhookUrl: z.string().required().description("企业微信群机器人 webhook 地址，形如 https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=xxxx"),
	/** 消息类型：text（默认）或 markdown */
	msgType: z.union([z.const("text"), z.const("markdown")]).default("text").description("消息类型：text（默认）或 markdown"),
	/** 任务完成时发送通知 */
	notifyComplete: z.boolean().default(true).description("任务完成时发送通知"),
	/** 任务出错时发送通知 */
	notifyError: z.boolean().default(true).description("任务出错时发送通知"),
	/** 需要用户选择/确认时发送通知（ask_user_question / 回合被阻塞等待输入） */
	notifyQuestion: z.boolean().default(true).description("需要用户选择/确认时发送通知"),
	/** 通知标题前缀 */
	title: z.string().default("DSH 通知").description("通知标题前缀"),
	/** text 消息中 @所有人；markdown 消息则在正文追加 <@all> */
	mentionAll: z.boolean().default(false).description("@所有人（text 用 mentioned_list，markdown 用 <@all>）"),
	/** text 消息 @指定成员（企业成员 userid 列表）；markdown 消息在正文追加 <@userid> */
	mentionedList: z.array(z.string()).default([]).description("@指定成员（userid 列表）"),
	/** text 消息 @指定手机号成员 */
	mentionedMobileList: z.array(z.string()).default([]).description("@指定手机号成员"),
	/** HTTP 请求超时（毫秒） */
	timeoutMs: z.number().default(5000).description("HTTP 请求超时（毫秒）"),
	/** 消息正文（摘要/错误/问题）最大字符数 */
	maxContentLength: z.number().default(500).description("消息正文最大字符数")
});

/** 截断为短 id，便于展示。 */
function shortId(value) {
	if (typeof value !== "string") return String(value);
	return value.length > 8 ? value.slice(0, 8) : value;
}

/** 截断文本。 */
function truncate(text, max) {
	const value = String(text).replace(/\s+$/g, "");
	return value.length <= max ? value : `${value.slice(0, max)}…`;
}

/** 本地时间戳。 */
function timestamp() {
	const d = new Date();
	const pad = (n) => String(n).padStart(2, "0");
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** 从会话日志中取出最后一个 assistant 消息的纯文本。 */
function extractAssistantText(session) {
	const events = session?.events;
	if (!Array.isArray(events)) return "";
	for (let i = events.length - 1; i >= 0; i--) {
		const event = events[i];
		if (event?.type !== "assistant/message") continue;
		const content = event.data?.message?.content;
		if (!Array.isArray(content)) continue;
		return content
			.filter((block) => block && block.type === "text" && typeof block.text === "string")
			.map((block) => block.text)
			.join("\n");
	}
	return "";
}

/** 从会话日志中取出最后一个 turn/end 的 reason。 */
function lastTurnReason(session) {
	const events = session?.events;
	if (!Array.isArray(events)) return null;
	for (let i = events.length - 1; i >= 0; i--) {
		if (events[i]?.type === "turn/end") return events[i].data?.reason ?? null;
	}
	return null;
}

/** 解析 ask_user_question 的 arguments 为问题列表。 */
function parseQuestions(rawArguments) {
	if (typeof rawArguments !== "string") return [];
	try {
		const args = JSON.parse(rawArguments);
		return Array.isArray(args?.questions) ? args.questions : [];
	} catch {
		return [];
	}
}

/** 组装企业微信消息内容（text / markdown 共用结构，markdown 加粗标题）。 */
function render(config, body) {
	const title = config.msgType === "markdown" ? `**${config.title}**` : config.title;
	return [title, ...body].join("\n");
}

function buildComplete(config, agent, excerpt) {
	const body = [
		"✅ 任务完成",
		`Agent: ${shortId(agent.id)}`,
		`时间: ${timestamp()}`
	];
	if (excerpt) body.push("----------", truncate(excerpt, config.maxContentLength));
	return render(config, body);
}

function buildError(config, agent, turn, message) {
	const body = [
		"❌ 任务出错",
		`Agent: ${shortId(agent.id)}`,
		`时间: ${timestamp()}`
	];
	if (turn) body.push(`轮次: ${turn}`);
	body.push(`错误: ${truncate(message, config.maxContentLength)}`);
	return render(config, body);
}

function buildQuestion(config, sessionId, questions) {
	const body = [
		"❓ 需要您的确认 / 选择",
		`Agent: ${shortId(sessionId)}`,
		`时间: ${timestamp()}`
	];
	if (questions.length === 0) {
		body.push("（无具体问题文本，请到会话中查看）");
	} else {
		for (const question of questions.slice(0, 5)) {
			const header = question?.header ? `[${question.header}] ` : "";
			body.push(`- ${header}${question?.question ?? "(无问题文本)"}`);
			if (Array.isArray(question?.options) && question.options.length) {
				body.push(`  选项: ${question.options.map((option) => option?.label ?? option).join(" / ")}`);
			}
		}
	}
	return render(config, body);
}

/** 发送企业微信群机器人 webhook；任何失败只记日志，绝不影响主流程。 */
async function sendWebhook(ctx, config, content) {
	const isMarkdown = config.msgType === "markdown";
	let payload;
	if (isMarkdown) {
		let markdown = content;
		if (config.mentionAll) markdown = `${markdown}\n<@all>`;
		for (const userid of config.mentionedList) markdown = `${markdown}\n<@${userid}>`;
		payload = { msgtype: "markdown", markdown: { content: markdown } };
	} else {
		const text = { content };
		if (config.mentionAll) text.mentioned_list = ["@all"];
		else if (config.mentionedList.length) text.mentioned_list = config.mentionedList;
		if (config.mentionedMobileList.length) text.mentioned_mobile_list = config.mentionedMobileList;
		payload = { msgtype: "text", text };
	}
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), config.timeoutMs);
	try {
		const response = await fetch(config.webhookUrl, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(payload),
			signal: controller.signal
		});
		let result = null;
		try {
			result = await response.json();
		} catch {
			/* 非 JSON 响应 */
		}
		if (!response.ok || (result && result.errcode !== 0)) {
			ctx.logger.warn(`wecom-notify: webhook 返回异常 (HTTP ${response.status}): ${JSON.stringify(result)}`);
		}
	} catch (error) {
		ctx.logger.warn(`wecom-notify: webhook 发送失败: ${error instanceof Error ? error.message : String(error)}`);
	} finally {
		clearTimeout(timer);
	}
}

function apply(ctx, config) {
	/** 当前处于运行中的 agent 集合（WeakSet，避免泄漏）。 */
	const runningAgents = new WeakSet();
	/** 已通知过的错误，按 agent:turn:step 去重。 */
	const sentErrors = new Set();
	/** 已通知过的用户询问，按 agentId:turn 去重。 */
	const sentQuestions = new Set();

	ctx.on("agent/status", ({ agent, status }) => {
		if (status === "running") {
			runningAgents.add(agent);
			return;
		}
		if (status !== "idle" || !runningAgents.has(agent)) return;
		runningAgents.delete(agent);
		if (!config.notifyComplete && !config.notifyQuestion) return;
		const reason = lastTurnReason(agent.session);
		if (config.notifyComplete && reason?.kind === "completed") {
			const excerpt = extractAssistantText(agent.session);
			sendWebhook(ctx, config, buildComplete(config, agent, excerpt));
		} else if (config.notifyQuestion && reason?.kind === "blocked") {
			const key = `${agent.id}:${reason.turn ?? lastTurnNumber(agent.session)}`;
			if (sentQuestions.has(key)) return;
			sentQuestions.add(key);
			sendWebhook(ctx, config, buildQuestion(config, agent.id, []));
		}
	});

	ctx.on("agent/error", ({ agent, turn, step, error }) => {
		if (!config.notifyError) return;
		const key = `${agent.id}:${turn}:${step}`;
		if (sentErrors.has(key)) return;
		sentErrors.add(key);
		const message = error instanceof Error ? error.message : String(error);
		sendWebhook(ctx, config, buildError(config, agent, turn, message));
	});

	ctx.on("session/event", (session, event) => {
		if (!config.notifyQuestion) return;
		if (event?.type !== "tool/call") return;
		const data = event.data ?? {};
		if (data.name !== "ask_user_question") return;
		const key = `${session.id}:${data.turn}`;
		if (sentQuestions.has(key)) return;
		sentQuestions.add(key);
		sendWebhook(ctx, config, buildQuestion(config, session.id, parseQuestions(data.arguments)));
	});
}

/** 取会话中最后一个 turn 编号，用于 blocked 场景去重。 */
function lastTurnNumber(session) {
	const events = session?.events;
	if (!Array.isArray(events)) return 0;
	for (let i = events.length - 1; i >= 0; i--) {
		if (events[i]?.type === "turn/start") return events[i].data?.turn ?? 0;
	}
	return 0;
}

export { Config, apply, inject, name };
