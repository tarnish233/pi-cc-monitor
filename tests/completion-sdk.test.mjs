/** Complete Pi SDK agent-loop checks with scripted responses, no network or real credentials. */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { extensionDir, findPiInstall } from "./helpers.mjs";

const { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } =
	await import(pathToFileURL(findPiInstall().piCodingAgent).href);

async function until(predicate) {
	const deadline = Date.now() + 5000;
	while (Date.now() < deadline) {
		if (await predicate()) return;
		await new Promise(resolve => setTimeout(resolve, 10));
	}
	throw new Error("SDK fixture did not reach the expected state");
}

const terminalEntries = session => session.sessionManager.getBranch().filter(entry =>
	entry.type === "custom_message" && entry.customType === "Monitor" && entry.details?.cause === "exit");
const hasCompletion = messages => messages.some(message =>
	message.role === "custom" && message.customType === "Monitor" && message.details?.status === "completed");

const cases = [
	{ boundary: "tool batch", terminal: "turn" },
	{ boundary: "streamed text", terminal: "turn" },
	{ boundary: "tool batch", terminal: "turn", jobs: 2 },
	{ boundary: "streamed text", terminal: "turn", queued: true },
	{ boundary: "streamed text", terminal: "turn", aborted: true },
];
for (const { boundary, terminal, jobs = 1, queued = false, aborted = false } of cases) {
	test(`real SDK safe ${boundary}: terminal=${terminal}, jobs=${jobs}, queued=${queued}, aborted=${aborted}`, async t => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "monitor-sdk-"));
		const cwd = path.join(root, "project"), agentDir = path.join(root, "agent");
		fs.mkdirSync(cwd);
		fs.mkdirSync(agentDir);
		const release = path.join(cwd, "release");
		const provider = `monitor-fixture-${boundary.replaceAll(" ", "-")}`;
		const model = {
			id: "scripted", name: "scripted", api: "openai-completions", provider,
			baseUrl: "http://127.0.0.1:1", reasoning: false, input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128000, maxTokens: 1024,
		};
		const settingsManager = SettingsManager.inMemory({
			cacheWarming: "off", compaction: { enabled: false }, retry: { enabled: false },
		});
		const modelRuntime = await ModelRuntime.create({
			authPath: path.join(agentDir, "auth.json"), modelsPath: null, refreshOnCreate: false,
		});
		modelRuntime.registerProvider(provider, {
			api: model.api, baseUrl: model.baseUrl, apiKey: "fixture-not-a-real-credential", models: [model],
			streamSimple: () => { throw new Error("Provider/network calls are forbidden in this fixture"); },
		});
		let session, abortPromise;
		const errors = [], events = [], requests = [];
		const expectedRequests = aborted || boundary === "streamed text" && terminal === "context" ? 2 : 3;
		t.after(async () => {
			try {
				if (session) await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
			} finally {
				session?.dispose();
				modelRuntime.unregisterProvider(provider);
				fs.rmSync(root, { recursive: true, force: true });
			}
		});
		const completeDuringCurrentWork = async () => {
			fs.writeFileSync(release, "go");
			await until(async () => {
				const runner = session.extensionRunner;
				const list = await runner.getToolDefinition("monitor_list").execute("inspect", {}, undefined, undefined, runner.createContext());
				return list.details.monitors.length === jobs && list.details.monitors.every(item => item.status === "completed");
			});
			assert.equal(terminalEntries(session).length, 0, "completion is not inserted mid-response or mid-batch");
		};
		const loader = new DefaultResourceLoader({
			cwd, agentDir, settingsManager,
			additionalExtensionPaths: [path.join(extensionDir, "index.ts")],
			noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
			extensionFactories: [pi => pi.registerTool({
				name: "independent_work", label: "Independent work", description: "Fixture independent analysis",
				parameters: { type: "object", properties: {}, additionalProperties: false },
				async execute() {
					await completeDuringCurrentWork();
					return { content: [{ type: "text", text: "Independent analysis finished" }], details: {} };
				},
			})],
		});
		await loader.reload();
		assert.deepEqual(loader.getExtensions().errors, []);
		({ session } = await createAgentSession({
			cwd, agentDir, model, modelRuntime, thinkingLevel: "off", settingsManager,
			resourceLoader: loader, sessionManager: SessionManager.inMemory(cwd), noTools: true,
		}));
		await session.bindExtensions({ mode: "print", onError: error => errors.push(error) });
		session.subscribe(event => events.push(event.type));
		const code = "const fs=require('node:fs');const timer=setInterval(()=>{if(fs.existsSync(process.argv[1])){clearInterval(timer);console.log('SDK-COMPLETED')}},10)";
		const command = `${JSON.stringify(process.execPath)} -e ${JSON.stringify(code)} ${JSON.stringify(release)}`;
		// Keep real AgentSession request preparation, tool execution, persistence,
		// boundaries and settlement; only replace the provider's response stream.
		session.agent.streamFunction = async (_model, context) => {
			const index = requests.length;
			requests.push(structuredClone(context.messages));
			assert.ok(index < expectedRequests, "no duplicate request or context-only/aborted wakeup");
			let content;
			if (index === 0) {
				content = Array.from({ length: jobs }, (_, job) => ({
					type: "toolCall", id: `launch-${job}`, name: "Monitor", arguments: {
						command, mode: "completion", description: `SDK completion ${job}`, timeout_ms: 10000,
					},
				}));
			} else if (index === 1) {
				assert.equal(hasCompletion(context.messages), false, "the fixture is still running at this request");
				content = boundary === "tool batch"
					? [{ type: "toolCall", id: "independent", name: "independent_work", arguments: {} }]
					: [{ type: "text", text: "Independent phase finished; ready to incorporate the background result" }];
			} else {
				assert.equal(hasCompletion(context.messages), true, "the next provider request includes completed");
				assert.equal(terminalEntries(session).length, jobs);
				if (queued) assert.ok(context.messages.some(message => message.role === "user" &&
					(typeof message.content === "string" ? message.content : message.content.map(block => block.text ?? "").join("")) === "Separate queued request"));
				if (boundary === "tool batch") {
					const notice = context.messages.findIndex(message => message.role === "custom" && message.customType === "Monitor");
					const result = context.messages.findIndex(message => message.role === "toolResult" && message.toolCallId === "independent");
					assert.ok(result >= 0 && notice > result, "the completion follows the complete tool batch");
				}
				content = [{ type: "text", text: "Final response using SDK-COMPLETED" }];
			}
			const message = {
				role: "assistant", api: model.api, provider, model: model.id, content,
				stopReason: content[0].type === "toolCall" ? "toolUse" : "stop", timestamp: Date.now(),
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
			};
			return {
				async *[Symbol.asyncIterator]() {
					yield { type: "start", partial: { ...message, content: [], stopReason: "pending" } };
					if (index === 1 && boundary === "streamed text") {
						await completeDuringCurrentWork();
						if (queued) await session.followUp("Separate queued request");
						if (aborted) {
							abortPromise = session.abort();
							throw Object.assign(new Error("fixture aborted"), { name: "AbortError" });
						}
					}
					yield { type: "done", reason: message.stopReason, message };
				},
				result: async () => message,
			};
		};
		await session.prompt("Start background work and continue independent analysis before using its result");
		await abortPromise;
		assert.equal(requests.length, expectedRequests);
		assert.equal(terminalEntries(session).length, jobs);
		assert.ok(terminalEntries(session).every(entry => entry.details.stdoutTail.includes("SDK-COMPLETED")));
		assert.equal(events.filter(type => type === "agent_start").length, 1, "the original agent run continues");
		assert.equal(events.filter(type => type === "agent_settled").length, 1, "no stale result launches another run");
		assert.equal(session.isIdle, true);
		assert.deepEqual(errors, []);
	});
}
