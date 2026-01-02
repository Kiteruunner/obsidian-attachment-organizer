import { ItemView, setIcon } from "obsidian";
import type { WorkspaceLeaf } from "obsidian";
import type { DetectReport, FileEntry } from "./main";

export const ATTACH_VIEW_TYPE = "k-plugin-attachments-view";

type Provider = {
  detectReport: (force?: boolean) => Promise<DetectReport>;
  openFileByPath: (path: string) => Promise<void>;
  applyPlan: () => Promise<void>;
  // New: undo support
  undoLastOperation?: () => Promise<void>;
  canUndo?: () => boolean;
  // Settings access
  getShowStats?: () => boolean;
};

type TreeNode =
  | {
      kind: "folder";
      name: string;
      path: string;
      children: Map<string, TreeNode>;
    }
  | {
      kind: "file";
      entry: FileEntry;
    };

type Mark = "-" | "K" | "B" | "R" | "M" | "C";

export class AttachView extends ItemView {
  private plugin: Provider;

  private report: DetectReport | null = null;
  private filterText = "";
  private collapsed = new Set<string>();

  // Mark filter: which marks to show (multi-select)
  private visibleMarks = new Set<string>(["-", "K", "B", "R", "M", "C"]);

  private previewMode = false;

  // Toggle to show/hide action target paths (→ target/path)
  private showActions = false;

  // Track if all folders are collapsed for toggle button
  private allCollapsed = false;

  // Track if mark filter panel is shown
  private showMarkFilter = false;

  // Store mark button elements + badge for updating counts/state
  private markButtons = new Map<string, { btn: HTMLElement; badge: HTMLSpanElement }>();

  // Reference to mark filter panel for toggling
  private elMarkFilterPanel!: HTMLDivElement;

  private elHeader!: HTMLDivElement;
  private elFilter!: HTMLInputElement;
  private elStats!: HTMLDivElement;
  private elTreeWrap!: HTMLDivElement;

  constructor(leaf: WorkspaceLeaf, plugin: Provider) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType(): string {
    return ATTACH_VIEW_TYPE;
  }

  getDisplayText(): string {
    return "Organizer";
  }

  getIcon(): string {
    return "paperclip";
  }

  async onOpen(): Promise<void> {
    this.injectStyle();

    this.contentEl.empty();
    this.contentEl.addClass("katt-attach-view");

    // Nav header with only top row icon buttons
    const navHeader = this.contentEl.createDiv({ cls: "nav-header" });
    const actions = navHeader.createDiv({ cls: "nav-buttons-container katt-actions" });

    // Custom header area for search/filter (outside nav-header)
    this.elHeader = this.contentEl.createDiv({ cls: "katt-header" });

    const mkIconBtn = (icon: string, label: string, onClick: () => void) => {
      const btn = actions.createDiv({ cls: "clickable-icon nav-action-button" });
      btn.setAttr("aria-label", label);
      btn.setAttr("data-tooltip-delay", "300");
      setIcon(btn, icon);
      this.registerDomEvent(btn, "click", (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        onClick();
      });
      return btn;
    };

    const mkIconToggle = (
      icon: string,
      label: string,
      get: () => boolean,
      set: (v: boolean) => void
    ) => {
      const btn = actions.createDiv({ cls: "clickable-icon nav-action-button" });
      btn.setAttr("aria-label", label);
      btn.setAttr("data-tooltip-delay", "300");

      const sync = () => {
        btn.toggleClass("is-active", get());
      };

      setIcon(btn, icon);
      sync();

      this.registerDomEvent(btn, "click", (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        set(!get());
        sync();
        this.render();
      });

      return btn;
    };

    mkIconBtn("refresh-cw", "Refresh", () => void this.rescan(true));
    mkIconToggle("eye", "Preview mode", () => this.previewMode, (v) => (this.previewMode = v));
    mkIconToggle("arrow-right", "Show action paths", () => this.showActions, (v) => (this.showActions = v));

    const collapseBtn = mkIconBtn("chevrons-down-up", "Collapse/Expand all", () => {
      this.toggleCollapseAll();
    });
    this.updateCollapseIcon(collapseBtn);

    mkIconBtn("check-circle", "Apply plan", async () => {
      await this.plugin.applyPlan();
      await this.rescan(true);
    });

    mkIconBtn("undo", "Undo last operation", async () => {
      if (this.plugin.undoLastOperation) {
        await this.plugin.undoLastOperation();
        await this.rescan(true);
      }
    });

    // Search row with filter input + settings toggle (in katt-header, not nav-header)
    const searchRow = this.elHeader.createDiv({ cls: "search-row katt-search-row" });

    const filterWrap = searchRow.createDiv({ cls: "search-input-container katt-filter" });
    this.elFilter = filterWrap.createEl("input", {
      type: "search",
      attr: { placeholder: "Filter…", spellcheck: "false" },
    });

    this.registerDomEvent(this.elFilter, "input", () => {
      this.filterText = this.elFilter.value.trim().toLowerCase();
      this.render();
    });

    // Filter settings toggle button
    const filterToggleBtn = searchRow.createDiv({
      cls: "clickable-icon katt-filter-toggle",
    });
    filterToggleBtn.setAttr("aria-label", "Filter options");
    filterToggleBtn.setAttr("data-tooltip-delay", "300");
    setIcon(filterToggleBtn, "sliders-horizontal");
    filterToggleBtn.toggleClass("is-active", this.showMarkFilter);

    this.registerDomEvent(filterToggleBtn, "click", (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      this.showMarkFilter = !this.showMarkFilter;
      filterToggleBtn.toggleClass("is-active", this.showMarkFilter);
      this.elMarkFilterPanel.style.display = this.showMarkFilter ? "" : "none";
    });

    // Collapsible mark filter panel
    this.elMarkFilterPanel = this.elHeader.createDiv({ cls: "katt-mark-filter-panel" });
    this.elMarkFilterPanel.style.display = this.showMarkFilter ? "" : "none";

    const markFilterWrap = this.elMarkFilterPanel.createDiv({
      cls: "nav-buttons-container katt-mark-filter",
    });

    const marks: Array<{ mark: Mark; label: string }> = [
      { mark: "-", label: "Notes" },
      { mark: "K", label: "Kept" },
      { mark: "B", label: "To Bin" },
      { mark: "R", label: "Relocate" },
      { mark: "M", label: "Missing" },
      { mark: "C", label: "Conflict" },
    ];

    for (const { mark, label } of marks) {
      const btn = markFilterWrap.createDiv({
        cls: `clickable-icon katt-mark-btn katt-mark-${
          mark === "-" ? "dash" : mark.toLowerCase()
        }`,
      });
      btn.setText(mark);
      btn.setAttr("aria-label", `${label} (${mark})`);
      btn.setAttr("data-tooltip-delay", "300");
      btn.toggleClass("is-active", this.visibleMarks.has(mark));

      // badge (number bubble)
      const badge = btn.createSpan({ cls: "katt-mark-badge is-empty" });
      badge.setText("");

      this.markButtons.set(mark, { btn, badge });

      this.registerDomEvent(btn, "click", (ev) => {
        ev.preventDefault();
        ev.stopPropagation();

        if (this.visibleMarks.has(mark)) this.visibleMarks.delete(mark);
        else this.visibleMarks.add(mark);

        btn.toggleClass("is-active", this.visibleMarks.has(mark));
        this.render(); // list unchanged; filter affects visibility only
      });
    }

    // Stats row (visibility controlled by settings)
    this.elStats = this.elHeader.createDiv({ cls: "katt-stats" });
    const showStats = this.plugin.getShowStats?.() ?? false;
    this.elStats.toggleClass("is-hidden", !showStats);

    const nav = this.contentEl.createDiv({ cls: "nav-files-container katt-tree" });
    this.elTreeWrap = nav.createDiv({ cls: "nav-files-container-node" });

    await this.rescan(true);
  }

  async onClose(): Promise<void> {
    this.contentEl.removeClass("katt-attach-view");
  }

  public async rescan(force = false): Promise<void> {
    this.elTreeWrap.empty();
    this.elStats.setText("Scanning…");
    const t0 = performance.now();
    this.report = await this.plugin.detectReport(force);
    const ms = performance.now() - t0;

    const s = this.report.stats;
    this.elStats.setText(
      `Notes:${s.notes}  Attach:${s.attachments}  Todo:${s.todo}  Missing:${s.missing}  Conflict:${s.conflicts}  Total:${s.total}  ${ms.toFixed(
        0
      )}ms`
    );

    this.updateMarkBadges(); // <- bubble counts
    this.render();
  }

  private render(): void {
    if (!this.report) return;

    this.elTreeWrap.empty();

    const root = this.buildZonedTree(this.report.entries, this.previewMode ? this.report.preview : []);
    const filtered = this.filterTree(root, this.filterText);
    if (!filtered) return;

    for (const child of filtered.children.values()) {
      this.renderNode(this.elTreeWrap, child);
    }

    // keep badges correct even after filter changes (cheap)
    this.updateMarkBadges();
  }

  /** Update the small number bubbles on mark buttons (based on report.entries only) */
  private updateMarkBadges(): void {
    if (!this.report) return;

    const counts = new Map<Mark, number>([
      ["-", 0],
      ["K", 0],
      ["B", 0],
      ["R", 0],
      ["M", 0],
      ["C", 0],
    ]);

    for (const e of this.report.entries) {
      if (e.isPreview) continue; // safety
      const m = this.markOf(e);
      counts.set(m, (counts.get(m) ?? 0) + 1);
    }

    for (const [mark, { badge }] of this.markButtons.entries()) {
      const n = counts.get(mark as Mark) ?? 0;
      if (n <= 0) {
        badge.setText("");
        badge.addClass("is-empty");
      } else {
        badge.setText(String(n));
        badge.removeClass("is-empty");
      }
    }
  }

  private toggleCollapseAll(): void {
    if (this.allCollapsed) {
      this.collapsed.clear();
      this.allCollapsed = false;
    } else {
      this.collectAllFolderPaths(this.collapsed);
      this.allCollapsed = true;
    }
    this.render();

    const btn = this.contentEl.querySelector(".katt-collapse-btn");
    if (btn) this.updateCollapseIcon(btn as HTMLElement);
  }

  private collectAllFolderPaths(target: Set<string>): void {
    if (!this.report) return;

    target.add("__zoneA");
    target.add("__zoneB");
    target.add("__zoneCO");
    target.add("__zoneCO/C");
    target.add("__zoneCO/OUT");

    for (const e of this.report.entries) {
      const parts = e.path.split("/");
      let cur = "";
      for (let i = 0; i < parts.length - 1; i++) {
        cur = cur ? `${cur}/${parts[i]}` : parts[i];
        target.add(cur);
        const zone =
          e.zone === "A"
            ? "__zoneA"
            : e.zone === "B"
            ? "__zoneB"
            : e.zone === "C"
            ? "__zoneCO/C"
            : "__zoneCO/OUT";
        target.add(`${zone}/${cur}`);
      }
    }
  }

  private updateCollapseIcon(btn: HTMLElement): void {
    btn.empty();
    setIcon(btn, this.allCollapsed ? "chevrons-down-up" : "chevrons-up-down");
    btn.setAttr("aria-label", this.allCollapsed ? "Expand all" : "Collapse all");
    btn.addClass("katt-collapse-btn");
  }

  /** Build tree with zone roots: A / B / C+OUT (with C + OUT subfolders) */
  private buildZonedTree(entries: FileEntry[], previewEntries: FileEntry[]): TreeNode & { kind: "folder" } {
    const root: TreeNode & { kind: "folder" } = {
      kind: "folder",
      name: "",
      path: "",
      children: new Map(),
    };

    const zoneA = this.ensureFolder(root, "__zoneA", "Workspace");
    const zoneB = this.ensureFolder(root, "__zoneB", "Staging");
    const zoneCO = this.ensureFolder(root, "__zoneCO", "External");
    const zoneC = this.ensureFolder(zoneCO, "C", "Extra Scan");
    const zoneO = this.ensureFolder(zoneCO, "OUT", "Outside");

    for (const e of entries) {
      const mark = this.markOf(e);
      if (!this.visibleMarks.has(mark)) continue;

      const targetRoot = e.zone === "A" ? zoneA : e.zone === "B" ? zoneB : e.zone === "C" ? zoneC : zoneO;
      this.addEntryToTree(targetRoot, e);
    }

    for (const p of previewEntries) {
      if (!p.virtualFrom) continue;

      const targetRoot = p.zone === "A" ? zoneA : p.zone === "B" ? zoneB : p.zone === "C" ? zoneC : zoneO;
      this.addEntryToTree(targetRoot, p);
    }

    return root;
  }

  private addEntryToTree(zoneRoot: TreeNode & { kind: "folder" }, e: FileEntry): void {
    const full = e.path;
    const parts = full.split("/").filter(Boolean);
    const fileName = parts.pop() ?? full;
    const folderPath = parts.join("/");

    const folder = folderPath ? this.ensureFolder(zoneRoot, folderPath) : zoneRoot;
    folder.children.set(fileName, { kind: "file", entry: e });
  }

  private ensureFolder(parent: TreeNode & { kind: "folder" }, relPath: string, nameOverride?: string) {
    const parts = (relPath || "").split("/").filter(Boolean);
    let cur = parent;

    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      const isLast = i === parts.length - 1;
      const nextPath = cur.path ? `${cur.path}/${part}` : part;

      let node = cur.children.get(part);
      if (!node || node.kind !== "folder") {
        node = { kind: "folder", name: isLast && nameOverride ? nameOverride : part, path: nextPath, children: new Map() };
        cur.children.set(part, node);
      } else if (isLast && nameOverride) {
        node.name = nameOverride;
      }
      cur = node;
    }
    return cur;
  }

  private filterTree(node: TreeNode & { kind: "folder" }, ft: string): (TreeNode & { kind: "folder" }) | null {
    const out: TreeNode & { kind: "folder" } = {
      kind: "folder",
      name: node.name,
      path: node.path,
      children: new Map(),
    };

    for (const [k, child] of node.children) {
      if (child.kind === "file") {
        const hit =
          !ft ||
          child.entry.path.toLowerCase().includes(ft) ||
          (child.entry.displayName ?? "").toLowerCase().includes(ft);
        if (hit) out.children.set(k, child);
      } else {
        const sub = this.filterTree(child, ft);
        if (sub && sub.children.size > 0) out.children.set(k, sub);
      }
    }

    const isZoneRoot =
      node.path === "__zoneA" ||
      node.path === "__zoneB" ||
      node.path === "__zoneCO" ||
      node.path === "__zoneCO/C" ||
      node.path === "__zoneCO/OUT";

    if (isZoneRoot) return out;
    return out.children.size ? out : null;
  }

  private renderNode(parentEl: HTMLElement, node: TreeNode): void {
    if (node.kind === "folder") this.renderFolder(parentEl, node);
    else this.renderFile(parentEl, node.entry);
  }

  private renderFolder(parentEl: HTMLElement, node: TreeNode & { kind: "folder" }): void {
    const isCollapsed = this.collapsed.has(node.path);

    const folderEl = parentEl.createDiv({ cls: "tree-item nav-folder" });
    folderEl.toggleClass("is-collapsed", isCollapsed);

    const self = folderEl.createDiv({
      cls: "tree-item-self nav-folder-title is-clickable mod-collapsible",
    });

    const iconEl = self.createDiv({ cls: "tree-item-icon collapse-icon" });
    setIcon(iconEl, "right-triangle");
    iconEl.toggleClass("is-collapsed", isCollapsed);

    const title = self.createDiv({ cls: "tree-item-inner nav-folder-title-content" });
    title.setText(node.name || "/");

    const flairOuter = self.createDiv({ cls: "tree-item-flair-outer" });
    const todo = this.countTodo(node);
    if (todo > 0) {
      const flair = flairOuter.createSpan({ cls: "tree-item-flair katt-flair katt-counter" });
      flair.setText(String(todo));
    } else {
      flairOuter.createSpan({ cls: "tree-item-flair katt-flair katt-counter is-empty" }).setText("");
    }

    this.registerDomEvent(self, "click", (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      if (this.collapsed.has(node.path)) this.collapsed.delete(node.path);
      else this.collapsed.add(node.path);
      this.render();
    });

    const children = folderEl.createDiv({ cls: "tree-item-children nav-folder-children" });
    if (isCollapsed) return;

    const items = [...node.children.values()].sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === "folder" ? -1 : 1;
      const an = a.kind === "folder" ? a.name : a.entry.displayName ?? a.entry.path;
      const bn = b.kind === "folder" ? b.name : b.entry.displayName ?? b.entry.path;
      return an.localeCompare(bn);
    });

    for (const child of items) this.renderNode(children, child);
  }

  private renderFile(parentEl: HTMLElement, e: FileEntry): void {
    const fileEl = parentEl.createDiv({ cls: "tree-item nav-file" });
    const self = fileEl.createDiv({ cls: "tree-item-self nav-file-title is-clickable" });

    self.createDiv({ cls: "tree-item-icon" });

    const title = self.createDiv({ cls: "tree-item-inner nav-file-title-content" });
    title.setText(e.displayName ?? e.path.split("/").pop() ?? e.path);

    const flairOuter = self.createDiv({ cls: "tree-item-flair-outer" });
    const mark = this.markOf(e);

    const flair = flairOuter.createSpan({
      cls: `tree-item-flair katt-flair katt-mark ${this.markClass(mark)} ${e.isPreview ? "is-preview" : ""}`,
    });
    flair.setText(mark);

    if (this.previewMode && this.shouldStrike(e)) {
      title.addClass("katt-strike");
    }

    if (this.showActions && !e.isPreview && (mark === "B" || mark === "R")) {
      let targetPath: string | null = null;

      if (e.action.type === "moveTo") {
        targetPath = (e.action as { target: string }).target;
      } else if (e.action.type === "moveToB") {
        const fileName = e.path.split("/").pop() ?? e.path;
        targetPath = `Zone B/${fileName}`;
      }

      if (targetPath) {
        const targetEl = self.createDiv({ cls: "katt-target-path" });
        targetEl.setText(`→ ${targetPath}`);
      }
    }

    if (mark === "C") {
      let conflictInfo = e.tags.join(", ");
      if (e.conflictWith && e.conflictWith.length > 0) {
        conflictInfo += "\nConflicts with:\n" + e.conflictWith.map((p) => "• " + p).join("\n");
      }
      conflictInfo += "\n\nTip: Disable 'Global name check' in settings to ignore.";
      flair.title = conflictInfo;
    } else if (e.isPreview && e.virtualFrom) {
      flair.title = `Preview target\nFrom: ${e.virtualFrom}\nTo: ${e.path}`;
    } else if (mark === "R" && e.action.type === "moveTo") {
      const action = e.action as { target: string; reason?: string };
      flair.title = `Target: ${action.target}${action.reason ? `\nReason: ${action.reason}` : ""}`;
    } else if (mark === "B" && e.action.type === "moveToB") {
      const action = e.action as { reason?: string };
      const fileName = e.path.split("/").pop() ?? e.path;
      flair.title = `Orphan → Zone B/${fileName}${action.reason ? `\nReason: ${action.reason}` : ""}`;
    } else if (mark === "M") {
      flair.title = "Missing file - referenced but not found";
    } else if (mark === "K") {
      flair.title = `Kept at: ${e.path}`;
    }

    this.registerDomEvent(self, "click", async (ev) => {
      ev.preventDefault();
      ev.stopPropagation();

      if (mark === "M") return;

      const toOpen = e.isPreview && e.virtualFrom ? e.virtualFrom : e.path;
      await this.plugin.openFileByPath(toOpen);
    });
  }

  /** mark rules: - K B R M C */
  private markOf(e: FileEntry): Mark {
    if (e.kind === "note-md") return "-";
    if (e.tags.includes("missing")) return "M";
    if (e.tags.includes("conflict-target-occupied") || e.tags.includes("conflict-ambiguous-name")) return "C";
    if (e.action.type === "keep") return "K";
    if (e.action.type === "moveTo") return "R";
    return "B";
  }

  private shouldStrike(e: FileEntry): boolean {
    const m = this.markOf(e);
    if (m !== "B" && m !== "R") return false;
    if (e.isPreview) return false;
    return true;
  }

  private markClass(mark: string): string {
    if (mark === "-") return "is-dash";
    return `is-${mark}`;
  }

  private countTodo(node: TreeNode & { kind: "folder" }): number {
    let n = 0;
    for (const child of node.children.values()) {
      if (child.kind === "file") {
        if (child.entry.isPreview) continue;
        const m = this.markOf(child.entry);
        if (m === "B" || m === "R" || m === "C" || m === "M") n++;
      } else {
        n += this.countTodo(child);
      }
    }
    return n;
  }

  /** CSS is now in styles.css - this method is kept for any dynamic style needs */
  private injectStyle(): void {
    // Styles are loaded from styles.css by Obsidian automatically
    // This method is retained for potential future dynamic styling
  }
}
