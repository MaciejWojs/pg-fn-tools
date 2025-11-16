# Postgres Function Toolkit

> A small VS Code extension that improves editing, navigation and refactoring of PostgreSQL functions and procedures (PL/pgSQL). It provides document symbols, hover documentation, go-to-definition, references, rename support, completion and signature help for functions/procedures declared in .sql files in your workspace.

## Features

- Document symbols: lists declared functions and procedures in SQL files for easy navigation.
- Hover: shows signature and description (from `COMMENT ON` if present) for functions/procedures.
- Go to Definition: jump to the declaration of a function/procedure found in workspace SQL files.
- Find References: find references (quoted or unquoted) across workspace SQL files.
- Rename support: heuristic rename either local (inside a function body/params) or workspace-wide for function/procedure names.
- Completion: SQL completion includes Postgres keywords and discovered functions/procedures (with parameter preview and description).
- Signature Help: function signature hints while typing argument lists.
- Commands:
  - `Postgres: Show functions/procedures in file` — quickly jump to a function/procedure symbol in the current file.
  - `Postgres: Move function/procedure between files` — move the selected function/procedure (and related `COMMENT ON` statements) to another SQL file or a new file.
  - `Postgres: Generate function/procedure skeleton` — create a boilerplate `CREATE OR REPLACE` function or procedure skeleton.

This extension analyzes SQL files in the workspace (`**/*.{sql,SQL}`) to provide the above features.

## Quick Start

1. Open your Postgres SQL project folder in VS Code.
2. Install/Load the extension (if packaged). For development, open the folder in VS Code and run the extension with the Extension Host (F5).
3. Open or create `.sql` files containing `CREATE FUNCTION` / `CREATE PROCEDURE` declarations — the extension will detect them and enable features.

## Implementation Notes

- The extension parses `CREATE [OR REPLACE] FUNCTION|PROCEDURE` declarations to extract names and parameter lists. It uses a conservative parser that handles quoted identifiers and basic nesting.
- Documentation extraction uses `COMMENT ON FUNCTION/PROCEDURE <name> IS '...'` patterns when available.
- Completion provider maintains a lightweight workspace cache (file watcher) for fast suggestions.

## Contributing

Contributions are welcome. Suggested areas for improvement:

- Improve SQL parsing coverage for edge cases and different stylistic formats.
- Add unit tests for the parser and providers.
- Add multi-language support or configurable settings for languages and file patterns.

To contribute, fork the repository, make your changes and open a pull request.

## License

This project uses the license in `LICENSE.txt` (see repository root).
