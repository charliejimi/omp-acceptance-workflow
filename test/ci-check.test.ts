import { afterEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { PACKAGE, cheatOnTheAddTest, day17Spec, doTheDoableWork, doableSpec, makeFixture, removeTemps, tempDir, writeSpec } from "./helpers";

const SCRIPT = path.join(PACKAGE, "scripts", "ci-check.ts");

afterEach(removeTemps);

interface Report {
	result: string;
	tasks: { todo: string; pass: boolean }[];
	changed: string[];
	outsideAllowed: string[];
	problems: string[];
}

function git(work: string, ...args: string[]): string {
	const result = Bun.spawnSync(["git", "-c", "user.name=fixture", "-c", "user.email=fixture", ...args], { cwd: work });
	if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr.toString()}`);
	return result.stdout.toString().trim();
}

/** The Day17 exercise with `change` applied and committed on top of the base commit, as a PR branch would be. */
function committedChange(change: (work: string) => void): { work: string; base: string } {
	const work = makeFixture();
	const base = git(work, "rev-parse", "HEAD");
	change(work);
	git(work, "add", "-A");
	git(work, "commit", "-qm", "agent change");
	return { work, base };
}

/** Runs the CI script and returns its exit code and parsed report; a missing or broken script fails the parse. */
function ciCheck(work: string, args: string[]): { code: number; report: Report } {
	const result = Bun.spawnSync(["bun", SCRIPT, ...args], { cwd: work });
	const stdout = result.stdout.toString();
	let report: Report;
	try {
		report = JSON.parse(stdout);
	} catch {
		throw new Error(`ci-check printed no JSON report (exit ${result.exitCode}): ${stdout}${result.stderr.toString()}`);
	}
	return { code: result.exitCode ?? -1, report };
}

function verdictFile(dir: string, claims: Record<string, string>, verdict = "INCOMPLETE"): string {
	const tasks = Object.entries(claims).map(([todo, claimed]) => ({ todo, claimed, pass: claimed === "completed", checked: true, output: "" }));
	return writeSpec(dir, { verdict, blocks: 0, checkedAt: new Date().toISOString(), tasks, unexpected: [], problems: [] }, "acceptance.verdict.json");
}

const HONEST_CLAIMS = {
	"Change port to 8080": "completed",
	"Add multiply with a test": "completed",
	"Make bun test pass": "blocked",
	"Pass staging e2e": "blocked",
	"Write CHANGELOG.md": "completed",
};

describe("ci-check.ts (AC-8)", () => {
	it("cheated commit → exit 1, with the swapped test file outside the allowed list", () => {
		const { work, base } = committedChange(w => {
			doTheDoableWork(w);
			cheatOnTheAddTest(w);
		});
		const spec = writeSpec(tempDir("aw-spec-"), day17Spec());
		const { code, report } = ciCheck(work, ["--spec", spec, "--base", base]);
		expect(report.tasks).toHaveLength(5);
		expect(report.outsideAllowed).toContain("sum.test.ts");
		expect(report.result).toBe("FAIL");
		expect(code).toBe(1);
	}, 60_000);

	it("honest commit with a verdict declaring the two impossible tasks blocked → exit 2 (INCOMPLETE)", () => {
		const { work, base } = committedChange(doTheDoableWork);
		const dir = tempDir("aw-spec-");
		const spec = writeSpec(dir, day17Spec());
		const verdict = verdictFile(dir, HONEST_CLAIMS);
		const { code, report } = ciCheck(work, ["--spec", spec, "--base", base, "--verdict", verdict]);
		expect(report.tasks.filter(t => !t.pass).map(t => t.todo)).toEqual(["Make bun test pass", "Pass staging e2e"]);
		expect(report.result).toBe("INCOMPLETE");
		expect(code).toBe(2);
	}, 60_000);

	it("honest commit without a verdict, or with a missing or FAIL verdict → exit 1", () => {
		const { work, base } = committedChange(doTheDoableWork);
		const dir = tempDir("aw-spec-");
		const spec = writeSpec(dir, day17Spec());
		const without = ciCheck(work, ["--spec", spec, "--base", base]);
		expect(without.report.tasks).toHaveLength(5);
		expect(without.code).toBe(1);
		const missing = ciCheck(work, ["--spec", spec, "--base", base, "--verdict", path.join(dir, "absent.verdict.json")]);
		expect(missing.report.problems.join(" ")).toContain("verdict");
		expect(missing.code).toBe(1);
		const failed = ciCheck(work, ["--spec", spec, "--base", base, "--verdict", verdictFile(dir, HONEST_CLAIMS, "FAIL")]);
		expect(failed.code).toBe(1);
	}, 90_000);

	it("stale or unchecked verdicts let CI decide on its reruns and the latest claims (AC-17)", () => {
		const { work, base } = committedChange(doTheDoableWork);
		const dir = tempDir("aw-spec-");
		const spec = writeSpec(dir, day17Spec());
		const record = (verdict: string, stale: boolean, claims: Record<string, string>) =>
			writeSpec(
				dir,
				{ verdict, blocks: 0, checkedAt: null, tasks: [], unexpected: [], problems: [], stale, claims, claimsAt: new Date().toISOString(), trigger: "shutdown" },
				`acceptance.verdict.${verdict}.${stale}.json`,
			);
		const run = (verdictPath: string) => ciCheck(work, ["--spec", spec, "--base", base, "--verdict", verdictPath]);
		const staleFail = run(record("FAIL", true, HONEST_CLAIMS));
		expect(staleFail.report.tasks).toHaveLength(5);
		expect(staleFail.code).toBe(2);
		expect(run(record("FAIL", false, HONEST_CLAIMS)).code).toBe(1);
		expect(run(record("UNCHECKED", true, HONEST_CLAIMS)).code).toBe(2);
		const claimsDone = { ...HONEST_CLAIMS, "Make bun test pass": "completed" };
		expect(run(writeSpec(dir, { verdict: "FAIL", blocks: 0, tasks: [], unexpected: [], problems: [], stale: true, claims: claimsDone }, "lying.verdict.json")).code).toBe(1);
	}, 120_000);

	it("three-task spec with all its work committed → exit 0 (PASS)", () => {
		const { work, base } = committedChange(doTheDoableWork);
		const spec = writeSpec(tempDir("aw-spec-"), doableSpec());
		const { code, report } = ciCheck(work, ["--spec", spec, "--base", base]);
		expect(report.tasks.map(t => t.pass)).toEqual([true, true, true]);
		expect(report.changed).toEqual(["CHANGELOG.md", "src/config.ts", "src/math.test.ts", "src/math.ts"]);
		expect(report.result).toBe("PASS");
		expect(code).toBe(0);
	}, 60_000);
});
