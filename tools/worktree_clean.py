import argparse
import os
import shutil
import stat
import subprocess
import sys
from pathlib import Path

AGENT_PREFIX = "agent-"


def git(*args: str) -> subprocess.CompletedProcess:
    return subprocess.run(["git", *args], capture_output=True, text=True, stdin=subprocess.DEVNULL)


def common_dir() -> Path:
    result = git("rev-parse", "--path-format=absolute", "--git-common-dir")
    if result.returncode != 0:
        sys.exit(f"worktree_clean: not inside a git repository: {result.stderr.strip()}")
    return Path(result.stdout.strip())


def same(a: Path, b: Path) -> bool:
    return os.path.normcase(os.path.realpath(a)) == os.path.normcase(os.path.realpath(b))


def is_link(path: Path) -> bool:
    return path.is_symlink() or getattr(path, "is_junction", lambda: False)()


def make_writable(path: Path) -> None:
    os.chmod(path, os.stat(path).st_mode | stat.S_IWRITE)


def clear_readonly(root: Path) -> None:
    if not root.is_dir() or is_link(root):
        return
    # WORKAROUND: OneDrive marks folders read-only and Windows then refuses to delete them
    for current, dirs, _files in os.walk(root):
        dirs[:] = [d for d in dirs if not is_link(Path(current, d))]
        for name in dirs:
            make_writable(Path(current, name))
    make_writable(root)


def retry_writable(func, target: str, _exc) -> None:
    make_writable(Path(target))
    func(target)


def delete_tree(path: Path) -> None:
    clear_readonly(path)
    handler = {"onexc": retry_writable} if sys.version_info >= (3, 12) else {"onerror": retry_writable}
    shutil.rmtree(path, **handler)


def registered() -> list[Path]:
    result = git("worktree", "list", "--porcelain")
    return [Path(line[len("worktree "):]) for line in result.stdout.splitlines() if line.startswith("worktree ")]


def is_registered(path: Path) -> bool:
    return any(same(path, other) for other in registered())


def admin_dir(worktree: Path) -> Path:
    pointer = worktree / ".git"
    if pointer.is_file():
        text = pointer.read_text().strip()
        if text.startswith("gitdir:"):
            return Path(text[len("gitdir:"):].strip())
    return common_dir() / "worktrees" / worktree.name


def prune() -> bool:
    preview = git("worktree", "prune", "--dry-run", "--verbose")
    for line in (preview.stdout + preview.stderr).splitlines():
        if line.startswith("Removing worktrees/"):
            name = line[len("Removing worktrees/"):].split(":")[0]
            clear_readonly(common_dir() / "worktrees" / name)
    result = git("worktree", "prune")
    if result.returncode != 0 or "error:" in result.stderr:
        print(f"prune FAILED: {result.stderr.strip()}")
        return False
    return True


def remove(paths: list[str], force: bool) -> int:
    failed = False
    for raw in paths:
        worktree = Path(raw)
        if is_registered(worktree):
            clear_readonly(worktree)
            clear_readonly(admin_dir(worktree))
            result = git("worktree", "remove", *(["--force"] if force else []), str(worktree))
            if result.returncode != 0:
                failed = True
                print(f"FAILED {worktree}: {result.stderr.strip()}")
                continue
        elif worktree.is_dir():
            delete_tree(worktree)
        else:
            print(f"nothing to remove: {worktree}")
            continue
        print(f"removed {worktree}")
    return 1 if (not prune() or failed) else 0


def sweep() -> int:
    root = common_dir().parent / ".claude" / "worktrees"
    swept, left = 0, 0
    if root.is_dir():
        live = registered()
        for folder in sorted(p for p in root.iterdir() if p.is_dir()):
            if any(same(folder, other) for other in live):
                continue
            if folder.name.startswith(AGENT_PREFIX):
                delete_tree(folder)
                swept += 1
                print(f"swept {folder}")
            else:
                left += 1
                print(f"left {folder}: not registered and not an agent worktree")
    ok = prune()
    print(f"sweep: {swept} removed, {left} left")
    return 0 if ok else 1


def main() -> None:
    parser = argparse.ArgumentParser(description="Remove git worktrees under OneDrive without Permission denied")
    commands = parser.add_subparsers(dest="command", required=True)
    remove_cmd = commands.add_parser("remove", help="remove the given worktrees")
    remove_cmd.add_argument("--force", action="store_true")
    remove_cmd.add_argument("paths", nargs="+")
    commands.add_parser("sweep", help="delete unregistered agent worktrees and prune stale entries")
    args = parser.parse_args()
    sys.exit(remove(args.paths, args.force) if args.command == "remove" else sweep())


if __name__ == "__main__":
    main()
