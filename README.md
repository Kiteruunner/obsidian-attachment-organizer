# Obsidian Attachment Organizer

An Obsidian plugin to automatically organize attachments using zone-based rules.

## Features

- **Zone-based organization**: Define zones (A, B, C, OUT) with different folders
- **Automatic detection**: Scans vault to find orphaned or misplaced attachments
- **Preview mode**: See where files will move before applying changes
- **Mark filter**: Filter view by mark type (-, K, B, R, M, C)
- **Undo support**: Revert last batch operation
- **Conflict detection**: Identifies naming conflicts and missing references

## Mark Types

| Mark | Meaning | Action |
|------|---------|--------|
| `-` | Note (markdown) | No action |
| `K` | Keep | File stays in place |
| `B` | To Bin | Move to Zone B (cleanup folder) |
| `R` | Relocate | Move to proper location |
| `M` | Missing | Referenced but file not found |
| `C` | Conflict | Naming conflict detected |

## Installation

1. Copy `main.js`, `styles.css`, `manifest.json` to your vault's `.obsidian/plugins/k-plugin/` folder
2. Enable the plugin in Obsidian settings

## Development

```bash
# Install dependencies
npm install

# Build for production
npm run build

# Watch mode for development
npm run dev
```

## Project Structure

```
k-plugin/
├── src/
│   ├── main.ts          # Plugin entry point
│   ├── attach-view.ts   # Sidebar view component
│   └── main.test.ts     # Tests
├── styles.css           # Plugin styles
├── manifest.json        # Plugin metadata
└── package.json         # Node dependencies
```

## License

MIT
