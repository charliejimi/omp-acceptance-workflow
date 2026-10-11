import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

export interface ForbidRule {
	pattern: string;
	reason: string;
	/** Narrows which changed allowed files the rule applies to; matches all when absent. */
	files?: string;
}

export interface AcceptanceTask {
	todo: string;
	check: string;
}

export interface AcceptanceSpec {
	tasks: AcceptanceTask[];
	allowedChanges: string[];
	forbid: ForbidRule[];
	maxBlocks: number;
	checkTimeoutMs: number;
	stopBudgetMs: number;
}

export const DEFAULTS = { maxBlocks: 3, checkTimeoutMs: 4_000, stopBudgetMs: 25_000 } as const;

// Reasons below reach the model, so they never name the spec's path.
export type ResolvedSpec =
	| { status: "off" }
	| { status: "error"; reason: string; specPath: string; markers: string[] }
	| { status: "ok"; spec: AcceptanceSpec; specPath: string; verdictPath: string; markers: string[] };

export function verdictPathFor(specPath: string): string {
	const dir = path.dirname(specPath);
	const name = path.basename(specPath).replace(/\.json$/i, "");
	return path.join(dir, `${name}.verdict.json`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0;
}

function compiles(source: string): boolean {
	try {
		new RegExp(source);
		return true;
	} catch {
		return false;
	}
}

/** Validates a parsed spec and fills defaults; throws with the first problem found. */
export function parseSpec(raw: unknown): AcceptanceSpec {
	if (!isRecord(raw)) throw new Error("the spec is not a JSON object");
	const { tasks, allowedChanges, forbid, maxBlocks, checkTimeoutMs, stopBudgetMs } = raw;
	if (!Array.isArray(tasks) || tasks.length === 0) throw new Error("`tasks` must be a non-empty array");
	for (const [i, task] of tasks.entries()) {
		if (!isRecord(task) || !nonEmptyString(task.todo) || !nonEmptyString(task.check)) {
			throw new Error(`tasks[${i}] needs a non-empty \`todo\` and \`check\``);
		}
	}
	if (!Array.isArray(allowedChanges) || !allowedChanges.every(f => typeof f === "string")) {
		throw new Error("`allowedChanges` must be an array of paths");
	}
	if (forbid !== undefined && !Array.isArray(forbid)) throw new Error("`forbid` must be an array");
	for (const [i, rule] of (forbid ?? []).entries()) {
		if (!isRecord(rule) || typeof rule.pattern !== "string" || !nonEmptyString(rule.reason)) {
			throw new Error(`forbid[${i}] needs a \`pattern\` and a \`reason\``);
		}
		if (!compiles(rule.pattern)) throw new Error(`forbid[${i}].pattern is not a valid regular expression`);
		if (rule.files !== undefined && (typeof rule.files !== "string" || !compiles(rule.files))) {
			throw new Error(`forbid[${i}].files is not a valid regular expression`);
		}
	}
	if (maxBlocks !== undefined && !(Number.isInteger(maxBlocks) && (maxBlocks as number) >= 0)) {
		throw new Error("`maxBlocks` must be a whole number, 0 or more");
	}
	for (const [name, value] of [
		["checkTimeoutMs", checkTimeoutMs],
		["stopBudgetMs", stopBudgetMs],
	] as const) {
		if (value !== undefined && !(typeof value === "number" && value > 0)) throw new Error(`\`${name}\` must be a positive number`);
	}
	return {
		tasks: (tasks as AcceptanceTask[]).map(t => ({ todo: t.todo, check: t.check })),
		allowedChanges: allowedChanges as string[],
		forbid: ((forbid ?? []) as ForbidRule[]).map(r => ({ pattern: r.pattern, reason: r.reason, files: r.files })),
		maxBlocks: (maxBlocks as number | undefined) ?? DEFAULTS.maxBlocks,
		checkTimeoutMs: (checkTimeoutMs as number | undefined) ?? DEFAULTS.checkTimeoutMs,
		stopBudgetMs: (stopBudgetMs as number | undefined) ?? DEFAULTS.stopBudgetMs,
	};
}

export function isWithin(child: string, parent: string): boolean {
	const rel = path.relative(parent, child);
	return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/**
 * A folder can be protected by name only when it is dedicated: not the work tree or one of its ancestors, and
 * not a shared root such as `/`, the home folder, or the temp folder. Otherwise every path in the work tree
 * would name it.
 */
export function isDedicatedFolder(dir: string, cwd: string): boolean {
	const shared = new Set(["/", os.homedir(), os.tmpdir(), "/tmp"].map(p => path.resolve(p)));
	return !shared.has(path.resolve(dir)) && !isWithin(path.resolve(cwd), path.resolve(dir));
}

/**
 * Resolves `--acceptance <path>` against the session cwd. No flag means the package is off; any other
 * failure is an error the hooks turn into a block, so a configured spec that goes missing fails closed.
 */
export async function resolveSpec(flag: string | boolean | undefined, cwd: string): Promise<ResolvedSpec> {
	if (flag === undefined || flag === false || flag === "") return { status: "off" };
	if (flag === true) {
		return { status: "error", reason: "The acceptance spec could not be loaded: --acceptance needs a path.", specPath: "", markers: [] };
	}
	const specPath = path.resolve(cwd, flag);
	const verdictPath = verdictPathFor(specPath);
	const markers = [specPath, verdictPath, path.basename(specPath), path.basename(verdictPath), "allowedChanges"];
	const fail = (reason: string): ResolvedSpec => ({ status: "error", reason, specPath, markers });

	let realSpec: string;
	try {
		realSpec = await fs.realpath(specPath);
	} catch {
		return fail("The acceptance spec could not be loaded: the file does not exist.");
	}
	if (realSpec !== specPath) markers.push(realSpec);
	const realCwd = await fs.realpath(cwd).catch(() => path.resolve(cwd));
	for (const dir of new Set([path.dirname(specPath), path.dirname(realSpec)])) {
		if (isDedicatedFolder(dir, realCwd)) markers.push(dir);
	}
	if (isWithin(realSpec, realCwd)) {
		return fail("The acceptance spec is inside the working directory, where the agent could edit it; it was not used.");
	}
	let raw: unknown;
	try {
		raw = await Bun.file(realSpec).json();
	} catch {
		return fail("The acceptance spec could not be loaded: it is not valid JSON.");
	}
	try {
		return { status: "ok", spec: parseSpec(raw), specPath, verdictPath, markers };
	} catch (err) {
		return fail(`The acceptance spec could not be loaded: ${err instanceof Error ? err.message : String(err)}.`);
	}
}
