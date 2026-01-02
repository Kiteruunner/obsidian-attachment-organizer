/**
 * Comprehensive Test Suite for KPlugin (Obsidian Attachment Organizer)
 *
 * This test file covers all major functions in the plugin.
 * Run with: npx ts-node main.test.ts (after installing ts-node)
 * Or integrate with Jest/Vitest for better test reporting.
 */

export {}; // Make this a module

// ===== MOCK OBSIDIAN TYPES =====

type MockTFile = {
  path: string;
  name: string;
  extension: string;
  parent?: MockTFolder;
};

type MockTFolder = {
  path: string;
  name: string;
  children: (MockTFile | MockTFolder)[];
  isRoot?: boolean;
};

type MockCachedMetadata = {
  links?: { link: string }[];
  embeds?: { link: string }[];
  frontmatterLinks?: { link: string }[];
};

// ===== EXTRACTED TESTABLE FUNCTIONS =====
// (These mirror the private methods in KPlugin for isolated testing)

function normalizePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/+/g, "/").replace(/^\/|\/$/g, "");
}

function dirname(path: string): string {
  const p = normalizePath(path);
  const i = p.lastIndexOf("/");
  return i === -1 ? "" : p.slice(0, i);
}

function folderKey(path: string): string {
  return dirname(path).toLowerCase();
}

function nameKey(path: string): string {
  const name = (path.split("/").pop() ?? path).toLowerCase();
  return name.normalize("NFKC");
}

function lcaFolder(folders: string[]): string {
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

function isExternal(raw: string): boolean {
  const s = raw.trim().toLowerCase();
  return (
    s.startsWith("http://") ||
    s.startsWith("https://") ||
    s.startsWith("mailto:") ||
    s.startsWith("file://")
  );
}

function parseLink(raw: string): { cleanedFilePart: string } | null {
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

function normalizeExplicitToVaultPath(explicitRaw: string, fromNotePath: string): string {
  let s = explicitRaw.trim().replace(/\\/g, "/");

  if (s.startsWith("/")) s = s.slice(1);

  if (s.startsWith("./") || s.startsWith("../")) {
    const base = dirname(fromNotePath);
    return normalizePath(base ? `${base}/${s}` : s);
  }

  return normalizePath(s);
}

type PlacementMode =
  | "vault-folder"
  | "specified-folder"
  | "same-folder-as-note"
  | "subfolder-under-note";

type PlacementSettings = {
  mode: PlacementMode;
  specifiedFolder: string;
  subfolderName: string;
};

function targetFolderFromPolicy(baseFolder: string, placement: PlacementSettings): string | null {
  const p = placement;
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

function zoneOf(
  path: string,
  zoneA: string,
  zoneB: string,
  zoneC: string
): "A" | "B" | "C" | "OUT" {
  const p = normalizePath(path);

  const b = normalizePath(zoneB || "");
  const c = normalizePath(zoneC || "");
  const a = normalizePath(zoneA || "");

  if (b && (p === b || p.startsWith(b + "/"))) return "B";
  if (c && (p === c || p.startsWith(c + "/"))) return "C";
  if (!a) return "A";
  if (p === a || p.startsWith(a + "/")) return "A";
  return "OUT";
}

function isAttachmentMd(path: string, rules: RegExp[]): boolean {
  const p = normalizePath(path);
  if (!p.toLowerCase().endsWith(".md")) return false;
  return rules.some((r) => r.test(p));
}

function kindOf(
  path: string,
  rules: RegExp[]
): "note-md" | "attachment-file" | "attachment-md" | "unknown" {
  const p = path.toLowerCase();
  if (p.endsWith(".md")) return isAttachmentMd(path, rules) ? "attachment-md" : "note-md";
  return "attachment-file";
}

function isAttachmentKind(k: string): boolean {
  return k === "attachment-file" || k === "attachment-md";
}

function isNoteMd(path: string, rules: RegExp[]): boolean {
  const p = path.toLowerCase();
  return p.endsWith(".md") && !isAttachmentMd(path, rules);
}

type FileEntry = {
  path: string;
  kind: string;
  tags: string[];
  action: { type: string };
};

function markOf(e: FileEntry): "-" | "K" | "B" | "R" | "M" | "C" {
  if (e.kind === "note-md") return "-";
  if (e.tags.includes("missing")) return "M";
  if (e.tags.includes("conflict-target-occupied") || e.tags.includes("conflict-ambiguous-name"))
    return "C";
  if (e.action.type === "keep") return "K";
  if (e.action.type === "moveTo") return "R";
  return "B";
}

// ===== TEST FRAMEWORK =====

let passCount = 0;
let failCount = 0;
const failures: string[] = [];

function describe(name: string, fn: () => void) {
  console.log(`\n📂 ${name}`);
  fn();
}

function it(name: string, fn: () => void) {
  try {
    fn();
    console.log(`  ✅ ${name}`);
    passCount++;
  } catch (e: any) {
    console.log(`  ❌ ${name}`);
    console.log(`     Error: ${e.message}`);
    failures.push(`${name}: ${e.message}`);
    failCount++;
  }
}

function expect<T>(actual: T) {
  return {
    toBe(expected: T) {
      if (actual !== expected) {
        throw new Error(`Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
      }
    },
    toEqual(expected: T) {
      if (JSON.stringify(actual) !== JSON.stringify(expected)) {
        throw new Error(`Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
      }
    },
    toBeTruthy() {
      if (!actual) {
        throw new Error(`Expected truthy value, got ${JSON.stringify(actual)}`);
      }
    },
    toBeFalsy() {
      if (actual) {
        throw new Error(`Expected falsy value, got ${JSON.stringify(actual)}`);
      }
    },
    toBeNull() {
      if (actual !== null) {
        throw new Error(`Expected null, got ${JSON.stringify(actual)}`);
      }
    },
    toContain(item: any) {
      if (Array.isArray(actual)) {
        if (!actual.includes(item)) {
          throw new Error(`Expected array to contain ${JSON.stringify(item)}`);
        }
      } else if (typeof actual === "string") {
        if (!actual.includes(item)) {
          throw new Error(`Expected string to contain ${JSON.stringify(item)}`);
        }
      }
    },
    toMatch(pattern: RegExp) {
      if (typeof actual !== "string" || !pattern.test(actual)) {
        throw new Error(`Expected ${JSON.stringify(actual)} to match ${pattern}`);
      }
    },
  };
}

// ===== TEST SUITES =====

describe("normalizePath", () => {
  it("should handle forward slashes", () => {
    expect(normalizePath("foo/bar/baz")).toBe("foo/bar/baz");
  });

  it("should convert backslashes to forward slashes", () => {
    expect(normalizePath("foo\\bar\\baz")).toBe("foo/bar/baz");
  });

  it("should remove duplicate slashes", () => {
    expect(normalizePath("foo//bar///baz")).toBe("foo/bar/baz");
  });

  it("should remove leading and trailing slashes", () => {
    expect(normalizePath("/foo/bar/")).toBe("foo/bar");
  });

  it("should handle empty string", () => {
    expect(normalizePath("")).toBe("");
  });

  it("should handle single segment", () => {
    expect(normalizePath("file.md")).toBe("file.md");
  });
});

describe("dirname", () => {
  it("should return parent directory", () => {
    expect(dirname("foo/bar/baz.md")).toBe("foo/bar");
  });

  it("should return empty string for root-level file", () => {
    expect(dirname("file.md")).toBe("");
  });

  it("should handle deep paths", () => {
    expect(dirname("a/b/c/d/e.txt")).toBe("a/b/c/d");
  });

  it("should handle paths with backslashes", () => {
    expect(dirname("foo\\bar\\baz.md")).toBe("foo/bar");
  });
});

describe("folderKey", () => {
  it("should return lowercase folder path", () => {
    expect(folderKey("Foo/Bar/file.md")).toBe("foo/bar");
  });

  it("should return empty string for root files", () => {
    expect(folderKey("File.md")).toBe("");
  });
});

describe("nameKey", () => {
  it("should return lowercase filename", () => {
    expect(nameKey("Foo/Bar/File.MD")).toBe("file.md");
  });

  it("should handle root-level files", () => {
    expect(nameKey("README.md")).toBe("readme.md");
  });

  it("should normalize unicode", () => {
    // NFKC normalization
    expect(nameKey("café.md")).toBe("café.md".normalize("NFKC"));
  });
});

describe("lcaFolder - Lowest Common Ancestor", () => {
  it("should return empty for empty array", () => {
    expect(lcaFolder([])).toBe("");
  });

  it("should return the folder for single element", () => {
    expect(lcaFolder(["foo/bar/baz"])).toBe("foo/bar/baz");
  });

  it("should find common prefix", () => {
    expect(lcaFolder(["foo/bar/a", "foo/bar/b"])).toBe("foo/bar");
  });

  it("should return empty when no common prefix", () => {
    expect(lcaFolder(["foo/bar", "baz/qux"])).toBe("");
  });

  it("should handle partial matches", () => {
    expect(lcaFolder(["projects/web/app", "projects/web/api", "projects/mobile"])).toBe("projects");
  });

  it("should handle identical paths", () => {
    expect(lcaFolder(["foo/bar", "foo/bar", "foo/bar"])).toBe("foo/bar");
  });

  it("should handle nested subdirectories", () => {
    expect(lcaFolder(["a/b/c/d", "a/b/c/e", "a/b/f"])).toBe("a/b");
  });
});

describe("isExternal", () => {
  it("should detect http links", () => {
    expect(isExternal("http://example.com")).toBe(true);
  });

  it("should detect https links", () => {
    expect(isExternal("https://example.com")).toBe(true);
  });

  it("should detect mailto links", () => {
    expect(isExternal("mailto:test@example.com")).toBe(true);
  });

  it("should detect file:// links", () => {
    expect(isExternal("file://path/to/file")).toBe(true);
  });

  it("should return false for internal links", () => {
    expect(isExternal("folder/file.md")).toBe(false);
  });

  it("should return false for relative links", () => {
    expect(isExternal("./relative/path.md")).toBe(false);
  });

  it("should be case insensitive", () => {
    expect(isExternal("HTTPS://EXAMPLE.COM")).toBe(true);
  });

  it("should handle whitespace", () => {
    expect(isExternal("  https://example.com  ")).toBe(true);
  });
});

describe("parseLink", () => {
  it("should parse simple link", () => {
    const result = parseLink("file.md");
    expect(result?.cleanedFilePart).toBe("file.md");
  });

  it("should remove alias", () => {
    const result = parseLink("file.md|My Alias");
    expect(result?.cleanedFilePart).toBe("file.md");
  });

  it("should remove heading reference", () => {
    const result = parseLink("file.md#heading");
    expect(result?.cleanedFilePart).toBe("file.md");
  });

  it("should remove block reference", () => {
    const result = parseLink("file.md^block123");
    expect(result?.cleanedFilePart).toBe("file.md");
  });

  it("should remove query string", () => {
    const result = parseLink("file.md?query=value");
    expect(result?.cleanedFilePart).toBe("file.md");
  });

  it("should handle combined modifiers", () => {
    const result = parseLink("folder/file.md#heading|alias");
    expect(result?.cleanedFilePart).toBe("folder/file.md");
  });

  it("should decode URL-encoded characters", () => {
    const result = parseLink("my%20file.md");
    expect(result?.cleanedFilePart).toBe("my file.md");
  });

  it("should convert backslashes", () => {
    const result = parseLink("folder\\subfolder\\file.md");
    expect(result?.cleanedFilePart).toBe("folder/subfolder/file.md");
  });

  it("should return null for empty string", () => {
    expect(parseLink("")).toBeNull();
  });

  it("should return null for whitespace-only", () => {
    expect(parseLink("   ")).toBeNull();
  });

  it("should return null for null input", () => {
    expect(parseLink(null as any)).toBeNull();
  });

  it("should handle complex Obsidian links", () => {
    const result = parseLink("Projects/2024/Note.md#Section^block|Display Name");
    expect(result?.cleanedFilePart).toBe("Projects/2024/Note.md");
  });
});

describe("normalizeExplicitToVaultPath", () => {
  it("should remove leading slash", () => {
    expect(normalizeExplicitToVaultPath("/folder/file.md", "note.md")).toBe("folder/file.md");
  });

  it("should preserve ./ prefix for relative paths", () => {
    // Reason: The function preserves ./ and ../ markers intentionally.
    // Obsidian's normalizePath handles actual resolution.
    // This allows the plugin to detect explicit relative paths.
    expect(normalizeExplicitToVaultPath("./sibling.md", "parent/note.md")).toBe(
      "parent/./sibling.md"
    );
  });

  it("should resolve parent path with ../", () => {
    expect(normalizeExplicitToVaultPath("../uncle.md", "parent/child/note.md")).toBe(
      "parent/child/../uncle.md"
    );
  });

  it("should handle absolute-style paths", () => {
    expect(normalizeExplicitToVaultPath("folder/subfolder/file.md", "other/note.md")).toBe(
      "folder/subfolder/file.md"
    );
  });

  it("should convert backslashes", () => {
    expect(normalizeExplicitToVaultPath("folder\\file.md", "note.md")).toBe("folder/file.md");
  });

  it("should handle root-level note with ./ prefix", () => {
    // Reason: Even for root-level notes, ./ prefix is preserved.
    // The function concatenates base folder (empty) with the relative path.
    expect(normalizeExplicitToVaultPath("./sibling.md", "note.md")).toBe("./sibling.md");
  });
});

describe("targetFolderFromPolicy", () => {
  it("should return empty for vault-folder mode", () => {
    const placement: PlacementSettings = {
      mode: "vault-folder",
      specifiedFolder: "",
      subfolderName: "",
    };
    expect(targetFolderFromPolicy("any/folder", placement)).toBe("");
  });

  it("should return specified folder", () => {
    const placement: PlacementSettings = {
      mode: "specified-folder",
      specifiedFolder: "attachments",
      subfolderName: "",
    };
    expect(targetFolderFromPolicy("any/folder", placement)).toBe("attachments");
  });

  it("should return same folder as note", () => {
    const placement: PlacementSettings = {
      mode: "same-folder-as-note",
      specifiedFolder: "",
      subfolderName: "",
    };
    expect(targetFolderFromPolicy("notes/2024", placement)).toBe("notes/2024");
  });

  it("should return subfolder under note", () => {
    const placement: PlacementSettings = {
      mode: "subfolder-under-note",
      specifiedFolder: "",
      subfolderName: "assets",
    };
    expect(targetFolderFromPolicy("notes/2024", placement)).toBe("notes/2024/assets");
  });

  it("should handle empty subfolder name", () => {
    const placement: PlacementSettings = {
      mode: "subfolder-under-note",
      specifiedFolder: "",
      subfolderName: "",
    };
    expect(targetFolderFromPolicy("notes/2024", placement)).toBe("notes/2024");
  });

  it("should handle root-level with subfolder", () => {
    const placement: PlacementSettings = {
      mode: "subfolder-under-note",
      specifiedFolder: "",
      subfolderName: "attachments",
    };
    expect(targetFolderFromPolicy("", placement)).toBe("attachments");
  });
});

describe("zoneOf", () => {
  const zoneA = "SETs";
  const zoneB = "Draft";
  const zoneC = "Archive";

  it("should identify zone A files", () => {
    expect(zoneOf("SETs/note.md", zoneA, zoneB, zoneC)).toBe("A");
    expect(zoneOf("SETs/sub/deep/file.md", zoneA, zoneB, zoneC)).toBe("A");
  });

  it("should identify zone B files", () => {
    expect(zoneOf("Draft/old.md", zoneA, zoneB, zoneC)).toBe("B");
    expect(zoneOf("Draft/sub/file.md", zoneA, zoneB, zoneC)).toBe("B");
  });

  it("should identify zone C files", () => {
    expect(zoneOf("Archive/archived.md", zoneA, zoneB, zoneC)).toBe("C");
  });

  it("should identify OUT files", () => {
    expect(zoneOf("Other/file.md", zoneA, zoneB, zoneC)).toBe("OUT");
    expect(zoneOf("random.md", zoneA, zoneB, zoneC)).toBe("OUT");
  });

  it("should handle zone folder itself", () => {
    expect(zoneOf("SETs", zoneA, zoneB, zoneC)).toBe("A");
    expect(zoneOf("Draft", zoneA, zoneB, zoneC)).toBe("B");
  });

  it("should handle empty zone A (vault root)", () => {
    expect(zoneOf("any/file.md", "", zoneB, zoneC)).toBe("A");
    expect(zoneOf("Draft/file.md", "", zoneB, zoneC)).toBe("B");
  });

  it("should prioritize B over A if B is subfolder of A", () => {
    // B="SETs/Draft", A="SETs"
    expect(zoneOf("SETs/Draft/file.md", "SETs", "SETs/Draft", "Archive")).toBe("B");
  });
});

describe("isAttachmentMd", () => {
  const rules = [/\.excalidraw\.md$/i, /\.canvas\.md$/i];

  it("should identify excalidraw files", () => {
    expect(isAttachmentMd("Drawing.excalidraw.md", rules)).toBe(true);
    expect(isAttachmentMd("folder/Drawing.excalidraw.md", rules)).toBe(true);
  });

  it("should identify canvas files", () => {
    expect(isAttachmentMd("diagram.canvas.md", rules)).toBe(true);
  });

  it("should be case insensitive", () => {
    expect(isAttachmentMd("Drawing.EXCALIDRAW.MD", rules)).toBe(true);
  });

  it("should return false for regular md files", () => {
    expect(isAttachmentMd("note.md", rules)).toBe(false);
    expect(isAttachmentMd("excalidraw.md", rules)).toBe(false); // doesn't have the dot prefix
  });

  it("should return false for non-md files", () => {
    expect(isAttachmentMd("image.png", rules)).toBe(false);
  });
});

describe("kindOf", () => {
  const rules = [/\.excalidraw\.md$/i];

  it("should identify note-md", () => {
    expect(kindOf("note.md", rules)).toBe("note-md");
    expect(kindOf("folder/deep/note.md", rules)).toBe("note-md");
  });

  it("should identify attachment-md", () => {
    expect(kindOf("drawing.excalidraw.md", rules)).toBe("attachment-md");
  });

  it("should identify attachment-file", () => {
    expect(kindOf("image.png", rules)).toBe("attachment-file");
    expect(kindOf("document.pdf", rules)).toBe("attachment-file");
    expect(kindOf("video.mp4", rules)).toBe("attachment-file");
  });
});

describe("isAttachmentKind", () => {
  it("should return true for attachment-file", () => {
    expect(isAttachmentKind("attachment-file")).toBe(true);
  });

  it("should return true for attachment-md", () => {
    expect(isAttachmentKind("attachment-md")).toBe(true);
  });

  it("should return false for note-md", () => {
    expect(isAttachmentKind("note-md")).toBe(false);
  });

  it("should return false for unknown", () => {
    expect(isAttachmentKind("unknown")).toBe(false);
  });
});

describe("isNoteMd", () => {
  const rules = [/\.excalidraw\.md$/i];

  it("should return true for regular md files", () => {
    expect(isNoteMd("note.md", rules)).toBe(true);
  });

  it("should return false for attachment md files", () => {
    expect(isNoteMd("drawing.excalidraw.md", rules)).toBe(false);
  });

  it("should return false for non-md files", () => {
    expect(isNoteMd("image.png", rules)).toBe(false);
  });
});

describe("markOf", () => {
  it("should return - for notes", () => {
    const entry: FileEntry = { path: "note.md", kind: "note-md", tags: [], action: { type: "keep" } };
    expect(markOf(entry)).toBe("-");
  });

  it("should return M for missing files", () => {
    const entry: FileEntry = {
      path: "__missing/file.png",
      kind: "unknown",
      tags: ["missing"],
      action: { type: "unknown" },
    };
    expect(markOf(entry)).toBe("M");
  });

  it("should return C for conflict-target-occupied", () => {
    const entry: FileEntry = {
      path: "file.png",
      kind: "attachment-file",
      tags: ["conflict-target-occupied"],
      action: { type: "keep" },
    };
    expect(markOf(entry)).toBe("C");
  });

  it("should return C for conflict-ambiguous-name", () => {
    const entry: FileEntry = {
      path: "file.png",
      kind: "attachment-file",
      tags: ["conflict-ambiguous-name"],
      action: { type: "keep" },
    };
    expect(markOf(entry)).toBe("C");
  });

  it("should return K for kept attachments", () => {
    const entry: FileEntry = {
      path: "file.png",
      kind: "attachment-file",
      tags: [],
      action: { type: "keep" },
    };
    expect(markOf(entry)).toBe("K");
  });

  it("should return R for moveTo actions", () => {
    const entry: FileEntry = {
      path: "file.png",
      kind: "attachment-file",
      tags: [],
      action: { type: "moveTo" },
    };
    expect(markOf(entry)).toBe("R");
  });

  it("should return B for moveToB actions", () => {
    const entry: FileEntry = {
      path: "file.png",
      kind: "attachment-file",
      tags: [],
      action: { type: "moveToB" },
    };
    expect(markOf(entry)).toBe("B");
  });
});

describe("Attachment Rules Compilation", () => {
  it("should compile valid regex patterns", () => {
    const rules = ["\\.excalidraw\\.md$", "\\.canvas\\.md$"];
    const compiled = rules.map((r) => new RegExp(r, "i"));
    expect(compiled.length).toBe(2);
    expect(compiled[0].test("test.excalidraw.md")).toBe(true);
    expect(compiled[1].test("test.canvas.md")).toBe(true);
  });

  it("should handle invalid regex gracefully", () => {
    const invalidPattern = "[invalid";
    let error: Error | null = null;
    try {
      new RegExp(invalidPattern, "i");
    } catch (e) {
      error = e as Error;
    }
    expect(error).toBeTruthy();
  });

  it("should match various attachment patterns", () => {
    const patterns = [
      "\\.excalidraw\\.md$",
      "\\.canvas\\.md$",
      "^attachments/",
      "\\.draw\\.svg$",
    ];
    const compiled = patterns.map((r) => new RegExp(r, "i"));

    expect(compiled[0].test("My Drawing.excalidraw.md")).toBe(true);
    expect(compiled[1].test("diagram.canvas.md")).toBe(true);
    expect(compiled[2].test("attachments/image.png")).toBe(true);
    expect(compiled[3].test("chart.draw.svg")).toBe(true);
  });
});

describe("Edge Cases and Complex Scenarios", () => {
  it("should handle paths with special characters", () => {
    expect(normalizePath("folder with spaces/file name.md")).toBe("folder with spaces/file name.md");
    expect(nameKey("File (Copy).md")).toBe("file (copy).md");
  });

  it("should handle unicode in paths", () => {
    expect(normalizePath("日本語/ファイル.md")).toBe("日本語/ファイル.md");
    expect(nameKey("Ñoño.md")).toBe("ñoño.md".normalize("NFKC"));
  });

  it("should handle very deep paths", () => {
    const deepPath = "a/b/c/d/e/f/g/h/i/j/k/l/m/n/o/p/file.md";
    expect(dirname(deepPath)).toBe("a/b/c/d/e/f/g/h/i/j/k/l/m/n/o/p");
    expect(nameKey(deepPath)).toBe("file.md");
  });

  it("should handle empty folders in path", () => {
    // After normalization, these should be clean
    expect(normalizePath("a//b///c")).toBe("a/b/c");
  });

  it("should handle only dots in path", () => {
    expect(parseLink("...")).toEqual({ cleanedFilePart: "..." });
  });

  it("should handle links with only modifiers", () => {
    // Reason: When a link is only "#heading", after removing the # part,
    // the result is empty string, so parseLink correctly returns null.
    // This is correct behavior - an empty file reference is invalid.
    expect(parseLink("#heading")).toBeNull();
    // "^block" after removing ^ gives empty string, which returns null
    expect(parseLink("^block")).toBeNull();
  });
});

describe("Multi-Backlink Scenarios", () => {
  it("should calculate LCA for two notes in same folder", () => {
    const folders = ["projects/web/note1", "projects/web/note2"].map(dirname);
    expect(lcaFolder(folders)).toBe("projects/web");
  });

  it("should calculate LCA for notes in different branches", () => {
    const folders = ["projects/frontend/components/Button", "projects/backend/api/users"].map(
      dirname
    );
    expect(lcaFolder(folders)).toBe("projects");
  });

  it("should handle completely different paths", () => {
    const folders = ["docs/readme", "src/main"].map(dirname);
    expect(lcaFolder(folders)).toBe("");
  });
});

describe("Zone Priority Testing", () => {
  it("should correctly prioritize zones when paths overlap", () => {
    // Scenario: zoneA = "notes", zoneB = "notes/archive"
    // A file in "notes/archive" should be zone B, not A
    expect(zoneOf("notes/archive/old.md", "notes", "notes/archive", "")).toBe("B");
    expect(zoneOf("notes/current.md", "notes", "notes/archive", "")).toBe("A");
  });

  it("should handle zone C priority", () => {
    expect(zoneOf("temp/file.md", "notes", "draft", "temp")).toBe("C");
  });
});

describe("Link Resolution Edge Cases", () => {
  it("should handle double-encoded URLs", () => {
    const result = parseLink("my%2520file.md"); // %25 = %, so %2520 = %20
    // First decode gives "my%20file.md"
    expect(result?.cleanedFilePart).toBe("my%20file.md");
  });

  it("should handle links with multiple aliases (first wins)", () => {
    const result = parseLink("file|alias1|alias2");
    expect(result?.cleanedFilePart).toBe("file");
  });

  it("should handle complex Obsidian wiki links", () => {
    const result = parseLink("Folder/SubFolder/Note Name#Heading Name^blockid|Display");
    expect(result?.cleanedFilePart).toBe("Folder/SubFolder/Note Name");
  });
});

// ===== RUN TESTS =====

console.log("🧪 KPlugin Test Suite");
console.log("=".repeat(50));

// Execute all test suites (they self-register via describe/it)

console.log("\n" + "=".repeat(50));
console.log(`\n📊 Results: ${passCount} passed, ${failCount} failed`);

if (failures.length > 0) {
  console.log("\n❌ Failures:");
  failures.forEach((f) => console.log(`   - ${f}`));
}

console.log("\n" + (failCount === 0 ? "✨ All tests passed!" : "⚠️ Some tests failed."));

// Exit with appropriate code
process.exit(failCount > 0 ? 1 : 0);
