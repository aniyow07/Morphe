// Dev-only browser mock of the Rust side, for UI work and screenshots without a Tauri window.
// Load http://localhost:1420/?mock after dumping a fixture (see src-tauri/examples/dump.rs).
import { emit } from "@tauri-apps/api/event";
import { mockIPC, mockWindows } from "@tauri-apps/api/mocks";

export async function installMock() {
  const fx = await (await fetch("/.mock/fixture.json")).json();
  const lines = (p: string) => (fx.texts[p] ?? "").split("\n").map((l: string) => l.replace(/\r$/, ""));
  mockWindows("main");
  mockIPC(
    (cmd, args: any) => {
      switch (cmd) {
        case "launch_path":
          return new URLSearchParams(location.search).has("welcome") ? null : fx.snapshot.root;
        case "open_repo":
          return structuredClone(fx.snapshot);
        case "get_diff":
          return fx.diffs[args.path] ?? null;
        case "get_lines":
          return lines(args.path).slice(args.start - 1, args.end);
        case "get_file_text":
          return fx.texts[args.path] ?? null;
        case "recent_repos":
          return [
            { path: fx.snapshot.root, name: fx.snapshot.name, openedAt: Date.now() },
            { path: "C:\src\pandas", name: "pandas", openedAt: Date.now() - 864e5 },
            { path: "C:\src\zed", name: "zed", openedAt: Date.now() - 2 * 864e5 },
          ];
        case "plugin:window|is_maximized":
          return false;
        default:
          return null;
      }
    },
    { shouldMockEvents: true },
  );
  // Simulate a live edit from the console: __touch("path/to/file")
  (window as any).__touch = (path: string) => {
    const f = fx.snapshot.files.find((x: any) => x.path === path);
    if (!f) return;
    f.mtime = Date.now();
    f.additions += 1;
    f.diffHash = Math.random().toString(16).slice(2);
    emit("repo:changed", { upserts: [{ ...f, contentChanged: true }], removed: [], branch: fx.snapshot.branch });
  };
}
