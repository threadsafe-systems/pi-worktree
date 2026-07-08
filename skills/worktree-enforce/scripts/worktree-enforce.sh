#!/usr/bin/env bash
# worktree-enforce.sh — opt the current repo IN/OUT of pi-worktree discipline
# enforcement, show STATUS, or run DOCTOR. Operates on the git repo containing $PWD.
#
# Markers (read by the pi-worktree extension):
#   <repo>/.pi/worktree-discipline.json        committed, shared policy {"enforce":true,"allowPaths":[]}
#   <repo>/.pi/worktree-discipline.local.json  gitignored per-checkout override (wins)
#
# JSON is read/written via node (always present under pi), so there is no jq
# dependency.
#
# Usage: worktree-enforce.sh <in|out|status|doctor>   (default: status)
set -euo pipefail

CMD="${1:-status}"
case "$CMD" in
in | out | status | doctor) ;;
*)
	echo "usage: worktree-enforce.sh <in|out|status|doctor>" >&2
	exit 2
	;;
esac

TOP=$(git rev-parse --show-toplevel 2>/dev/null) || {
	echo "worktree-enforce: not inside a git repository" >&2
	exit 1
}
MARKER="$TOP/.pi/worktree-discipline.json"
LOCAL="$TOP/.pi/worktree-discipline.local.json"
LOCAL_REL=".pi/worktree-discipline.local.json"

json_enforce() { # path -> "true"/"false"
	node -e 'try{const j=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));process.stdout.write(String(j.enforce===true))}catch{process.stdout.write("false")}' "$1"
}
write_marker() { # path enforce(true|false)
	node -e 'const fs=require("fs"),path=require("path");const p=process.argv[1];let j={};try{j=JSON.parse(fs.readFileSync(p,"utf8"))}catch{}j.enforce=process.argv[2]==="true";if(!Array.isArray(j.allowPaths))j.allowPaths=[];fs.mkdirSync(path.dirname(p),{recursive:true});fs.writeFileSync(p,JSON.stringify(j,null,2)+"\n")' "$1" "$2"
}

is_main() { [ -d "$TOP/.git" ]; } # linked worktrees carry a .git FILE, not a directory
committed() { git -C "$TOP" cat-file -e "HEAD:.pi/worktree-discipline.json" 2>/dev/null; }

ensure_gitignore() {
	local gi="$TOP/.gitignore"
	if [ ! -f "$gi" ] || ! grep -qxF "$LOCAL_REL" "$gi"; then
		printf '%s\n' "$LOCAL_REL" >>"$gi"
		echo "  gitignored $LOCAL_REL"
	fi
}

case "$CMD" in
in)
	write_marker "$MARKER" true
	rm -f "$LOCAL" # do not let a stale local override win over the shared marker
	git -C "$TOP" add "$MARKER" 2>/dev/null || true
	echo "worktree-discipline: ENFORCED for $TOP"
	echo "  marker staged: .pi/worktree-discipline.json (commit it to share the policy)"
	;;
out)
	if committed; then
		write_marker "$LOCAL" false
		ensure_gitignore
		echo "worktree-discipline: disabled via local override (committed policy left intact)"
	else
		rm -f "$MARKER" "$LOCAL"
		echo "worktree-discipline: markers removed; repo falls back to default (off)"
	fi
	;;
status | doctor)
	eff="false"
	src="(none)"
	if [ -f "$LOCAL" ]; then
		eff=$(json_enforce "$LOCAL")
		src=".pi/worktree-discipline.local.json (override)"
	elif [ -f "$MARKER" ]; then
		eff=$(json_enforce "$MARKER")
		src=".pi/worktree-discipline.json"
	fi
	if [ "$eff" = "true" ]; then echo "enforcement: ON   (from $src)"; else echo "enforcement: OFF  (default)"; fi
	if is_main; then echo "checkout:    main (edits gated when ON)"; else echo "checkout:    linked worktree (always allowed)"; fi
	echo "repo:        $TOP"
	if [ "$CMD" = "doctor" ]; then
		settings="$HOME/.pi/agent/settings.json"
		if node -e 'const fs=require("fs");let s={};try{s=JSON.parse(fs.readFileSync(process.argv[1],"utf8"))}catch{process.exit(1)}const entries=[...(s.packages||[]),...(s.extensions||[])].map(x=>typeof x==="string"?x:JSON.stringify(x));process.exit(entries.some(x=>/@threadsafe-systems\/pi-worktree\b|(^|\/)pi-worktree(\/|$)|extensions[\\/]worktree\.ts/.test(x))?0:1)' "$settings" 2>/dev/null; then
			echo "global hook: PASS (pi-worktree referenced in ~/.pi/agent/settings.json)"
		else
			echo "global hook: FAIL (pi-worktree not referenced in ~/.pi/agent/settings.json; install this package)"
		fi
	fi
	;;
esac
