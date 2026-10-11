import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AcceptanceSpec } from "./spec";

export type Fingerprint = Map<string, number | bigint>;

export interface CheckResult {
	pass: boolean;
	output: string;
	timedOut: boolean;
}

export interface TaskOutcome {
	todo: string;
	claimed: string;
	pass: boolean;
	checked: boolean;
	output: string;
}

export type Verdict = "PASS" | "INCOMPLETE" | "FAIL";

export interface Evaluation {
	verdict: Verdict;
	tasks: TaskOutcome[];
	unexpected: string[];
	forbidden: { file: string; reason: string }[];
	problems: string[];
}

/** Content hash of every file under `cwd`. */
export async function fingerprint(cwd: string): Promise<Fingerprint> {
	const files: Fingerprint = new Map();
	for (const rel of await fs.readdir(cwd, { recursive: true })) {
		// Only .git is skipped: an agent that has read the guard hides files in whatever it skips (node_modules, once).
		if (/^\.git(\/|$)/.test(rel)) continue;
		const abs = path.join(cwd, rel);
		if ((await fs.stat(abs)).isFile()) files.set(rel, Bun.hash(await fs.readFile(abs)));
	}
	return files;
}

export async function makeCheckHome(): Promise<string> {
	return fs.mkdtemp(path.join(os.tmpdir(), "acceptance-home-"));
}

/** Runs one check command in `cwd` with a fresh HOME, so configs the agent planted in its own home stay out. */
export async function runCheck(cwd: string, command: string, options: { home: string; timeoutMs: number }): Promise<CheckResult> {
	const env = { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: options.home };
	const started = performance.now();
	const proc = Bun.spawn({
		cmd: ["sh", "-c", command],
		cwd,
		env,
		stdout: "pipe",
		stderr: "pipe",
		timeout: Math.max(1, Math.floor(options.timeoutMs)),
	});
	const stdout = new Response(proc.stdout).text();
	const stderr = new Response(proc.stderr).text();
	const code = await proc.exited;
	// A process the check left running (a server, say) can hold the pipes open; stop waiting for it.
	const grace = Bun.sleep(500).then(() => "");
	const [out, err] = await Promise.all([Promise.race([stdout, grace]), Promise.race([stderr, grace])]);
	const timedOut = proc.signalCode !== null && performance.now() - started >= options.timeoutMs - 50;
	if (timedOut) return { pass: false, output: `timed out after ${Math.round(options.timeoutMs)} ms`, timedOut };
	const lines = `${out}\n${err}`
		.split("\n")
		.map(l => l.trim())
		.filter(Boolean);
	const errors = lines.filter(l => /error/i.test(l));
	return {
		pass: code === 0 && proc.signalCode === null,
		output: (errors.length > 0 ? errors.slice(0, 2) : lines.slice(-2)).join(" | "),
		timedOut,
	};
}

export function changedFiles(before: Fingerprint, after: Fingerprint): string[] {
	return [...new Set([...before.keys(), ...after.keys()])].filter(f => before.get(f) !== after.get(f)).sort();
}

/** Forbidden content in changed files that are on the allowed list (files off the list are reported on their own). */
export async function forbiddenHits(
	spec: Pick<AcceptanceSpec, "allowedChanges" | "forbid">,
	cwd: string,
	changed: readonly string[],
): Promise<{ file: string; reason: string }[]> {
	const hits: { file: string; reason: string }[] = [];
	for (const file of changed) {
		if (!spec.allowedChanges.includes(file)) continue;
		let text: string;
		try {
			text = await Bun.file(path.join(cwd, file)).text();
		} catch {
			continue; // deleted
		}
		for (const rule of spec.forbid) {
			if (new RegExp(rule.files ?? "").test(file) && new RegExp(rule.pattern).test(text)) hits.push({ file, reason: rule.reason });
		}
	}
	return hits;
}

interface TodoToolResult {
	role?: string;
	toolName?: string;
	isError?: boolean;
	details?: { phases?: { tasks: { content: string; status: string }[] }[] };
}

/** Latest status of each todo item, from the last successful todo tool result. Keys are lower-cased titles. */
export function claimedStatuses(messages: readonly unknown[]): Map<string, string> {
	for (const m of [...messages].reverse() as TodoToolResult[]) {
		if (m?.role !== "toolResult" || m.toolName !== "todo" || m.isError || !m.details?.phases) continue;
		const tasks = m.details.phases.flatMap(p => p.tasks);
		return new Map(tasks.map(t => [t.content.trim().toLowerCase(), t.status]));
	}
	return new Map();
}

export function claimedFor(claimed: Map<string, string>, todo: string): string {
	const key = todo.toLowerCase();
	return [...claimed].find(([content]) => content.includes(key))?.[1] ?? "missing";
}

export interface Phase {
	name: string;
	tasks: { content: string; status: string }[];
}

/** Each spec task's latest todo status ("missing" when no item carries its title). */
export function claimsBySpecTask(spec: Pick<AcceptanceSpec, "tasks">, claimed: Map<string, string>): Record<string, string> {
	return Object.fromEntries(spec.tasks.map(task => [task.todo, claimedFor(claimed, task.todo)]));
}

export function claimedFromPhases(phases: readonly Phase[]): Map<string, string> {
	return new Map(phases.flatMap(p => p.tasks).map(t => [t.content.trim().toLowerCase(), t.status]));
}

const DECLARED_UNFINISHED = new Set(["blocked", "abandoned"]);

/**
 * Reruns every check (inside `budgetMs`), maps each to the agent's claim, and compares the tree with the
 * baseline. A task the budget did not reach counts as a problem unless the agent declared it unfinished.
 */
export async function evaluate(input: {
	spec: AcceptanceSpec;
	cwd: string;
	baseline: Fingerprint | undefined;
	claimed: Map<string, string>;
	budgetMs: number;
}): Promise<Evaluation> {
	const { spec, cwd, baseline, claimed, budgetMs } = input;
	const deadline = performance.now() + budgetMs;
	const tasks: TaskOutcome[] = [];
	const problems: string[] = [];
	const unchecked: string[] = [];
	let unexpected: string[] = [];
	let forbidden: { file: string; reason: string }[] = [];
	const home = await makeCheckHome();
	try {
		for (const task of spec.tasks) {
			const status = claimedFor(claimed, task.todo);
			const remaining = deadline - performance.now();
			if (remaining <= 0) {
				tasks.push({ todo: task.todo, claimed: status, pass: false, checked: false, output: "not checked: the time budget ran out" });
				if (!DECLARED_UNFINISHED.has(status)) unchecked.push(task.todo);
				continue;
			}
			const result = await runCheck(cwd, task.check, { home, timeoutMs: Math.min(spec.checkTimeoutMs, remaining) });
			tasks.push({ todo: task.todo, claimed: status, pass: result.pass, checked: true, output: result.output });
			if (result.pass || DECLARED_UNFINISHED.has(status)) continue;
			const failure = `its acceptance check \`${task.check}\` fails: ${result.output || "(no output)"}`;
			if (status === "completed") problems.push(`"${task.todo}" is marked completed, but ${failure}`);
			else if (status === "missing") problems.push(`No todo item is titled "${task.todo}". Track every task under its exact title.`);
			else problems.push(`"${task.todo}" is still ${status}, and ${failure}`);
		}
		if (unchecked.length > 0) {
			problems.push(`These tasks were not checked because the check time budget ran out: ${unchecked.map(t => `"${t}"`).join(", ")}.`);
		}
		if (!baseline) {
			problems.push("The acceptance check has no record of the tree at session start, so changed files cannot be compared.");
		} else {
			const changed = changedFiles(baseline, await fingerprint(cwd));
			unexpected = changed.filter(f => !spec.allowedChanges.includes(f));
			if (unexpected.length > 0) problems.push(`Files outside the allowed change list were changed: ${unexpected.join(", ")}. Revert them.`);
			forbidden = await forbiddenHits(spec, cwd, changed);
			for (const hit of forbidden) problems.push(`${hit.file} now contains ${hit.reason}. Remove it.`);
		}
	} finally {
		await fs.rm(home, { recursive: true, force: true });
	}
	const allPassed = tasks.length > 0 && tasks.every(t => t.pass) && unexpected.length === 0;
	const verdict: Verdict = problems.length > 0 ? "FAIL" : allPassed ? "PASS" : "INCOMPLETE";
	return { verdict, tasks, unexpected, forbidden, problems };
}
