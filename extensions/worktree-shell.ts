/**
 * Shell-safety primitive shared by everything that builds a command string.
 *
 * Worktree paths, branch names, and continuation messages all reach `bash -c`
 * eventually, and all of them can contain quotes, spaces, or newlines. One
 * implementation, used everywhere, is what keeps that from becoming an
 * injection surface.
 */

/** Single-quote a string for safe literal use inside a POSIX shell command. */
export function shQuote(value: string): string {
	return `'${value.replace(/'/g, `'\\''`)}'`;
}
