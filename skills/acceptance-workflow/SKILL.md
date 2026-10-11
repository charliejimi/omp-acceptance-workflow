---
name: acceptance-workflow
description: Work through an assigned task list under acceptance checks you cannot read or edit — track each task under its exact title, write a failing test first, mark a task done only when it passes, block what cannot be done with the reason, and have an independent verifier try to refute the work before a PR. Use when the user assigns tasks that have acceptance checks, or invokes /skill:acceptance-workflow.
---

# Acceptance workflow

Whoever assigned this work wrote an acceptance check for every task and keeps it where you cannot read or edit it. omp runs a task's check when you mark the task done, and reruns all of them when you finish. Your report is not the result; the checks are.

## Rules

1. **Track every task under its exact title.** Create the todo list with the task titles you were given, word for word, one item per task. A task that is not on the list counts as unfinished.
2. **Red before green, one task at a time.** For each task, write a test for the behaviour, run it, and watch it fail for the reason you expect; then write only enough code to make it pass, and run it again. If the user is present, agree with them which public interface the test goes at before you write it. A task with no behaviour to test (configuration, a changelog) needs no new test, but run whatever shows it is done.
3. **Mark a task done only when it passes.** Run the task's tests yourself before `todo done`. If omp refuses the done, read the reason, fix the cause, and try again.
4. **Block what cannot be done.** If a task cannot be done within its constraints (a file you may not change, a service you cannot reach), stop working on it and use `todo block` with the reason. An honest blocked task is an accepted result; a task faked into done is not.
5. **Never make a check pass by changing what it tests.** Do not edit or replace a test you did not write so that it passes. Do not mock or swap out the code under test, preload code before tests run, replace a network call, or stand up a local server in place of a real one. Change only the files the task needs: changed files are compared with an allowed list when you finish.
6. **Stop what you started before you finish.** Kill servers, watchers, and other background processes you started. omp postpones the final check while background work is running, and a check that never runs counts as a failure.
7. **Before a PR, ask for an independent check.** When the work is ready for a pull request, run the `acceptance-verifier` task agent on your changes with the task list and your claim for each task. Fix what it refutes, or report it.

## Finishing

- When you finish, omp reruns every check. If it returns the work, it lists what does not match: fix each item, or block the task with the reason. Do not argue with the check and do not touch the checks.
- In your final message, list every task as done or blocked, with the reason for each blocked task. Never describe a blocked task as done.
