// CI re-check for the acceptance workflow. Run it at the root of a fresh checkout of the change, with the
// spec taken from a place the agent could not edit (not from the change itself).
// Usage: bun scripts/ci-check.ts --spec <path> --base <ref> [--verdict <path>] [--timeout <ms>]
// Prints a JSON report and exits 0 (PASS), 2 (INCOMPLETE: every failing task was declared blocked or
// abandoned in the session's latest claims), or 1 (FAIL, including a missing verdict and usage or spec errors).
// A current FAIL verdict fails; a stale or UNCHECKED verdict (the work changed after the last session-end
// check, or none ran) is not a result by itself, so this script's own reruns decide.
import * as fs from "node:fs/promises";
import { parseArgs } from "node:util";
import { forbiddenHits, makeCheckHome, runCheck } from "../src/checks";
import { parseSpec } from "../src/spec";

type Result = "PASS" | "INCOMPLETE" | "FAIL";
const EXIT_CODE: Record<Result, number> = { PASS: 0, FAIL: 1, INCOMPLETE: 2 };
const DEFAULT_TIMEOUT_MS = 60_000;

interface Report {
	result: Result;
	tasks: { todo: string; pass: boolean; output: string }[];
	changed: string[];
	outsideAllowed: string[];
	forbidden: { file: string; reason: string }[];
	/** null without --verdict; true when the session's record no longer describes its final state. */
	verdictStale: boolean | null;
	problems: string[];
}

const report: Report = { result: "FAIL", tasks: [], changed: [], outsideAllowed: [], forbidden: [], verdictStale: null, problems: [] };

function finish(result: Result): never {
	report.result = result;
	console.log(JSON.stringify(report, null, 2));
	// A server a check started can keep a pipe, and with it this process, alive.
	process.exit(EXIT_CODE[result]);
}

function git(...args: string[]): string[] {
	const result = Bun.spawnSync(["git", ...args], { cwd: process.cwd() });
	if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr.toString().trim()}`);
	return result.stdout
		.toString()
		.split("\n")
		.map(l => l.trim())
		.filter(Boolean);
}

let args: { spec?: string; base?: string; verdict?: string; timeout?: string };
try {
	args = parseArgs({
		options: { spec: { type: "string" }, base: { type: "string" }, verdict: { type: "string" }, timeout: { type: "string" } },
	}).values;
} catch (err) {
	report.problems.push(`usage: ${err instanceof Error ? err.message : String(err)}`);
	finish("FAIL");
}
if (!args.spec || !args.base) {
	report.problems.push("usage: bun scripts/ci-check.ts --spec <path> --base <ref> [--verdict <path>] [--timeout <ms>]");
	finish("FAIL");
}
const timeoutMs = args.timeout ? Number(args.timeout) : DEFAULT_TIMEOUT_MS;
if (!(timeoutMs > 0)) {
	report.problems.push("--timeout must be a positive number of milliseconds");
	finish("FAIL");
}

let spec: ReturnType<typeof parseSpec>;
try {
	spec = parseSpec(await Bun.file(args.spec).json());
} catch (err) {
	report.problems.push(`the acceptance spec could not be loaded: ${err instanceof Error ? err.message : String(err)}`);
	finish("FAIL");
}

try {
	const committed = git("diff", "--name-only", `${args.base}...HEAD`);
	const uncommitted = git("diff", "--name-only", "HEAD");
	const untracked = git("ls-files", "--others", "--exclude-standard");
	report.changed = [...new Set([...committed, ...uncommitted, ...untracked])].sort();
} catch (err) {
	report.problems.push(`changed files could not be listed: ${err instanceof Error ? err.message : String(err)}`);
	finish("FAIL");
}
report.outsideAllowed = report.changed.filter(f => !spec.allowedChanges.includes(f));
report.forbidden = await forbiddenHits(spec, process.cwd(), report.changed);

const home = await makeCheckHome();
try {
	for (const task of spec.tasks) {
		const result = await runCheck(process.cwd(), task.check, { home, timeoutMs });
		report.tasks.push({ todo: task.todo, pass: result.pass, output: result.output });
	}
} finally {
	await fs.rm(home, { recursive: true, force: true });
}

let declaredUnfinished: Set<string> | undefined;
if (args.verdict) {
	try {
		const verdict = (await Bun.file(args.verdict).json()) as {
			verdict?: string;
			stale?: boolean;
			claims?: Record<string, string>;
			tasks?: { todo: string; claimed: string }[];
		};
		report.verdictStale = verdict.stale === true || verdict.verdict === "UNCHECKED";
		if (!report.verdictStale && verdict.verdict === "FAIL") report.problems.push("the session's verdict is FAIL");
		// The latest claims say which tasks the agent declared unfinished; older records carry them on each task.
		const claims = verdict.claims ? Object.entries(verdict.claims) : (verdict.tasks ?? []).map(t => [t.todo, t.claimed] as const);
		declaredUnfinished = new Set(claims.filter(([, status]) => status === "blocked" || status === "abandoned").map(([todo]) => todo));
	} catch {
		report.problems.push("the session's verdict file is missing or unreadable; a session without a result counts as a failure");
	}
}

if (report.outsideAllowed.length > 0) report.problems.push(`files outside the allowed change list were changed: ${report.outsideAllowed.join(", ")}`);
for (const hit of report.forbidden) report.problems.push(`${hit.file} contains ${hit.reason}`);
const failing = report.tasks.filter(t => !t.pass).map(t => t.todo);
if (report.problems.length > 0) finish("FAIL");
if (failing.length === 0) finish("PASS");
if (declaredUnfinished && failing.every(todo => declaredUnfinished.has(todo))) finish("INCOMPLETE");
report.problems.push(
	`checks failed for tasks the session did not declare unfinished: ${failing.filter(t => !declaredUnfinished?.has(t)).join(", ")}`,
);
finish("FAIL");
