import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import {
	type Evaluation,
	type Fingerprint,
	type Phase,
	type Verdict,
	changedFiles,
	claimedFromPhases,
	claimedStatuses,
	claimsBySpecTask,
	evaluate,
	fingerprint,
	forbiddenHits,
	lastTodoPhases,
	makeCheckHome,
	runCheck,
} from "./checks";
import { DEFAULTS, type ResolvedSpec, isDedicatedFolder, resolveSpec } from "./spec";

const WITHHELD = "[withheld: this output shows the acceptance spec, which is not for the agent to read]";
const REFUSED =
	"Not run: this call names the acceptance spec or the acceptance tooling, which are not for the agent to read or change. Work on the tasks instead.";
const WIDGET = "acceptance";
const BASELINE_ENTRY = "acceptance-baseline";
const USAGE = "usage: /acceptance status | /acceptance check";
const PACKAGE_DIR = path.resolve(import.meta.dir, "..");
// The skill invocation points the agent at this folder, so it stays readable.
const SKILLS_DIR = path.join(PACKAGE_DIR, "skills");
// Tools that only look: their results do not change the work tree or the todo claims.
const READ_ONLY_TOOLS = new Set(["read", "grep", "find", "glob", "ls", "lsp", "ast_grep", "web_search", "fetch"]);

type RecordVerdict = Verdict | "UNCHECKED";
type Trigger = "session_stop" | "update" | "shutdown";

interface LastCheck {
	verdict: Verdict;
	tasks: Evaluation["tasks"];
	unexpected: string[];
	problems: string[];
	checkedAt: string;
}

interface VerdictFile {
	verdict: RecordVerdict;
	blocks: number;
	checkedAt: string | null;
	tasks: Evaluation["tasks"];
	unexpected: string[];
	problems: string[];
	/** True when the work or the todo claims changed after the last session-end check, or no check ran. */
	stale: boolean;
	claims: Record<string, string>;
	claimsAt: string;
	trigger: Trigger;
}

function namesProtected(text: string, markers: readonly string[], packageDir: string | undefined): boolean {
	const lowered = text.toLowerCase();
	if (markers.some(marker => lowered.includes(marker.toLowerCase()))) return true;
	if (!packageDir) return false;
	return lowered.split(SKILLS_DIR.toLowerCase()).join("").includes(packageDir.toLowerCase());
}

export default function acceptanceWorkflow(pi: ExtensionAPI): void {
	pi.setLabel("Acceptance workflow");
	pi.registerFlag("acceptance", {
		type: "string",
		description: "Path to the acceptance spec written by whoever assigns the work; keep it outside the working directory",
	});

	let baseline: Fingerprint | undefined;
	let phases: Phase[] = [];
	let blocks = 0;
	let markers: string[] = [];
	let current: ResolvedSpec = { status: "off" };
	let lastCheck: LastCheck | undefined;
	let changedSinceCheck = false;
	let recordWritten = false;

	const resolve = async (cwd: string): Promise<ResolvedSpec> => {
		current = await resolveSpec(pi.getFlag("acceptance"), cwd);
		if (current.status !== "off") markers = current.markers;
		return current;
	};
	// The package folder is protected only when the agent is not working inside it.
	const packageGuard = (cwd: string): string | undefined => (isDedicatedFolder(PACKAGE_DIR, cwd) ? PACKAGE_DIR : undefined);

	async function writeRecord(trigger: Trigger, claims?: Record<string, string>): Promise<void> {
		if (current.status !== "ok") return;
		const record: VerdictFile = {
			verdict: lastCheck?.verdict ?? "UNCHECKED",
			blocks,
			checkedAt: lastCheck?.checkedAt ?? null,
			tasks: lastCheck?.tasks ?? [],
			unexpected: lastCheck?.unexpected ?? [],
			problems: lastCheck?.problems ?? [],
			stale: !lastCheck || changedSinceCheck,
			claims: claims ?? claimsBySpecTask(current.spec, claimedFromPhases(phases)),
			claimsAt: new Date().toISOString(),
			trigger,
		};
		await Bun.write(current.verdictPath, JSON.stringify(record, null, 2));
		recordWritten = true;
	}

	/**
	 * The tree as this session's work began. The first start saves it in the session, so a session
	 * resumed later (`omp --continue`, `--resume`, `/resume`) compares against where the work started,
	 * not against whatever the agent left before the restart. Saved per spec, so a session reused for
	 * another assignment starts that one fresh.
	 */
	async function beginWork(ctx: ExtensionContext, specPath: string): Promise<void> {
		const entries = ctx.sessionManager.getBranch() as Array<{ type?: string; customType?: string; data?: unknown; message?: unknown }>;
		const saved = entries.findLast(e => e.type === "custom" && e.customType === BASELINE_ENTRY && (e.data as { spec?: unknown } | undefined)?.spec === specPath);
		const files = (saved?.data as { files?: Record<string, string> } | undefined)?.files;
		baseline = files ? new Map(Object.entries(files)) : await fingerprint(ctx.cwd);
		phases = lastTodoPhases(entries.filter(e => e.type === "message").map(e => e.message)) ?? [];
		if (files) return;
		try {
			pi.appendEntry(BASELINE_ENTRY, { spec: specPath, files: Object.fromEntries(baseline) });
		} catch {
			// No session runtime to keep it in: the snapshot then lasts for this process only, as before.
		}
	}

	pi.on("session_start", async (_event, ctx) => {
		const resolved = await resolve(ctx.cwd);
		if (resolved.status === "off") return;
		await beginWork(ctx, resolved.specPath);
		if (resolved.status === "error") {
			ctx.ui.notify(`acceptance: ${resolved.reason}`, "error");
			return;
		}
		// A record left by an earlier session no longer describes this one.
		try {
			const previous = (await Bun.file(resolved.verdictPath).json()) as Partial<VerdictFile>;
			await Bun.write(resolved.verdictPath, JSON.stringify({ ...previous, stale: true, trigger: "update" }, null, 2));
		} catch {
			// no earlier record
		}
	});

	// /new and /resume inside one omp process switch sessions without a new session_start.
	pi.on("session_switch", async (_event, ctx) => {
		const resolved = await resolve(ctx.cwd);
		if (resolved.status === "off") return;
		blocks = 0;
		lastCheck = undefined;
		changedSinceCheck = false;
		recordWritten = false;
		await beginWork(ctx, resolved.specPath);
	});

	pi.on("tool_result", async (event, ctx) => {
		if (event.toolName === "todo" && !event.isError) {
			const next = (event as { details?: { phases?: Phase[] } }).details?.phases;
			if (next) phases = next;
		}
		if (current.status === "ok" && !READ_ONLY_TOOLS.has(event.toolName)) {
			const firstChange = !changedSinceCheck;
			changedSinceCheck = true;
			if (event.toolName === "todo" && !event.isError) await writeRecord("update");
			else if (firstChange && recordWritten) await writeRecord("update");
		}
		if (markers.length === 0) return;
		const text = event.content.map(c => (c.type === "text" ? c.text : "")).join("\n");
		if (!namesProtected(text, markers, packageGuard(ctx.cwd))) return;
		return { content: [{ type: "text", text: WITHHELD }] };
	});

	// Refuse calls that name the spec, the verdict, or this package; then gate todo `done`. omp blocks on a returned block (and on a throw).
	pi.on("tool_call", async (event, ctx) => {
		const resolved = await resolve(ctx.cwd);
		if (resolved.status === "off") return;
		if (namesProtected(JSON.stringify(event.input ?? {}), resolved.markers, packageGuard(ctx.cwd))) {
			return { block: true, reason: REFUSED };
		}
		if (event.toolName !== "todo") return;
		const input = event.input as { op?: string; task?: string; phase?: string };
		if (input.op !== "done") return;
		if (resolved.status === "error") return { block: true, reason: `Not marked done: ${resolved.reason}` };
		const { spec } = resolved;
		const known = phases.flatMap(p => p.tasks.map(t => ({ phase: p.name, content: t.content })));
		const targets = input.task ? [input.task] : known.filter(t => !input.phase || t.phase === input.phase).map(t => t.content);
		const problems: string[] = [];
		const home = await makeCheckHome();
		try {
			for (const content of targets) {
				const item = spec.tasks.find(t => content.toLowerCase().includes(t.todo.toLowerCase()));
				if (!item) continue;
				const result = await runCheck(ctx.cwd, item.check, { home, timeoutMs: spec.checkTimeoutMs });
				if (!result.pass) problems.push(`"${item.todo}": its acceptance check \`${item.check}\` fails: ${result.output || "(no output)"}`);
			}
			if (!baseline) {
				problems.push("there is no record of the tree at session start, so changed files cannot be compared");
			} else {
				const changed = changedFiles(baseline, await fingerprint(ctx.cwd));
				const unexpected = changed.filter(f => !spec.allowedChanges.includes(f));
				if (unexpected.length > 0) problems.push(`files outside the allowed change list were changed: ${unexpected.join(", ")}`);
				for (const hit of await forbiddenHits(spec, ctx.cwd, changed)) problems.push(`${hit.file} now contains ${hit.reason}`);
			}
		} finally {
			await fs.rm(home, { recursive: true, force: true });
		}
		if (problems.length === 0) return;
		return {
			block: true,
			reason: `Not marked done:\n- ${problems.join("\n- ")}\nFix it so the check passes, or use op "block" with the reason.`,
		};
	});

	// Session-end check: rerun everything, write the verdict, and return the work while problems remain.
	pi.on("session_stop", async (event, ctx) => {
		const resolved = await resolve(ctx.cwd);
		if (resolved.status === "off") return;
		if (!event.stop_hook_active) blocks = 0;
		if (resolved.status === "error") {
			if (blocks >= DEFAULTS.maxBlocks) return;
			blocks++;
			return { decision: "block", reason: blockReason([resolved.reason], blocks, DEFAULTS.maxBlocks) };
		}
		const { spec } = resolved;
		const claimed = claimedStatuses(event.messages);
		const result = await evaluate({ spec, cwd: ctx.cwd, baseline, claimed, budgetMs: spec.stopBudgetMs });
		lastCheck = {
			verdict: result.verdict,
			tasks: result.tasks,
			unexpected: result.unexpected,
			problems: result.problems,
			checkedAt: new Date().toISOString(),
		};
		changedSinceCheck = false;
		await writeRecord("session_stop", claimsBySpecTask(spec, claimed));
		if (result.problems.length === 0 || blocks >= spec.maxBlocks) return;
		blocks++;
		return { decision: "block", reason: blockReason(result.problems, blocks, spec.maxBlocks) };
	});

	// omp gives shutdown handlers 2 s, so this records the final claims and staleness without rerunning checks.
	pi.on("session_shutdown", async () => {
		if (current.status === "ok") await writeRecord("shutdown");
	});

	pi.registerCommand("acceptance", {
		description: "Show the last acceptance result (status) or rerun the acceptance checks now (check)",
		handler: async (args, ctx) => {
			const sub = args.trim().split(/\s+/)[0] ?? "";
			const lines = await commandLines(sub, ctx);
			ctx.ui.setWidget(WIDGET, lines);
			ctx.ui.notify(lines[0] ?? USAGE, "info");
		},
	});

	async function commandLines(sub: string, ctx: ExtensionCommandContext): Promise<string[]> {
		if (sub !== "" && sub !== "status" && sub !== "check") return [USAGE];
		const resolved = await resolve(ctx.cwd);
		if (resolved.status === "off") return ["acceptance: no spec is configured (start omp with --acceptance <path>)", USAGE];
		if (resolved.status === "error") return [`acceptance: ${resolved.reason}`, `spec: ${resolved.specPath}`];
		if (sub === "check") {
			const result = await evaluate({
				spec: resolved.spec,
				cwd: ctx.cwd,
				baseline,
				claimed: claimedStatuses(branchMessages(ctx)),
				budgetMs: resolved.spec.stopBudgetMs,
			});
			return [`acceptance check (not saved): ${result.verdict}`, ...taskLines(result.tasks), ...result.problems.map(p => `problem: ${p}`)];
		}
		let record: Partial<VerdictFile>;
		try {
			record = await Bun.file(resolved.verdictPath).json();
		} catch {
			return ["acceptance: no result yet (it is written when the agent finishes)", `spec: ${resolved.specPath}`, ...(sub ? [] : [USAGE])];
		}
		const head =
			record.verdict === "UNCHECKED"
				? `acceptance: no session-end check ran — latest todos below (updated ${record.claimsAt})`
				: `acceptance: ${record.verdict}${record.stale ? " — stale: the work changed after this check, latest todos below" : ""} (returned ${record.blocks} time(s), checked ${record.checkedAt})`;
		const claims = record.stale && record.claims ? Object.entries(record.claims).map(([todo, status]) => `todo now: ${status}  ${todo}`) : [];
		return [
			head,
			...claims,
			...taskLines(record.tasks ?? []),
			...(record.problems ?? []).map(p => `problem: ${p}`),
			...(sub ? [] : [USAGE]),
		];
	}
}

function blockReason(problems: string[], attempt: number, max: number): string {
	return (
		`Acceptance check ${attempt}/${max} before you finish:\n- ${problems.join("\n- ")}\n` +
		"Fix each item so its check passes, or mark the task blocked with the reason. " +
		"Do not edit the checks or files outside the allowed change list."
	);
}

function taskLines(tasks: Evaluation["tasks"]): string[] {
	return tasks.map(t => `${t.pass ? "pass" : t.checked ? "fail" : "not checked"}  ${t.todo}  (todo: ${t.claimed})`);
}

function branchMessages(ctx: ExtensionCommandContext): unknown[] {
	return ctx.sessionManager
		.getBranch()
		.flatMap(entry => (entry.type === "message" ? [entry.message as unknown] : []));
}
