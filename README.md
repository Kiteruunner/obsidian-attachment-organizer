# Obsidian Attachment Organizer

Automatically organize attachments into zone-based folders with conflict detection and batch operations.

## Features

- **Zone-based organization** — Define Workspace, Staging, and Extra Scan zones to categorize your vault
- **Smart detection** — Analyzes backlinks to find orphaned, misplaced, or missing attachments
- **Preview mode** — See exactly where files will move before applying changes
- **Batch operations** — Move multiple files at once with one click
- **Undo support** — Safely revert the last batch operation
- **Conflict detection** — Identifies duplicate filenames and target conflicts before they happen
- **Flexible placement** — Choose where attachments go: same folder as note, subfolder, or specified location

## How It Works

The plugin scans your vault and classifies each attachment based on its location and references:

| Mark | Status | Meaning |
|:----:|--------|---------|
| `-` | Note | Markdown note (not an attachment) |
| `K` | Keep | Already in the correct location |
| `B` | Staging | Orphan — move to Staging folder |
| `R` | Relocate | Move to proper location near its referencing note |
| `M` | Missing | Referenced in a note but file doesn't exist |
| `C` | Conflict | Can't move due to naming conflict |

## Installation

### From GitHub Release (Recommended)

1. Go to [Releases](https://github.com/Kiteruunner/obsidian-attachment-organizer/releases)
2. Download `main.js`, `manifest.json`, and `styles.css` from the latest release
3. Create folder: `<your-vault>/.obsidian/plugins/attachment-organizer/`
4. Copy the downloaded files into that folder
5. Reload Obsidian and enable the plugin in Settings → Community plugins

### Manual Build

```bash
git clone https://github.com/Kiteruunner/obsidian-attachment-organizer.git
cd obsidian-attachment-organizer
npm install
npm run build
```

Copy `main.js`, `manifest.json`, and `styles.css` to your vault's plugin folder.

## Usage

1. Open the **Organizer** view from the command palette (`Ctrl/Cmd + P` → "Open Organizer") or the ribbon icon
2. Review the file tree — each attachment shows its current status mark
3. Use the filter buttons to focus on specific mark types (B, R, M, C)
4. Toggle **Preview** to see where files will move
5. Click **Apply** to execute planned moves
6. If needed, click **Undo** to revert

## Settings

### Zones

| Setting | Description |
|---------|-------------|
| **Workspace folder** | Main folder to organize (empty = vault root) |
| **Staging folder** | Where orphan attachments are moved |
| **Enable Extra Scan** | Scan additional folders outside Workspace/Staging |
| **Extra Scan folders** | Specific folders to scan, or leave empty for whole vault |

### Link Detection

| Setting | Description |
|---------|-------------|
| **Backlink scope** | Which notes to analyze: Workspace only or Whole vault |
| **Link sources** | Types of links to detect: `[[links]]`, `![[embeds]]`, frontmatter |

### Placement Policy

| Setting | Description |
|---------|-------------|
| **Placement mode** | Where attachments go: Vault root, Specified folder, Same folder as note, or Subfolder under note |
| **Subfolder name** | Name of subfolder when using "Subfolder under note" mode |

### Conflict Handling

| Setting | Description |
|---------|-------------|
| **Multi-backlink policy** | How to handle attachments referenced by multiple notes |
| **Global name check** | Prevent moves that would create duplicate filenames |
| **Plan External attachments** | Include files outside Workspace/Staging in the plan |

### Attachment Detection

| Setting | Description |
|---------|-------------|
| **Attachment rules** | Regex patterns to identify `.md` files as attachments (e.g., Excalidraw) |
| **Show stats** | Display scan statistics in the Organizer view |

## Tips

- **Excalidraw & Canvas files** are automatically treated as attachments (built-in rules)
- Use **Preview mode** before applying to verify the plan
- Files marked `C` (Conflict) won't be moved — resolve duplicates manually first
- The **Undo** feature only works for the last operation, so review carefully before applying

## License

[MIT](LICENSE)

## Author

**Kirun** — [GitHub](https://github.com/Kiteruunner)
