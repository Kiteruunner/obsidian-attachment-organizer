import {
  App,
  Modal,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  TFile,
  TFolder,
  normalizePath,
} from "obsidian";
import { AttachView, ATTACH_VIEW_TYPE } from "./attach-view";

/** ===== Undo History =====
 * Reason: Users need ability to undo accidental batch moves.
 * Stores last N operations for potential rollback.
 */
type UndoEntry = {
  timestamp: number;
  moves: { from: string; to: string }[];
};

const MAX_UNDO_HISTORY = 10;

/** ===== Model (final) ===== */
export type FileKind = "note-md" | "attachment-file" | "attachment-md" | "unknown";
export type Zone = "A" | "B" | "C" | "OUT";

export type Backlink = {
  from: string; // note path
  raw: string; // raw link string
  cleaned: string; // cleaned file-part (no alias/#/^/?)
  explicitPath?: string; // normalized vault path if link contains "/" (incl. ../ ./ / folder/)
};

export type Action =
  | { type: "keep" }
  | { type: "moveToB"; reason: string }
  | { type: "moveTo"; target: string; reason: string; explicit?: boolean }
  | { type: "unknown"; reason: string };

export type FileEntry = {
  path: string;
  displayName?: string;

  zone: Zone;
  kind: FileKind;

  referencedByNotes: Backlink[];

  action: Action;

  // tags are minimal
  tags: string[]; // "missing" | "orphan" | "conflict-target-occupied" | "conflict-ambiguous-name"

  // Conflict details - shows what file(s) caused the conflict
  // Reason: Users need to know WHY there's a conflict to resolve it
  conflictWith?: string[];

  // preview helper (only present on preview entries)
  virtualFrom?: string; // source path
  isPreview?: boolean; // true if preview entry
};

export type DetectReport = {
  entries: FileEntry[]; // real + missing (and OUT referenced)
  preview: FileEntry[]; // planned targets (virtual)
  stats: {
    notes: number;
    attachments: number;
    todo: number; // B/R/M/C
    missing: number;
    conflicts: number;
    total: number;
  };
};

/** ===== Settings (final) ===== */
type BacklinkScope = "zoneA-only" | "whole-vault";
type GlobalNameCheck = "off" | "on-ignore-explicit" | "on-even-explicit";
type MultiBacklinkPolicy = "unchanged" | "lca" | "pick-first";
type LinkSources = { links: boolean; embeds: boolean; frontmatter: boolean };

type PlacementMode =
  | "vault-folder"
  | "specified-folder"
  | "same-folder-as-note"
  | "subfolder-under-note";

type Settings = {
  zoneA: string; // empty => vault root
  zoneB: string;
  extraScanFolders: string[]; // multiple folders for extra scan
  extraScanEnabled: boolean; // toggle for extra scan feature
  recursive: boolean;

  backlinkScope: BacklinkScope;
  linkSources: LinkSources;

  placement: {
    mode: PlacementMode;
    specifiedFolder: string;
    subfolderName: string;
  };

  multiBacklinkPolicy: MultiBacklinkPolicy;
  globalNameCheck: GlobalNameCheck;

  // attachment rules: one regex per line
  attachmentRulesText: string; // e.g. "\\.excalidraw\\.md$"
  planOutAttachments: boolean; // OUT items: include in planning (default false)

  // UI settings
  showStats: boolean; // show stats in organizer view
};

const DEFAULT_ATTACHMENT_RULES = ["\\.excalidraw\\.md$", "\\.canvas\\.md$"].join("\n");

const DEFAULT_SETTINGS: Settings = {
  zoneA: "SETs",
  zoneB: "Draft",
  extraScanFolders: [],
  extraScanEnabled: false,

  recursive: true,

  backlinkScope: "zoneA-only",
  linkSources: { links: true, embeds: true, frontmatter: true },

  placement: {
    mode: "subfolder-under-note",
    specifiedFolder: "",
    subfolderName: "attachments",
  },

  multiBacklinkPolicy: "unchanged",
  globalNameCheck: "on-ignore-explicit",

  attachmentRulesText: DEFAULT_ATTACHMENT_RULES,
  planOutAttachments: false,

  showStats: false,
};

export default class KPlugin extends Plugin {
  settings: Settings = DEFAULT_SETTINGS;

  private lastReport: DetectReport | null = null;
  private dirty = true;

  private refreshTimer: number | null = null;

  // compiled attachment regex rules
  private attachmentRules: RegExp[] = [];

  // Undo history - stores recent move operations for rollback
  // Reason: Users may accidentally apply plan; this allows recovery
  private undoHistory: UndoEntry[] = [];

  /** Get the last undo entry (for UI display) */
  getLastUndo(): UndoEntry | null {
    return this.undoHistory.length > 0 ? this.undoHistory[this.undoHistory.length - 1] : null;
  }

  /** Check if undo is available */
  canUndo(): boolean {
    return this.undoHistory.length > 0;
  }

  async onload() {
    await this.loadSettings();
    this.compileAttachmentRules();

    this.addSettingTab(new KPluginSettingTab(this.app, this));

    this.registerView(ATTACH_VIEW_TYPE, (leaf) => {
      return new AttachView(leaf, {
        detectReport: (force?: boolean) => this.detectReport(!!force),
        openFileByPath: async (path: string) => {
          const af = this.app.vault.getAbstractFileByPath(normalizePath(path));
          if (af instanceof TFile) await this.app.workspace.getLeaf(true).openFile(af);
        },
        applyPlan: async () => this.applyPlan(),
        // Expose undo functionality to the view
        // Reason: Users need undo button in UI, not just command palette
        undoLastOperation: async () => this.undoLastOperation(),
        canUndo: () => this.canUndo(),
        // Settings access for UI options
        getShowStats: () => this.settings.showStats,
      });
    });

    this.addCommand({
      id: "open-organizer-view",
      name: "Open Organizer",
      callback: async () => this.activateView(),
    });

    this.addCommand({
      id: "organizer-rescan",
      name: "Organizer: Rescan",
      callback: async () => this.refreshOpenViews(true),
    });

    this.addCommand({
      id: "organizer-apply-plan",
      name: "Organizer: Apply plan",
      callback: async () => this.applyPlan(),
    });

    // Undo command - allows users to revert last batch operation
    // Reason: Batch moves are destructive; users need safety net
    this.addCommand({
      id: "organizer-undo",
      name: "Organizer: Undo last operation",
      callback: async () => this.undoLastOperation(),
    });

    // auto-dirty on vault changes (debounced)
    this.registerEvent(this.app.vault.on("create", () => this.markDirtyAndScheduleRefresh()));
    this.registerEvent(this.app.vault.on("delete", () => this.markDirtyAndScheduleRefresh()));
    this.registerEvent(this.app.vault.on("rename", () => this.markDirtyAndScheduleRefresh()));
    this.registerEvent(this.app.vault.on("modify", () => this.markDirtyAndScheduleRefresh()));
  }

  onunload() {
    this.app.workspace.detachLeavesOfType(ATTACH_VIEW_TYPE);
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
    this.compileAttachmentRules();
    this.markDirtyAndScheduleRefresh(true);
  }

  private async activateView(): Promise<void> {
    this.app.workspace.detachLeavesOfType(ATTACH_VIEW_TYPE);

    const leaf = this.app.workspace.getRightLeaf(false) ?? this.app.workspace.getLeaf(false);
    if (!leaf) return;

    await leaf.setViewState({ type: ATTACH_VIEW_TYPE, active: true });

    const opened = this.app.workspace.getLeavesOfType(ATTACH_VIEW_TYPE)[0];
    if (opened) this.app.workspace.revealLeaf(opened);
  }

  private markDirtyAndScheduleRefresh(force = false) {
    this.dirty = true;
    if (this.refreshTimer) window.clearTimeout(this.refreshTimer);
    this.refreshTimer = window.setTimeout(() => {
      this.refreshTimer = null;
      void this.refreshOpenViews(force);
    }, 600);
  }

  private async refreshOpenViews(force = false) {
    const leaves = this.app.workspace.getLeavesOfType(ATTACH_VIEW_TYPE);
    for (const leaf of leaves) {
      const view = leaf.view;
      if (view instanceof AttachView) {
        // eslint-disable-next-line @typescript-eslint/no-floating-promises
        view.rescan(force);
      }
    }
  }

  /** ===== DetectReport (inventory + backlinks + plan + preview/conflict) ===== */
  async detectReport(force: boolean): Promise<DetectReport> {
    if (!force && !this.dirty && this.lastReport) return this.lastReport;

    this.dirty = false;

    const map = new Map<string, FileEntry>();

    const ensure = (path: string, init?: Partial<FileEntry>) => {
      const p = normalizePath(path);
      let e = map.get(p);
      if (!e) {
        e = {
          path: p,
          displayName: p.split("/").pop() ?? p,
          zone: this.zoneOf(p),
          kind: this.kindOf(p),
          referencedByNotes: [],
          action: { type: "keep" },
          tags: [],
          ...init,
        };
        map.set(p, e);
      } else if (init) {
        Object.assign(e, init);
      }
      return e;
    };

    /** Step 1: inventory scan A/B/C */
    const inventoryFiles = this.scanInventoryFiles();
    for (const f of inventoryFiles) ensure(f.path);

    /** Step 2: parse backlinks (from notes) */
    const notes = this.listNotesByScope();
    const missingKeys = new Map<string, Backlink[]>();

    for (const md of notes) {
      const cache = this.app.metadataCache.getFileCache(md);
      if (!cache) continue;

      const from = md.path;

      const rawLinks: string[] = [];
      if (this.settings.linkSources.links) {
        for (const x of cache.links ?? []) rawLinks.push(x.link);
      }
      if (this.settings.linkSources.embeds) {
        for (const x of cache.embeds ?? []) rawLinks.push(x.link);
      }
      if (this.settings.linkSources.frontmatter) {
        for (const x of cache.frontmatterLinks ?? []) rawLinks.push(x.link);
      }

      for (const raw of rawLinks) {
        const parsed = this.parseLink(raw);
        if (!parsed) continue;

        const { cleanedFilePart } = parsed;

        if (!cleanedFilePart) continue;
        if (this.isExternal(cleanedFilePart)) continue;

        const isExplicit = cleanedFilePart.includes("/");

        const explicitDesired = isExplicit
          ? this.normalizeExplicitToVaultPath(cleanedFilePart, from)
          : undefined;

        // resolve:
        // 1) if explicitDesired exists => dest is that file
        // 2) else try Obsidian resolver on cleanedFilePart
        // 3) if still not found but explicitDesired exists: try basename fallback (so we can move it to explicit path)
        let dest: TFile | null = null;

        if (explicitDesired) {
          const af = this.app.vault.getAbstractFileByPath(explicitDesired);
          if (af instanceof TFile) dest = af;
        }

        if (!dest) {
          dest = this.resolveToFileByObsidian(cleanedFilePart, from);

          if (!dest && explicitDesired) {
            const base = explicitDesired.split("/").pop() ?? explicitDesired;
            dest = this.resolveToFileByObsidian(base, from);
          }
        }

        const bl: Backlink = {
          from,
          raw,
          cleaned: cleanedFilePart,
          explicitPath: explicitDesired, // desired target if explicit
        };

        if (dest) {
          const to = ensure(dest.path);
          to.zone = this.zoneOf(to.path);
          to.kind = this.kindOf(to.path);

          // push backlink (dedupe by from only)
          if (!to.referencedByNotes.some((x) => x.from === bl.from)) {
            to.referencedByNotes.push(bl);
          }
        } else {
          const key = explicitDesired ? explicitDesired : cleanedFilePart;
          if (!missingKeys.has(key)) missingKeys.set(key, []);
          missingKeys.get(key)!.push(bl);
        }
      }
    }

    // missing virtual entries
    for (const [key, bls] of missingKeys) {
      const p = `__missing/${key}`;
      ensure(p, {
        displayName: key.split("/").pop() ?? key,
        zone: "OUT",
        kind: "unknown",
        referencedByNotes: bls,
        action: { type: "unknown", reason: "missing" },
        tags: ["missing"],
      });
    }

    /** Step 3: plan actions (attachments only; skip zoneB; OUT optional) */
    for (const e of map.values()) {
      if (!this.isAttachmentKind(e.kind)) continue;
      if (e.tags.includes("missing")) continue;
      if (e.zone === "B") continue;
      if (e.zone === "OUT" && !this.settings.planOutAttachments) {
        e.action = { type: "keep" };
        continue;
      }

      const n = e.referencedByNotes.length;

      if (n === 0) {
        e.action = { type: "moveToB", reason: "orphan" };
        this.ensureTag(e, "orphan");
        continue;
      }

      if (n === 1) {
        const plan = this.planTargetForOneBacklink(e, e.referencedByNotes[0]);
        e.action = plan ?? { type: "keep" };
        continue;
      }

      // n > 1
      const plan = this.planTargetForMultiBacklink(e);
      e.action = plan ?? { type: "keep" };
    }

    /** Step 4: preview simulate + mark conflicts (both sides C; keep unchanged) */
    const preview = this.simulatePreviewAndMarkConflicts(map);

    /** Stats */
    let notesN = 0,
      attachN = 0,
      todoN = 0,
      missN = 0,
      conflictN = 0;

    for (const e of map.values()) {
      if (e.kind === "note-md") notesN++;
      if (this.isAttachmentKind(e.kind)) attachN++;
      if (e.tags.includes("missing")) missN++;
      if (this.isConflict(e)) conflictN++;

      const mk = this.markOf(e);
      if (mk === "B" || mk === "R" || mk === "C" || mk === "M") todoN++;
    }

    // which OUT to show: referenced or missing or conflict or preview targets
    const previewTargetSet = new Set(preview.map((p) => normalizePath(p.path)));
    const reportEntries = [...map.values()].filter((e) => {
      if (e.path.startsWith("__missing/")) return true;
      if (e.zone === "A" || e.zone === "B" || e.zone === "C") return true;
      const isPlanned = e.action.type === "moveToB" || e.action.type === "moveTo";

      // OUT: show if referenced / conflict / planned / preview target
      return (
        e.referencedByNotes.length > 0 ||
        this.isConflict(e) ||
        isPlanned ||
        previewTargetSet.has(e.path)
      );
    });

    const report: DetectReport = {
      entries: reportEntries,
      preview,
      stats: {
        notes: notesN,
        attachments: attachN,
        todo: todoN,
        missing: missN,
        conflicts: conflictN,
        total: map.size,
      },
    };

    this.lastReport = report;
    return report;
  }

  /** ===== Apply plan: execute conflict-free preview moves ===== 
   * Improvements made:
   * 1. Added confirmation dialog - prevents accidental batch operations
   * 2. Added undo support - stores moves for potential rollback
   * 3. Better error messages - shows which files failed and why
   * 4. Progress feedback - shows operation progress
   */
  async applyPlan(skipConfirm = false): Promise<void> {
    const report = await this.detectReport(true);

    const moves = report.preview
      .filter((p) => p.isPreview && p.virtualFrom)
      .map((p) => ({ from: normalizePath(p.virtualFrom!), to: normalizePath(p.path) }));

    if (moves.length === 0) {
      // Better feedback: explain WHY there are no moves
      // Reason: Users see C marks but don't understand they block moves
      const report2 = this.lastReport;
      if (report2) {
        const conflicts = report2.entries.filter(e => 
          e.tags.includes('conflict-target-occupied') || 
          e.tags.includes('conflict-ambiguous-name')
        ).length;
        const kept = report2.entries.filter(e => 
          e.action.type === 'keep' && !e.tags.includes('missing')
        ).length;
        
        if (conflicts > 0) {
          new Notice(
            `No planned moves.\n\n${conflicts} file(s) have conflicts (C) that block moving.\n` +
            `Check "Global name check" setting or resolve duplicate filenames.`,
            8000
          );
        } else if (kept > 0) {
          new Notice(`All ${kept} attachment(s) are already in correct locations.`);
        } else {
          new Notice("No planned moves to apply.");
        }
      } else {
        new Notice("No planned moves to apply.");
      }
      return;
    }

    // Reason: Confirmation prevents accidental batch operations
    // Users should see what will happen before committing
    if (!skipConfirm) {
      const confirmed = await this.showConfirmDialog(
        "Apply Organizer Plan",
        `This will move ${moves.length} file(s).\n\nAre you sure?`,
        moves.slice(0, 5).map(m => `• ${m.from.split('/').pop()} → ${m.to}`).join('\n') +
        (moves.length > 5 ? `\n... and ${moves.length - 5} more` : '')
      );
      if (!confirmed) return;
    }

    let ok = 0;
    let fail = 0;
    const errors: string[] = [];
    const successfulMoves: { from: string; to: string }[] = [];

    for (const mv of moves) {
      try {
        const af = this.app.vault.getAbstractFileByPath(mv.from);
        if (!(af instanceof TFile)) {
          fail++;
          errors.push(`${mv.from}: file not found`);
          continue;
        }

        const folder = this.dirname(mv.to);
        await this.ensureFolderExists(folder);

        await this.app.vault.rename(af, mv.to);
        successfulMoves.push(mv);
        ok++;
      } catch (e) {
        fail++;
        errors.push(`${mv.from}: ${e instanceof Error ? e.message : 'unknown error'}`);
      }
    }

    // Store in undo history for potential rollback
    // Reason: Users need ability to recover from mistakes
    if (successfulMoves.length > 0) {
      this.undoHistory.push({
        timestamp: Date.now(),
        moves: successfulMoves,
      });
      // Keep history bounded
      while (this.undoHistory.length > MAX_UNDO_HISTORY) {
        this.undoHistory.shift();
      }
    }

    // Better feedback with error details
    // Reason: Users need to know what went wrong to fix issues
    if (fail > 0 && errors.length > 0) {
      new Notice(`Applied: ${ok} moved, ${fail} failed.\n${errors.slice(0, 3).join('\n')}`, 8000);
    } else {
      new Notice(`✓ Applied: ${ok} file(s) moved successfully.${this.canUndo() ? ' (Undo available)' : ''}`);
    }
    
    this.markDirtyAndScheduleRefresh(true);
  }

  /** Undo the last batch operation
   * Reason: Provides safety net for accidental batch moves
   */
  async undoLastOperation(): Promise<void> {
    const entry = this.undoHistory.pop();
    if (!entry) {
      new Notice("Nothing to undo.");
      return;
    }

    const confirmed = await this.showConfirmDialog(
      "Undo Last Operation",
      `This will revert ${entry.moves.length} file move(s) from ${new Date(entry.timestamp).toLocaleTimeString()}.`,
      entry.moves.slice(0, 5).map(m => `• ${m.to.split('/').pop()} → ${m.from}`).join('\n') +
      (entry.moves.length > 5 ? `\n... and ${entry.moves.length - 5} more` : '')
    );
    if (!confirmed) {
      this.undoHistory.push(entry); // restore
      return;
    }

    let ok = 0;
    let fail = 0;

    // Reverse the moves
    for (const mv of entry.moves) {
      try {
        const af = this.app.vault.getAbstractFileByPath(mv.to);
        if (!(af instanceof TFile)) {
          fail++;
          continue;
        }

        const folder = this.dirname(mv.from);
        await this.ensureFolderExists(folder);

        await this.app.vault.rename(af, mv.from);
        ok++;
      } catch {
        fail++;
      }
    }

    new Notice(`Undo: ${ok} restored, ${fail} failed.`);
    this.markDirtyAndScheduleRefresh(true);
  }

  /** Show a confirmation dialog
   * Reason: Modal confirmation prevents accidental destructive operations
   */
  private showConfirmDialog(title: string, message: string, details?: string): Promise<boolean> {
    return new Promise((resolve) => {
      const modal = new ConfirmModal(this.app, title, message, details, resolve);
      modal.open();
    });
  }

  /** ===== preview/conflict ===== */
  private simulatePreviewAndMarkConflicts(map: Map<string, FileEntry>): FileEntry[] {
    const plannedTargets = new Map<string, string>(); // targetPath -> entry.path
    const plannedName = new Map<string, string>(); // nameKey -> entry.path
    const plannedFolderName = new Map<string, string>(); // folderKey::nameKey -> entry.path

    // existing names for ambiguous
    const existingByName = new Map<string, string[]>();
    for (const f of this.app.vault.getFiles()) {
      const key = this.nameKey(f.path);
      const arr = existingByName.get(key) ?? [];
      arr.push(f.path);
      existingByName.set(key, arr);
    }

    const candidates = [...map.values()]
      .filter((e) => this.isAttachmentKind(e.kind))
      .filter((e) => !e.tags.includes("missing"))
      .filter((e) => e.action.type === "moveToB" || e.action.type === "moveTo")
      .sort((a, b) => a.path.localeCompare(b.path));

    const preview: FileEntry[] = [];

    const rollbackPlanned = (entryPath: string, tag: string) => {
      const e = map.get(entryPath);
      if (!e) return;

      // remove its planned target from indices
      for (const [t, ep] of plannedTargets) {
        if (ep === entryPath) {
          plannedTargets.delete(t);
          const fk = this.folderKey(t);
          const nk = this.nameKey(t);
          plannedFolderName.delete(`${fk}::${nk}`);
          plannedName.delete(nk);
          break;
        }
      }

      this.ensureConflict(e, tag);
      e.action = { type: "keep" };
    };

    const markBothAndRollback = (a: FileEntry, bPath: string, tag: string) => {
      this.ensureConflict(a, tag);
      a.action = { type: "keep" };

      const b = map.get(bPath);
      if (b) {
        this.ensureConflict(b, tag);
        b.action = { type: "keep" };
        rollbackPlanned(b.path, tag);
      }
    };

    for (const e of candidates) {
      if (this.isConflict(e)) continue;

      const target = this.targetOf(e);
      if (!target) {
        e.action = { type: "keep" };
        continue;
      }
      if (normalizePath(target) === normalizePath(e.path)) {
        e.action = { type: "keep" };
        continue;
      }

      const explicitMove = e.action.type === "moveTo" && !!e.action.explicit;

      // (1) target path collision with planned target
      const occupiedBy = plannedTargets.get(target);
      if (occupiedBy) {
        markBothAndRollback(e, occupiedBy, "conflict-target-occupied");
        continue;
      }

      // (2) existing file occupies target
      const af = this.app.vault.getAbstractFileByPath(target);
      if (af instanceof TFile) {
        this.ensureConflict(e, "conflict-target-occupied");
        e.action = { type: "keep" };
        const occ = map.get(af.path);
        if (occ) {
          this.ensureConflict(occ, "conflict-target-occupied");
          occ.action = { type: "keep" };
        }
        continue;
      }

      // (3) folder same-name collision (normalized)
      const fk = this.folderKey(target);
      const nk = this.nameKey(target);
      const folderNameKey = `${fk}::${nk}`;
      const folderHit = plannedFolderName.get(folderNameKey);
      if (folderHit) {
        markBothAndRollback(e, folderHit, "conflict-target-occupied");
        continue;
      }

      // (4) global ambiguous-name
      const gmode = this.settings.globalNameCheck;
      const shouldCheckGlobal = gmode !== "off" && (gmode === "on-even-explicit" || !explicitMove);

      if (shouldCheckGlobal) {
        const plannedHit = plannedName.get(nk);
        if (plannedHit) {
          markBothAndRollback(e, plannedHit, "conflict-ambiguous-name");
          continue;
        }

        const exist = existingByName.get(nk) ?? [];
        const others = exist.filter((p) => normalizePath(p) !== normalizePath(e.path));
        if (others.length > 0) {
          this.ensureConflict(e, "conflict-ambiguous-name");
          // Store what files caused the conflict so user can see
          // Reason: Users need to know which files have same name to resolve
          e.conflictWith = others.slice(0, 3); // limit to 3 for display
          e.action = { type: "keep" };
          continue;
        }
      }

      // success: record planned move
      plannedTargets.set(target, e.path);
      plannedFolderName.set(folderNameKey, e.path);
      if (shouldCheckGlobal) plannedName.set(nk, e.path);

      // build preview entry (virtual target)
      preview.push({
        ...e,
        path: target,
        displayName: target.split("/").pop() ?? target,
        zone: this.zoneOf(target),
        virtualFrom: e.path,
        isPreview: true,
      });
    }

    return preview;
  }

  /** ===== planning ===== */
  private planTargetForOneBacklink(e: FileEntry, bl: Backlink): Action | null {
    const name = e.path.split("/").pop() ?? e.path;

    // explicit > policy > keep
    if (bl.explicitPath) {
      return {
        type: "moveTo",
        target: bl.explicitPath,
        reason: "single-backlink-explicit",
        explicit: true,
      };
    }

    const baseFolder = this.dirname(bl.from);
    const targetFolder = this.targetFolderFromPolicy(baseFolder);
    if (targetFolder === null) return null;

    return {
      type: "moveTo",
      target: normalizePath(targetFolder ? `${targetFolder}/${name}` : name),
      reason: "single-backlink-policy",
    };
  }

  private planTargetForMultiBacklink(e: FileEntry): Action | null {
    const bls = e.referencedByNotes;
    if (bls.length < 2) return null;

    const policy = this.settings.multiBacklinkPolicy;
    if (policy === "unchanged") return null;

    const name = e.path.split("/").pop() ?? e.path;

    if (policy === "pick-first") {
      const baseFolder = this.dirname(bls[0].from);
      const targetFolder = this.targetFolderFromPolicy(baseFolder);
      if (targetFolder === null) return null;
      return {
        type: "moveTo",
        target: normalizePath(targetFolder ? `${targetFolder}/${name}` : name),
        reason: "multi-pick-first",
      };
    }

    // policy === "lca"
    const folders = bls.map((x) => this.dirname(x.from));
    const lca = this.lcaFolder(folders);
    const targetFolder = this.targetFolderFromPolicy(lca);
    if (targetFolder === null) return null;

    return {
      type: "moveTo",
      target: normalizePath(targetFolder ? `${targetFolder}/${name}` : name),
      reason: "multi-lca",
    };
  }

  private targetFolderFromPolicy(baseFolder: string): string | null {
    const p = this.settings.placement;
    if (p.mode === "vault-folder") return "";
    if (p.mode === "specified-folder") return normalizePath(p.specifiedFolder || "");
    if (p.mode === "same-folder-as-note") return normalizePath(baseFolder || "");
    if (p.mode === "subfolder-under-note") {
      const sub = normalizePath(p.subfolderName || "");
      if (!sub) return normalizePath(baseFolder || "");
      return normalizePath(baseFolder ? `${baseFolder}/${sub}` : sub);
    }
    return null;
  }

  private targetOf(e: FileEntry): string | null {
    if (e.action.type === "moveTo") return normalizePath(e.action.target);
    if (e.action.type === "moveToB") {
      const b = normalizePath(this.settings.zoneB || "");
      if (!b) return null;
      const name = e.path.split("/").pop() ?? e.path;
      return normalizePath(`${b}/${name}`);
    }
    return null;
  }

  /** ===== inventory ===== */
  private scanInventoryFiles(): TFile[] {
    const out: TFile[] = [];
    const seen = new Set<string>();

    const scanFolder = (folder: TFolder) => {
      const files = this.listAllFiles(folder, this.settings.recursive);
      for (const f of files) {
        if (!seen.has(f.path)) {
          seen.add(f.path);
          out.push(f);
        }
      }
    };

    // Always scan Workspace (zone A)
    scanFolder(this.getFolderOrRoot(this.settings.zoneA));

    if (normalizePath(this.settings.zoneA || "") !== "") {
      // Scan Staging (zone B)
      const b = this.getFolder(this.settings.zoneB);
      if (b) scanFolder(b);

      // Extra Scan logic
      if (this.settings.extraScanEnabled) {
        const folders = this.settings.extraScanFolders.filter((f) => f.trim());
        if (folders.length > 0) {
          // Scan specific folders
          for (const folderPath of folders) {
            const folder = this.getFolder(folderPath);
            if (folder) scanFolder(folder);
          }
        } else {
          // Scan whole vault (files not already in A/B)
          const aPath = normalizePath(this.settings.zoneA || "");
          const bPath = normalizePath(this.settings.zoneB || "");
          for (const f of this.app.vault.getFiles()) {
            if (seen.has(f.path)) continue;
            const p = normalizePath(f.path);
            // Skip if in A or B
            if (aPath && (p === aPath || p.startsWith(aPath + "/"))) continue;
            if (bPath && (p === bPath || p.startsWith(bPath + "/"))) continue;
            seen.add(f.path);
            out.push(f);
          }
        }
      }
    }

    return out;
  }

  private listNotesByScope(): TFile[] {
    const allMd = this.app.vault.getMarkdownFiles();
    const notes = allMd.filter((f) => this.isNoteMd(f.path));

    if (this.settings.backlinkScope === "whole-vault") return notes;
    return notes.filter((f) => this.zoneOf(f.path) === "A");
  }

  /** ===== helpers ===== */
  private compileAttachmentRules() {
    const lines = (this.settings.attachmentRulesText || "")
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);

    // ensure built-in defaults always exist (never lose excalidraw)
    const merged = new Set<string>(DEFAULT_ATTACHMENT_RULES.split("\n").map((s) => s.trim()));
    for (const l of lines) merged.add(l);

    const compiled: RegExp[] = [];
    for (const rule of merged) {
      try {
        compiled.push(new RegExp(rule, "i"));
      } catch {
        new Notice(`Invalid attachment rule regex: ${rule}`);
      }
    }
    this.attachmentRules = compiled;
  }

  private zoneOf(path: string): Zone {
    const p = normalizePath(path);

    const b = normalizePath(this.settings.zoneB || "");
    const a = normalizePath(this.settings.zoneA || "");

    if (b && (p === b || p.startsWith(b + "/"))) return "B";

    // Check if in any extra scan folder
    if (this.settings.extraScanEnabled) {
      for (const folder of this.settings.extraScanFolders) {
        const c = normalizePath(folder || "");
        if (c && (p === c || p.startsWith(c + "/"))) return "C";
      }
    }

    if (!a) return "A";
    if (p === a || p.startsWith(a + "/")) return "A";
    return "OUT";
  }

  private kindOf(path: string): FileKind {
    const p = path.toLowerCase();
    if (p.endsWith(".md")) return this.isAttachmentMd(path) ? "attachment-md" : "note-md";
    return "attachment-file";
  }

  private isAttachmentKind(k: FileKind): boolean {
    return k === "attachment-file" || k === "attachment-md";
  }

  private isAttachmentMd(path: string): boolean {
    const p = normalizePath(path);
    if (!p.toLowerCase().endsWith(".md")) return false;
    return this.attachmentRules.some((r) => r.test(p));
  }

  private isNoteMd(path: string): boolean {
    const p = path.toLowerCase();
    return p.endsWith(".md") && !this.isAttachmentMd(path);
  }

  private listAllFiles(folder: TFolder, recursive: boolean): TFile[] {
    const out: TFile[] = [];
    const walk = (f: TFolder) => {
      for (const child of f.children) {
        if (child instanceof TFile) out.push(child);
        else if (recursive && child instanceof TFolder) walk(child);
      }
    };
    walk(folder);
    return out;
  }

  private getFolder(path: string): TFolder | null {
    const p = normalizePath(path || "");
    if (!p) return null;
    const af = this.app.vault.getAbstractFileByPath(p);
    return af instanceof TFolder ? af : null;
  }

  private getFolderOrRoot(path: string): TFolder {
    const p = normalizePath(path || "");
    if (!p) return this.app.vault.getRoot();
    return this.getFolder(p) ?? this.app.vault.getRoot();
  }

  private isExternal(raw: string): boolean {
    const s = raw.trim().toLowerCase();
    return s.startsWith("http://") || s.startsWith("https://") || s.startsWith("mailto:") || s.startsWith("file://");
  }

  /** parse raw link -> file-part (no alias/#/^/?) */
  private parseLink(raw: string): { cleanedFilePart: string } | null {
    let s = (raw ?? "").trim();
    if (!s) return null;

    // alias: a|alias
    const pipe = s.indexOf("|");
    if (pipe !== -1) s = s.slice(0, pipe);

    const cutAt = (ch: string, input: string) => {
      const i = input.indexOf(ch);
      return i === -1 ? input : input.slice(0, i);
    };

    s = cutAt("#", s);
    s = cutAt("^", s);
    s = cutAt("?", s);

    s = s.trim().replace(/\\/g, "/");

    if (s.includes("%")) {
      try {
        s = decodeURIComponent(s);
      } catch {
        // ignore
      }
    }

    if (!s) return null;
    return { cleanedFilePart: s };
  }

  private normalizeExplicitToVaultPath(explicitRaw: string, fromNotePath: string): string {
    let s = explicitRaw.trim().replace(/\\/g, "/");

    if (s.startsWith("/")) s = s.slice(1);

    if (s.startsWith("./") || s.startsWith("../")) {
      const base = this.dirname(fromNotePath);
      return normalizePath(base ? `${base}/${s}` : s);
    }

    return normalizePath(s);
  }

  private resolveToFileByObsidian(linkKey: string, fromMdPath: string): TFile | null {
    let dest = this.app.metadataCache.getFirstLinkpathDest(linkKey, fromMdPath);
    if (dest instanceof TFile) return dest;

    // try without leading slash
    if (linkKey.startsWith("/")) {
      const noSlash = linkKey.slice(1);
      dest = this.app.metadataCache.getFirstLinkpathDest(noSlash, fromMdPath);
      if (dest instanceof TFile) return dest;

      const direct = this.app.vault.getAbstractFileByPath(normalizePath(noSlash));
      if (direct instanceof TFile) return direct;
    }
    return null;
  }

  private ensureTag(e: FileEntry, tag: string) {
    if (!e.tags.includes(tag)) e.tags.push(tag);
  }

  private ensureConflict(e: FileEntry, tag: string) {
    if (tag !== "conflict-target-occupied" && tag !== "conflict-ambiguous-name") {
      tag = "conflict-target-occupied";
    }
    this.ensureTag(e, tag);
  }

  private isConflict(e: FileEntry): boolean {
    return e.tags.includes("conflict-target-occupied") || e.tags.includes("conflict-ambiguous-name");
  }

  // mark rules (final): - K B R M C
  private markOf(e: FileEntry): "-" | "K" | "B" | "R" | "M" | "C" {
    if (e.kind === "note-md") return "-";
    if (e.tags.includes("missing")) return "M";
    if (this.isConflict(e)) return "C";
    if (e.action.type === "keep") return "K";
    if (e.action.type === "moveTo") return "R";
    return "B";
  }

  private dirname(path: string): string {
    const p = normalizePath(path);
    const i = p.lastIndexOf("/");
    return i === -1 ? "" : p.slice(0, i);
  }

  private folderKey(path: string): string {
    return this.dirname(path).toLowerCase();
  }

  private nameKey(path: string): string {
    const name = (path.split("/").pop() ?? path).toLowerCase();
    return name.normalize("NFKC");
  }

  private lcaFolder(folders: string[]): string {
    if (folders.length === 0) return "";
    const parts = folders.map((p) => normalizePath(p).split("/").filter(Boolean));
    let prefix = parts[0];

    for (let i = 1; i < parts.length; i++) {
      const cur = parts[i];
      let j = 0;
      while (j < prefix.length && j < cur.length && prefix[j] === cur[j]) j++;
      prefix = prefix.slice(0, j);
      if (prefix.length === 0) break;
    }
    return prefix.join("/");
  }

  private async ensureFolderExists(folderPath: string): Promise<void> {
    const p = normalizePath(folderPath || "");
    if (!p) return;

    const parts = p.split("/").filter(Boolean);
    let cur = "";
    for (const part of parts) {
      cur = cur ? `${cur}/${part}` : part;
      const af = this.app.vault.getAbstractFileByPath(cur);
      if (!af) {
        try {
          await this.app.vault.createFolder(cur);
        } catch {
          // ignore (race)
        }
      }
    }
  }

  private async loadSettings(): Promise<void> {
    const loaded = await this.loadData();
    this.settings = Object.assign({}, DEFAULT_SETTINGS, loaded);

    // Migration: convert old zoneC string to extraScanFolders array
    if (loaded && typeof (loaded as any).zoneC === "string" && (loaded as any).zoneC.trim()) {
      const oldZoneC = (loaded as any).zoneC.trim();
      if (!this.settings.extraScanFolders.includes(oldZoneC)) {
        this.settings.extraScanFolders = [oldZoneC];
        this.settings.extraScanEnabled = true;
      }
      delete (this.settings as any).zoneC;
      await this.saveData(this.settings);
    }

    // Ensure extraScanFolders is always an array
    if (!Array.isArray(this.settings.extraScanFolders)) {
      this.settings.extraScanFolders = [];
    }

    // ensure defaults never lost
    if (!this.settings.attachmentRulesText?.trim()) {
      this.settings.attachmentRulesText = DEFAULT_ATTACHMENT_RULES;
    }
  }
}

/** ===== Settings Tab ===== */
class KPluginSettingTab extends PluginSettingTab {
  plugin: KPlugin;

  constructor(app: App, plugin: KPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl("h2", { text: "Organizer Settings" });

    new Setting(containerEl)
      .setName("Workspace folder")
      .setDesc("Root folder to organize (empty = vault root).")
      .addText((t) =>
        t
          .setPlaceholder("e.g. SETs")
          .setValue(this.plugin.settings.zoneA)
          .onChange(async (v) => {
            this.plugin.settings.zoneA = v.trim();
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Staging folder")
      .setDesc("Cleanup / bin folder for orphan attachments.")
      .addText((t) =>
        t
          .setPlaceholder("e.g. Draft")
          .setValue(this.plugin.settings.zoneB)
          .onChange(async (v) => {
            this.plugin.settings.zoneB = v.trim();
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Enable Extra Scan")
      .setDesc("Scan files outside Workspace and Staging to find referenced attachments.")
      .addToggle((tg) =>
        tg.setValue(this.plugin.settings.extraScanEnabled).onChange(async (v) => {
          this.plugin.settings.extraScanEnabled = v;
          await this.plugin.saveSettings();
          this.display(); // refresh to show/hide folder inputs
        })
      );

    if (this.plugin.settings.extraScanEnabled) {
      // Container for extra scan folders
      const foldersContainer = containerEl.createDiv({ cls: "katt-extra-folders" });
      
      const folders = this.plugin.settings.extraScanFolders;
      
      // Show info about empty = whole vault
      new Setting(foldersContainer)
        .setName("Extra Scan folders")
        .setDesc("Add specific folders to scan. Leave all empty to scan whole vault.");

      // Render existing folders
      for (let i = 0; i < folders.length; i++) {
        const folderSetting = new Setting(foldersContainer)
          .addText((t) =>
            t
              .setPlaceholder("folder path")
              .setValue(folders[i])
              .onChange(async (v) => {
                this.plugin.settings.extraScanFolders[i] = v.trim();
                await this.plugin.saveSettings();
              })
          )
          .addExtraButton((btn) =>
            btn
              .setIcon("trash")
              .setTooltip("Remove folder")
              .onClick(async () => {
                this.plugin.settings.extraScanFolders.splice(i, 1);
                await this.plugin.saveSettings();
                this.display();
              })
          );
        folderSetting.settingEl.addClass("katt-extra-folder-item");
      }

      // Add folder button
      new Setting(foldersContainer)
        .addButton((btn) =>
          btn
            .setButtonText("+ Add folder")
            .setCta()
            .onClick(async () => {
              this.plugin.settings.extraScanFolders.push("");
              await this.plugin.saveSettings();
              this.display();
            })
        );

      // Show current mode
      const activeCount = folders.filter((f) => f.trim()).length;
      if (activeCount === 0) {
        foldersContainer.createEl("p", {
          text: "📁 Currently scanning: Whole vault (outside Workspace/Staging)",
          cls: "setting-item-description",
        });
      } else {
        foldersContainer.createEl("p", {
          text: `📁 Currently scanning: ${activeCount} specific folder(s)`,
          cls: "setting-item-description",
        });
      }
    }

    new Setting(containerEl)
      .setName("Recursive scan")
      .setDesc("Include subfolders when scanning.")
      .addToggle((tg) =>
        tg.setValue(this.plugin.settings.recursive).onChange(async (v) => {
          this.plugin.settings.recursive = v;
          await this.plugin.saveSettings();
        })
      );

    containerEl.createEl("h3", { text: "Link detection" });

    new Setting(containerEl)
      .setName("Backlink scope")
      .setDesc("Which notes to analyze for attachment references.")
      .addDropdown((dd) =>
        dd
          .addOption("zoneA-only", "Workspace only")
          .addOption("whole-vault", "Whole vault")
          .setValue(this.plugin.settings.backlinkScope)
          .onChange(async (v) => {
            this.plugin.settings.backlinkScope = v as any;
            await this.plugin.saveSettings();
          })
      );

    // Link sources with labeled toggles
    const linkSourcesSetting = new Setting(containerEl)
      .setName("Link sources")
      .setDesc("Types of links to detect: [[links]], ![[embeds]], frontmatter links.");
    
    const toggleContainer = linkSourcesSetting.controlEl.createDiv({ cls: "katt-link-toggles" });
    toggleContainer.style.cssText = "display: flex; gap: 12px; align-items: center;";

    // Links toggle with label
    const linksLabel = toggleContainer.createEl("label", { cls: "katt-toggle-label" });
    linksLabel.style.cssText = "display: flex; align-items: center; gap: 4px; font-size: var(--font-ui-small);";
    const linksToggle = linksLabel.createEl("input", { type: "checkbox" }) as HTMLInputElement;
    linksToggle.checked = this.plugin.settings.linkSources.links;
    linksToggle.classList.add("checkbox-container");
    linksLabel.createSpan({ text: "Links" });
    linksToggle.addEventListener("change", async () => {
      this.plugin.settings.linkSources.links = linksToggle.checked;
      await this.plugin.saveSettings();
    });

    // Embeds toggle with label
    const embedsLabel = toggleContainer.createEl("label", { cls: "katt-toggle-label" });
    embedsLabel.style.cssText = "display: flex; align-items: center; gap: 4px; font-size: var(--font-ui-small);";
    const embedsToggle = embedsLabel.createEl("input", { type: "checkbox" }) as HTMLInputElement;
    embedsToggle.checked = this.plugin.settings.linkSources.embeds;
    embedsLabel.createSpan({ text: "Embeds" });
    embedsToggle.addEventListener("change", async () => {
      this.plugin.settings.linkSources.embeds = embedsToggle.checked;
      await this.plugin.saveSettings();
    });

    // Frontmatter toggle with label
    const fmLabel = toggleContainer.createEl("label", { cls: "katt-toggle-label" });
    fmLabel.style.cssText = "display: flex; align-items: center; gap: 4px; font-size: var(--font-ui-small);";
    const fmToggle = fmLabel.createEl("input", { type: "checkbox" }) as HTMLInputElement;
    fmToggle.checked = this.plugin.settings.linkSources.frontmatter;
    fmLabel.createSpan({ text: "Frontmatter" });
    fmToggle.addEventListener("change", async () => {
      this.plugin.settings.linkSources.frontmatter = fmToggle.checked;
      await this.plugin.saveSettings();
    });

    containerEl.createEl("h3", { text: "Placement policy" });

    new Setting(containerEl)
      .setName("Placement mode")
      .setDesc("Where to move attachments when organizing.")
      .addDropdown((dd) =>
        dd
          .addOption("vault-folder", "Vault root")
          .addOption("specified-folder", "Specified folder")
          .addOption("same-folder-as-note", "Same folder as note")
          .addOption("subfolder-under-note", "Subfolder under note")
          .setValue(this.plugin.settings.placement.mode)
          .onChange(async (v) => {
            this.plugin.settings.placement.mode = v as any;
            await this.plugin.saveSettings();
            this.display();
          })
      );

    if (this.plugin.settings.placement.mode === "specified-folder") {
      new Setting(containerEl)
        .setName("Specified folder")
        .setDesc("All attachments will be moved to this folder.")
        .addText((t) =>
          t
            .setPlaceholder("e.g. attachments")
            .setValue(this.plugin.settings.placement.specifiedFolder)
            .onChange(async (v) => {
              this.plugin.settings.placement.specifiedFolder = v.trim();
              await this.plugin.saveSettings();
            })
        );
    }

    if (this.plugin.settings.placement.mode === "subfolder-under-note") {
      new Setting(containerEl)
        .setName("Subfolder name")
        .setDesc("Attachments go to note-folder/[subfolder-name]/.")
        .addText((t) =>
          t
            .setPlaceholder("attachments")
            .setValue(this.plugin.settings.placement.subfolderName)
            .onChange(async (v) => {
              this.plugin.settings.placement.subfolderName = v.trim();
              await this.plugin.saveSettings();
            })
        );
    }

    containerEl.createEl("h3", { text: "Conflict handling" });

    new Setting(containerEl)
      .setName("Multi-backlink policy")
      .setDesc("How to handle attachments referenced by multiple notes.")
      .addDropdown((dd) =>
        dd
          .addOption("unchanged", "Keep in place")
          .addOption("lca", "Move to common ancestor folder")
          .addOption("pick-first", "Move to first note's folder")
          .setValue(this.plugin.settings.multiBacklinkPolicy)
          .onChange(async (v) => {
            this.plugin.settings.multiBacklinkPolicy = v as any;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Global name check")
      .setDesc("Prevent moves that would create duplicate filenames in vault.")
      .addDropdown((dd) =>
        dd
          .addOption("off", "Off")
          .addOption("on-ignore-explicit", "On (allow explicit paths)")
          .addOption("on-even-explicit", "On (strict)")
          .setValue(this.plugin.settings.globalNameCheck)
          .onChange(async (v) => {
            this.plugin.settings.globalNameCheck = v as any;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Plan External attachments")
      .setDesc("Include referenced files outside Workspace/Staging in the plan.")
      .addToggle((tg) =>
        tg.setValue(this.plugin.settings.planOutAttachments).onChange(async (v) => {
          this.plugin.settings.planOutAttachments = v;
          await this.plugin.saveSettings();
        })
      );

    containerEl.createEl("h3", { text: "Attachment detection" });

    new Setting(containerEl)
      .setName("Attachment rules")
      .setDesc("Regex patterns (one per line) to identify .md files as attachments. Files matching these are treated as attachments, not notes. Example: \\.excalidraw\\.md$ matches Excalidraw files.")
      .addTextArea((ta) => {
        ta.inputEl.rows = 4;
        ta.inputEl.style.fontFamily = "var(--font-monospace)";
        ta.setValue(this.plugin.settings.attachmentRulesText);
        ta.onChange(async (v) => {
          this.plugin.settings.attachmentRulesText = v;
          await this.plugin.saveSettings();
        });
      });
    
    containerEl.createEl("p", {
      text: "Built-in: .excalidraw.md, .canvas.md are always treated as attachments.",
      cls: "setting-item-description",
    });

    containerEl.createEl("h3", { text: "View options" });

    new Setting(containerEl)
      .setName("Show stats")
      .setDesc("Display scan statistics (notes, attachments, conflicts, etc.) in the Organizer view. Reopen the view for changes to take effect.")
      .addToggle((tg) =>
        tg.setValue(this.plugin.settings.showStats).onChange(async (v) => {
          this.plugin.settings.showStats = v;
          await this.plugin.saveSettings();
        })
      );
  }
}

/** ===== Confirmation Modal =====
 * Reason: Batch operations (apply/undo) are destructive.
 * Users need clear confirmation before executing.
 * Shows: title, message, optional details (file list), confirm/cancel buttons.
 */
class ConfirmModal extends Modal {
  private title: string;
  private message: string;
  private details?: string;
  private callback: (result: boolean) => void;

  constructor(
    app: App,
    title: string,
    message: string,
    details: string | undefined,
    callback: (result: boolean) => void
  ) {
    super(app);
    this.title = title;
    this.message = message;
    this.details = details;
    this.callback = callback;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("katt-confirm-modal");

    contentEl.createEl("h2", { text: this.title });
    contentEl.createEl("p", { text: this.message });

    if (this.details) {
      const detailsEl = contentEl.createEl("pre", { cls: "katt-confirm-details" });
      detailsEl.setText(this.details);
      detailsEl.style.cssText = `
        background: var(--background-secondary);
        padding: 8px 12px;
        border-radius: 4px;
        font-size: var(--font-ui-small);
        max-height: 150px;
        overflow: auto;
        white-space: pre-wrap;
        word-break: break-word;
      `;
    }

    const buttonContainer = contentEl.createDiv({ cls: "katt-confirm-buttons" });
    buttonContainer.style.cssText = `
      display: flex;
      justify-content: flex-end;
      gap: 8px;
      margin-top: 16px;
    `;

    const cancelBtn = buttonContainer.createEl("button", { text: "Cancel" });
    cancelBtn.addEventListener("click", () => {
      this.callback(false);
      this.close();
    });

    const confirmBtn = buttonContainer.createEl("button", {
      text: "Confirm",
      cls: "mod-cta",
    });
    confirmBtn.addEventListener("click", () => {
      this.callback(true);
      this.close();
    });

    // Focus confirm button for quick Enter key
    confirmBtn.focus();
  }

  onClose() {
    this.contentEl.empty();
  }
}
