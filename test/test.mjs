// dsh-wecom-notify 本地测试：
// 起一个本地 HTTP 服务扮演企业微信 webhook，用真实 cordis 事件总线
// 模拟三类信号（任务完成 / 报错 / 需要用户选择），断言收到的消息体。
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { Context } from "@deepseek-ai/cordis";
import * as plugin from "../lib/index.js";

/** 启动本地 mock 企业微信 webhook 服务器。 */
async function startWebhookServer() {
	const received = [];
	const server = http.createServer((req, res) => {
		let body = "";
		req.on("data", (chunk) => (body += chunk));
		req.on("end", () => {
			received.push({ url: req.url, body: JSON.parse(body) });
			res.writeHead(200, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ errcode: 0, errmsg: "ok" }));
		});
	});
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const { port } = server.address();
	return { server, received, url: `http://127.0.0.1:${port}/cgi-bin/webhook/send?key=test` };
}

/** 创建带插件实例的上下文（等待插件 fiber 完成加载）。 */
async function createContext(config) {
	const ctx = new Context();
	const fiber = await ctx.plugin(plugin, config);
	return { ctx, fiber };
}

/** 关闭插件 fiber 与上下文。 */
function disposeContext({ ctx, fiber }) {
	fiber?.dispose?.();
	ctx.registry?.fibers?.clear?.();
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 30));

const mkAgent = (id = "agent-1", events = []) => ({
	id,
	session: { id: `session-${id}`, events }
});

// 事件投递（与 dsh-agent 的 fused dispatcher 形状一致）：
//   agent 事件：ctx.emit(carrier, "agent/status", { agent, status })
//   session 事件：ctx.emit("session/event", session, event)
const carrier = {};

async function main() {
	// ── 场景 1：任务完成（text）────────────────────────────
	{
		const { server, received, url } = await startWebhookServer();
		const { ctx } = await createContext({ webhookUrl: url, msgType: "text", title: "测试通知" });
		const events = [
			{ type: "turn/start", data: { turn: 1 } },
			{ type: "assistant/message", data: { turn: 1, step: 1, message: { role: "assistant", content: [{ type: "text", text: "你好，任务完成！" }, { type: "text", text: "第二行。" }] } } },
			{ type: "turn/end", data: { turn: 1, reason: { kind: "completed" } } }
		];
		const agent = mkAgent("agent-1", events);
		ctx.emit(carrier, "agent/status", { agent, status: "running" });
		ctx.emit(carrier, "agent/status", { agent, status: "idle" });
		await tick();
		assert.equal(received.length, 1, "场景1：应收到 1 条完成通知");
		const msg = received[0];
		assert.equal(msg.body.msgtype, "text");
		assert.match(msg.body.text.content, /✅ 任务完成/);
		assert.match(msg.body.text.content, /测试通知/);
		assert.match(msg.body.text.content, /你好，任务完成！\n第二行。/);
		assert.ok(!("mentioned_list" in msg.body.text), "场景1：未配置 mention 时不应带 mentioned_list");
		console.log("✓ 场景1 任务完成(text):", JSON.stringify(msg.body.text.content));
		disposeContext({ ctx });
		server.close();
	}

	// ── 场景 2：任务出错（markdown）──────────────────────────
	{
		const { server, received, url } = await startWebhookServer();
		const { ctx } = await createContext({ webhookUrl: url, msgType: "markdown", title: "测试通知" });
		const agent = mkAgent("agent-2");
		ctx.emit(carrier, "agent/error", { agent, turn: 3, step: 2, error: new Error("模型接口超时 boom") });
		await tick();
		assert.equal(received.length, 1, "场景2：应收到 1 条错误通知");
		const msg = received[0];
		assert.equal(msg.body.msgtype, "markdown");
		assert.match(msg.body.markdown.content, /\*\*测试通知\*\*/);
		assert.match(msg.body.markdown.content, /❌ 任务出错/);
		assert.match(msg.body.markdown.content, /模型接口超时 boom/);
		assert.match(msg.body.markdown.content, /轮次: 3/);
		console.log("✓ 场景2 任务出错(markdown):", JSON.stringify(msg.body.markdown.content));
		disposeContext({ ctx });
		server.close();
	}

	// ── 场景 3：需要用户选择（ask_user_question，text）────────
	{
		const { server, received, url } = await startWebhookServer();
		const { ctx } = await createContext({ webhookUrl: url, msgType: "text", mentionAll: true });
		const session = { id: "session-q" };
		const event = {
			type: "tool/call",
			seq: 9,
			data: {
				turn: 4,
				step: 1,
				callId: "call-1",
				name: "ask_user_question",
				arguments: JSON.stringify({ questions: [{ id: "q1", header: "确认", question: "是否继续执行？", options: [{ label: "继续" }, { label: "停止" }] }] })
			}
		};
		ctx.emit("session/event", session, event);
		await tick();
		assert.equal(received.length, 1, "场景3：应收到 1 条询问通知");
		const msg = received[0];
		assert.equal(msg.body.msgtype, "text");
		assert.deepEqual(msg.body.text.mentioned_list, ["@all"], "场景3：mentionAll 应生效");
		assert.match(msg.body.text.content, /❓ 需要您的确认/);
		assert.match(msg.body.text.content, /\[确认\] 是否继续执行？/);
		assert.match(msg.body.text.content, /继续 \/ 停止/);
		console.log("✓ 场景3 需要用户选择(text+@all):", JSON.stringify(msg.body.text.content));

		// 同轮重复事件不重复发送
		ctx.emit("session/event", session, event);
		await tick();
		assert.equal(received.length, 1, "场景3：同 turn 重复事件应去重");
		console.log("✓ 场景3 去重生效");
		disposeContext({ ctx });
		server.close();
	}

	// ── 场景 4：开关关闭时不发送 ──────────────────────────────
	{
		const { server, received, url } = await startWebhookServer();
		const { ctx } = await createContext({ webhookUrl: url, notifyComplete: false, notifyError: false, notifyQuestion: false });
		const agent = mkAgent("agent-4", [
			{ type: "turn/start", data: { turn: 1 } },
			{ type: "turn/end", data: { turn: 1, reason: { kind: "completed" } } }
		]);
		ctx.emit(carrier, "agent/status", { agent, status: "running" });
		ctx.emit(carrier, "agent/status", { agent, status: "idle" });
		ctx.emit(carrier, "agent/error", { agent, turn: 1, step: 1, error: new Error("x") });
		ctx.emit("session/event", { id: "s" }, { type: "tool/call", data: { name: "ask_user_question", turn: 1, arguments: "{}" } });
		await tick();
		assert.equal(received.length, 0, "场景4：全部开关关闭时不应发送");
		console.log("✓ 场景4 开关关闭不发送");
		disposeContext({ ctx });
		server.close();
	}

	// ── 场景 5：webhook 返回错误码只记日志不抛错 ─────────────
	{
		const received = [];
		const server = http.createServer((req, res) => {
			req.on("data", () => {});
			req.on("end", () => {
				res.writeHead(200, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ errcode: 93000, errmsg: "invalid webhook url" }));
			});
		});
		server.listen(0, "127.0.0.1");
		await once(server, "listening");
		const url = `http://127.0.0.1:${server.address().port}/bad`;
		const { ctx } = await createContext({ webhookUrl: url });
		const agent = mkAgent("agent-5", [
			{ type: "turn/start", data: { turn: 1 } },
			{ type: "turn/end", data: { turn: 1, reason: { kind: "completed" } } }
		]);
		ctx.emit(carrier, "agent/status", { agent, status: "running" });
		ctx.emit(carrier, "agent/status", { agent, status: "idle" });
		await tick();
		assert.ok(true, "场景5：webhook 失败未抛错");
		console.log("✓ 场景5 webhook 失败仅记日志");
		disposeContext({ ctx });
		server.close();
	}

	console.log("\n全部测试通过 ✅");
}

main().catch((error) => {
	console.error("测试失败:", error);
	process.exit(1);
});
