// Dev-only browser mock of the Rust side, for UI work and screenshots without a Tauri window.
// Load http://localhost:1420/?mock after dumping a fixture (see src-tauri/examples/dump.rs).
import { emit } from "@tauri-apps/api/event";
import { mockIPC, mockWindows } from "@tauri-apps/api/mocks";
import { state } from "../state";

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
            { path: "D:/src/pandas", name: "pandas", openedAt: Date.now() - 864e5 },
            { path: "D:/src/zed", name: "zed", openedAt: Date.now() - 2 * 864e5 },
          ];
        case "plugin:window|is_maximized":
          return false;
        default:
          return null;
      }
    },
    { shouldMockEvents: true },
  );
  // Screenshot helpers: ?select=<path>&scroll=<px>&palette=<query>&viewed=<path,path>&preview
  const q = new URLSearchParams(location.search);
  if (q.get("viewed")) {
    const marked = q.get("viewed")!.split(",");
    for (const f of fx.snapshot.files) if (marked.includes(f.path)) fx.snapshot.viewed[f.path] = f.diffHash;
  }
  // Fresh prefs per load so screenshots are reproducible; query flags switch them on.
  Object.assign(state.prefs, {
    mdPreview: q.has("preview"),
    split: q.has("split"),
    wrap: q.has("wrap"),
    group: q.has("group"),
    hideViewed: q.has("hide"),
    follow: q.has("follow"),
    sidebarWidth: Number(q.get("sidebar") ?? 300),
  });
  if (q.has("noanim")) document.head.append(Object.assign(document.createElement("style"), { textContent: "*{animation:none!important;transition:none!important}" }));
  setTimeout(async () => {
    const sel = q.get("select");
    if (sel) document.querySelector<HTMLElement>(`.row[data-path="${CSS.escape(sel)}"]`)?.click();
    await new Promise((r) => setTimeout(r, 400));
    const sc = document.querySelector(".diff-scroll")!;
    if (q.get("expand")) document.querySelector<HTMLElement>(".gap")?.click();
    await new Promise((r) => setTimeout(r, 200));
    if (q.get("scroll")) sc.scrollTop = Number(q.get("scroll"));
    sc.dispatchEvent(new Event("scroll"));
    if (q.has("gone")) emit("repo:gone", fx.snapshot.root);
    if (q.get("touch")) for (const p of q.get("touch")!.split(",")) (window as any).__touch(p);
    if (q.get("palette") !== null) {
      document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "p", ctrlKey: true, bubbles: true }));
      const input = document.querySelector<HTMLInputElement>(".pal-input")!;
      input.value = q.get("palette")!;
      input.dispatchEvent(new Event("input"));
    }
  }, 300);

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
