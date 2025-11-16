import * as vscode from "vscode";

// ============================================================================
// STAŁE
// ============================================================================
const POSTGRES_KEYWORDS: string[] = [
  "all", "analyse", "analyze", "and", "any", "array", "as", "asc", "asymmetric", "both",
  "case", "cast", "check", "collate", "column", "constraint", "create", "current_catalog",
  "current_date", "current_role", "current_time", "current_timestamp", "current_user",
  "default", "deferrable", "desc", "distinct", "do", "else", "end", "except", "false",
  "fetch", "for", "foreign", "from", "grant", "group", "having", "in", "initially", "intersect",
  "into", "lateral", "leading", "limit", "localtime", "localtimestamp", "not", "null", "offset",
  "on", "only", "or", "order", "placing", "primary", "references", "returning", "select",
  "session_user", "some", "symmetric", "system_user", "table", "then", "to", "trailing",
  "true", "union", "unique", "user", "using", "variadic", "when", "where", "window", "with",
  "abort", "add", "after", "alter", "before", "begin", "call", "cascade", "close", "copy",
  "cursor", "database", "declare", "delete", "detach", "domain", "drop", "execute", "explain",
  "filter", "function", "if", "index", "insert", "into", "language", "listen", "lock",
  "notify", "over", "partition", "prepare", "procedure", "raise", "return", "returns",
  "revoke", "schema", "security", "sequence", "set", "sql", "table", "trigger", "type",
  "update", "values", "view", "volatile", "while", "work", "xml", "year",
  "begin", "declare", "end", "loop", "while", "exit", "continue", "perform", "exception",
  "plpgsql", "found", "row", "record", "sql", "immutable", "stable", "definer", "invoker",
];

const FUNCTION_REGEX = /create\s+(or\s+replace\s+)?function\s+([a-zA-Z0-9_\.]+)\s*\(/i;
const PROCEDURE_REGEX = /create\s+(or\s+replace\s+)?procedure\s+([a-zA-Z0-9_\.]+)\s*\(/i;
const DECLARATION_REGEX = /create\s+(or\s+replace\s+)?(function|procedure)\b/i;
const DECLARE_REGEX = /\bDECLARE\b/i;
const BEGIN_REGEX = /\bBEGIN\b/i;
const END_REGEX = /\bend\s*;/i;
const WORD_RANGE_REGEX = /[a-zA-Z0-9_\.]+/;

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================
function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isPostgresKeyword(word: string): boolean {
  return POSTGRES_KEYWORDS.includes(word.toLowerCase());
}

function findDeclarationStart(document: vscode.TextDocument, line: number): number {
  for (let currentLine = line; currentLine >= 0; currentLine--) {
    if (DECLARATION_REGEX.test(document.lineAt(currentLine).text)) {
      return currentLine;
    }
  }
  return line;
}

function findDeclarationEnd(document: vscode.TextDocument, line: number): number {
  const lastLine = document.lineCount - 1;
  for (let currentLine = line; currentLine <= lastLine; currentLine++) {
    if (END_REGEX.test(document.lineAt(currentLine).text)) {
      return currentLine;
    }
  }
  for (let currentLine = line; currentLine <= lastLine; currentLine++) {
    if (document.lineAt(currentLine).text.includes(";")) {
      return currentLine;
    }
  }
  return lastLine;
}

// ============================================================================
// BASE PROVIDER CLASS
// ============================================================================
abstract class BasePostgresProvider {
  protected async findInWorkspace<T>(
    callback: (document: vscode.TextDocument) => T | null
  ): Promise<T | null> {
    const sqlFiles = await vscode.workspace.findFiles("**/*.{sql,SQL}");

    for (const fileUri of sqlFiles) {
      const document = await vscode.workspace.openTextDocument(fileUri);
      const result = callback(document);
      if (result) {
        return result;
      }
    }

    return null;
  }

  protected extractWordAtPosition(
    document: vscode.TextDocument,
    position: vscode.Position
  ): { word: string; range: vscode.Range } | null {
    const wordRange = document.getWordRangeAtPosition(position, WORD_RANGE_REGEX);
    if (!wordRange) return null;

    return {
      word: document.getText(wordRange),
      range: wordRange
    };
  }
}

class PostgresDocumentSymbolProvider implements vscode.DocumentSymbolProvider {
  provideDocumentSymbols(
    document: vscode.TextDocument,
    _token: vscode.CancellationToken
  ): vscode.ProviderResult<vscode.DocumentSymbol[]> {
    const symbols: vscode.DocumentSymbol[] = [];

    for (let line = 0; line < document.lineCount; line++) {
      const text = document.lineAt(line).text;
      const symbol = this.extractSymbolFromLine(text, line);
      if (symbol) {
        symbols.push(symbol);
      }
    }

    return symbols;
  }

  private extractSymbolFromLine(text: string, line: number): vscode.DocumentSymbol | null {
    const functionMatch = text.match(FUNCTION_REGEX);
    const procedureMatch = text.match(PROCEDURE_REGEX);
    const match = functionMatch || procedureMatch;

    if (!match) return null;

    const name = match[2];
    const range = new vscode.Range(
      new vscode.Position(line, match.index ?? 0),
      new vscode.Position(line, text.length)
    );
    const selectionRange = new vscode.Range(
      new vscode.Position(line, (match.index ?? 0) + match[0].lastIndexOf(name)),
      new vscode.Position(line, (match.index ?? 0) + match[0].lastIndexOf(name) + name.length)
    );

    return new vscode.DocumentSymbol(
      name,
      "",
      vscode.SymbolKind.Function,
      range,
      selectionRange
    );
  }
}

class PostgresHoverProvider extends BasePostgresProvider implements vscode.HoverProvider {
  async provideHover(
    document: vscode.TextDocument,
    position: vscode.Position,
    _token: vscode.CancellationToken
  ): Promise<vscode.Hover | null> {
    const extracted = this.extractWordAtPosition(document, position);
    if (!extracted) return null;

    // Szukaj w bieżącym dokumencie
    const hover = this.findHoverInDocument(document, extracted.word);
    if (hover) {
      return hover;
    }

    // Szukaj w innych plikach workspace
    return await this.findInWorkspace(doc => this.findHoverInDocument(doc, extracted.word));
  }

  private findHoverInDocument(document: vscode.TextDocument, wordName: string): vscode.Hover | null {
    const fullText = document.getText();
    const functionRegex = new RegExp(
      `create\\s+(or\\s+replace\\s+)?(function|procedure)\\s+${escapeRegex(wordName)}\\s*\\(([^)]*?)\\)`,
      "i"
    );
    const functionMatch = fullText.match(functionRegex);

    if (!functionMatch) return null;

    const isFunction = functionMatch[2].toLowerCase() === "function";
    const parameters = functionMatch[3].trim();

    const commentRegex = new RegExp(
      `comment\\s+on\\s+(function|procedure)\\s+${escapeRegex(wordName)}\\s*(?:\\([^)]*?\\))?\\s+is\\s+['"]([^'"]+)['"]`,
      "i"
    );
    const commentMatch = fullText.match(commentRegex);
    const description = commentMatch ? commentMatch[2] : "Brak opisu";

    const markdownContent = new vscode.MarkdownString();
    markdownContent.appendMarkdown(`**${isFunction ? "Function" : "Procedure"}**: \`${wordName}\`\n\n`);

    if (parameters) {
      markdownContent.appendMarkdown("**Parameters:**\n```sql\n");
      markdownContent.appendMarkdown(parameters);
      markdownContent.appendMarkdown("\n```\n\n");
    }

    markdownContent.appendMarkdown(`**Description:**\n${description}`);

    return new vscode.Hover(markdownContent);
  }
}

class PostgresDefinitionProvider extends BasePostgresProvider implements vscode.DefinitionProvider {
  provideDefinition(
    document: vscode.TextDocument,
    position: vscode.Position,
    _token: vscode.CancellationToken
  ): vscode.ProviderResult<vscode.Definition> {
    const extracted = this.extractWordAtPosition(document, position);
    if (!extracted) return null;

    // Szukaj w bieżącym dokumencie
    const localDefinition = this.findDefinitionInDocument(document, extracted.word);
    if (localDefinition) {
      return localDefinition;
    }

    // Szukaj w innych plikach workspace
    return this.findInWorkspace(doc => this.findDefinitionInDocument(doc, extracted.word));
  }

  private findDefinitionInDocument(document: vscode.TextDocument, wordName: string): vscode.Location | null {
    const fullText = document.getText();
    const functionRegex = new RegExp(
      `create\\s+(or\\s+replace\\s+)?(function|procedure)\\s+${escapeRegex(wordName)}\\s*\\(`,
      "gi"
    );

    const match = functionRegex.exec(fullText);
    if (!match) return null;

    const lineStart = fullText.substring(0, match.index).split("\n").length - 1;
    const lineText = document.lineAt(lineStart).text;
    const nameStart = lineText.toLowerCase().indexOf(wordName.toLowerCase());

    if (nameStart === -1) return null;

    return new vscode.Location(
      document.uri,
      new vscode.Range(
        new vscode.Position(lineStart, nameStart),
        new vscode.Position(lineStart, nameStart + wordName.length)
      )
    );
  }
}

class PostgresReferenceProvider extends BasePostgresProvider implements vscode.ReferenceProvider {
  provideReferences(
    document: vscode.TextDocument,
    position: vscode.Position,
    _context: vscode.ReferenceContext,
    _token: vscode.CancellationToken
  ): vscode.ProviderResult<vscode.Location[]> {
    const extracted = this.extractWordAtPosition(document, position);
    if (!extracted) return [];

    const references: vscode.Location[] = [];

    // Szukaj w bieżącym dokumencie
    this.findReferencesInDocument(document, extracted.word, references);

    // Szukaj w innych plikach workspace asynchronicznie
    this.findInWorkspace(doc => {
      const refs: vscode.Location[] = [];
      this.findReferencesInDocument(doc, extracted.word, refs);
      return refs.length > 0 ? refs : null;
    });

    return references;
  }

  private findReferencesInDocument(document: vscode.TextDocument, wordName: string, references: vscode.Location[]): void {
    const fullText = document.getText();
    const referenceRegex = new RegExp(`\\b${escapeRegex(wordName)}\\b`, "gi");
    let match: RegExpExecArray | null;

    while ((match = referenceRegex.exec(fullText)) !== null) {
      const lineStart = fullText.substring(0, match.index).split("\n").length - 1;
      const lineText = document.lineAt(lineStart).text;
      const charStart = lineText.toLowerCase().indexOf(wordName.toLowerCase());

      if (charStart !== -1) {
        references.push(
          new vscode.Location(
            document.uri,
            new vscode.Range(
              new vscode.Position(lineStart, charStart),
              new vscode.Position(lineStart, charStart + wordName.length)
            )
          )
        );
      }
    }
  }
}

class PostgresRenameProvider implements vscode.RenameProvider {
  prepareRename(
    document: vscode.TextDocument,
    position: vscode.Position,
    _token: vscode.CancellationToken
  ): vscode.ProviderResult<vscode.Range | { range: vscode.Range; placeholder: string }> {
    const wordRange = document.getWordRangeAtPosition(position, WORD_RANGE_REGEX);
    if (!wordRange) {
      return Promise.reject("Nie można zmienić nazwy w tym miejscu.");
    }

    const word = document.getText(wordRange);
    if (isPostgresKeyword(word)) {
      return Promise.reject("Nie można zmieniać nazw słów kluczowych Postgresa.");
    }

    return { range: wordRange, placeholder: word };
  }

  provideRenameEdits(
    document: vscode.TextDocument,
    position: vscode.Position,
    newName: string,
    _token: vscode.CancellationToken
  ): vscode.ProviderResult<vscode.WorkspaceEdit> {
    const wordRange = document.getWordRangeAtPosition(position, WORD_RANGE_REGEX);
    if (!wordRange) {
      return Promise.reject("Nie można zmienić nazwy w tym miejscu.");
    }

    const oldName = document.getText(wordRange);

    // Walidacja nazw
    if (!this.validateRenameNames(oldName, newName)) {
      return Promise.reject("Nowa nazwa musi być inna od starej i nie może być słowem kluczowym.");
    }

    const edit = this.provideHeuristicRenameEdits(document, wordRange, newName, oldName);

    if (!edit) {
      return Promise.reject("Brak wyniku dla zmiany nazwy w tym miejscu.");
    }

    const changes = edit.get(document.uri);
    if (!changes || changes.length === 0) {
      return Promise.reject("Brak zmian do zastosowania.");
    }

    return edit;
  }

  private validateRenameNames(oldName: string, newName: string): boolean {
    if (isPostgresKeyword(oldName)) {
      return false;
    }
    if (isPostgresKeyword(newName)) {
      return false;
    }
    if (!newName || newName === oldName) {
      return false;
    }
    return true;
  }

  private provideHeuristicRenameEdits(
    document: vscode.TextDocument,
    wordRange: vscode.Range,
    newName: string,
    oldName: string
  ): vscode.WorkspaceEdit | undefined {
    const edit = new vscode.WorkspaceEdit();

    const declStart = findDeclarationStart(document, wordRange.start.line);
    const declEnd = findDeclarationEnd(document, declStart);

    const declarationLineText = document.lineAt(declStart).text;
    const isOnDeclarationName =
      DECLARATION_REGEX.test(declarationLineText) &&
      declarationLineText.toLowerCase().includes(oldName.toLowerCase());

    // ✅ GLOBALNA ZMIANA NAZWY FUNKCJI/PROCEDURY
    if (isOnDeclarationName && wordRange.start.line === declStart) {
      return this.applyGlobalRename(document, edit, oldName, newName);
    }

    // ✅ LOKALNY REFACTOR PARAMETRÓW/ZMIENNYCH
    const isInParams = this.isInParameterRange(document, declStart, declEnd, wordRange.start);
    const isInDeclare = this.isInDeclareRange(document, declStart, declEnd, wordRange.start);

    if (isInParams || isInDeclare) {
      return this.applyLocalRename(document, edit, declStart, declEnd, oldName, newName);
    }

    // Jeśli w ciele funkcji
    const isInFunctionBody = wordRange.start.line > declStart && wordRange.start.line < declEnd;
    if (isInFunctionBody) {
      return this.applyLocalRename(document, edit, declStart, declEnd, oldName, newName);
    }

    return undefined;
  }

  private applyGlobalRename(
    document: vscode.TextDocument,
    edit: vscode.WorkspaceEdit,
    oldName: string,
    newName: string
  ): vscode.WorkspaceEdit | undefined {
    const regex = new RegExp(`\\b${escapeRegex(oldName)}\\b`, "gi");

    for (let line = 0; line < document.lineCount; line++) {
      const textLine = document.lineAt(line);
      let match: RegExpExecArray | null;
      regex.lastIndex = 0;

      while ((match = regex.exec(textLine.text))) {
        const start = new vscode.Position(line, match.index ?? 0);
        const end = new vscode.Position(line, (match.index ?? 0) + oldName.length);
        edit.replace(document.uri, new vscode.Range(start, end), newName);
      }
    }

    return edit.size > 0 ? edit : undefined;
  }

  private applyLocalRename(
    document: vscode.TextDocument,
    edit: vscode.WorkspaceEdit,
    declStart: number,
    declEnd: number,
    oldName: string,
    newName: string
  ): vscode.WorkspaceEdit | undefined {
    const bodyRegex = new RegExp(`\\b${escapeRegex(oldName)}\\b`, "g");

    for (let line = declStart; line <= declEnd; line++) {
      const textLine = document.lineAt(line);
      let match: RegExpExecArray | null;
      bodyRegex.lastIndex = 0;

      while ((match = bodyRegex.exec(textLine.text))) {
        const start = new vscode.Position(line, match.index ?? 0);
        const end = new vscode.Position(line, (match.index ?? 0) + oldName.length);
        edit.replace(document.uri, new vscode.Range(start, end), newName);
      }
    }

    return edit.size > 0 ? edit : undefined;
  }

  private isInDeclareRange(
    document: vscode.TextDocument,
    declStart: number,
    declEnd: number,
    position: vscode.Position
  ): boolean {
    let declareLineStart = -1;
    let declareLineEnd = -1;

    for (let line = declStart; line <= declEnd; line++) {
      const text = document.lineAt(line).text;
      if (DECLARE_REGEX.test(text)) {
        declareLineStart = line;
        for (let endLine = line + 1; endLine <= declEnd; endLine++) {
          if (BEGIN_REGEX.test(document.lineAt(endLine).text)) {
            declareLineEnd = endLine;
            break;
          }
        }
        break;
      }
    }

    if (declareLineStart === -1) return false;
    return position.line >= declareLineStart && position.line <= declareLineEnd;
  }

  private isInParameterRange(
    document: vscode.TextDocument,
    declStart: number,
    declEnd: number,
    position: vscode.Position
  ): boolean {
    let openPos: vscode.Position | null = null;

    for (let line = declStart; line <= declEnd; line++) {
      const text = document.lineAt(line).text;
      const idx = text.indexOf("(");
      if (idx !== -1) {
        openPos = new vscode.Position(line, idx);
        break;
      }
    }

    if (!openPos) return false;

    let depth = 0;
    let closePos: vscode.Position | null = null;

    for (let line = openPos.line; line <= declEnd; line++) {
      const text = document.lineAt(line).text;
      const startCol = line === openPos.line ? openPos.character : 0;

      for (let col = startCol; col < text.length; col++) {
        const ch = text[col];
        if (ch === "(") depth++;
        if (ch === ")") {
          depth--;
          if (depth === 0) {
            closePos = new vscode.Position(line, col);
            break;
          }
        }
      }
      if (closePos) break;
    }

    if (!closePos) return false;

    if (openPos.line === closePos.line) {
      return position.line === openPos.line &&
        position.character > openPos.character &&
        position.character < closePos.character;
    }

    if (position.line > openPos.line && position.line < closePos.line) {
      return true;
    }

    if (position.line === openPos.line) {
      return position.character > openPos.character;
    }

    if (position.line === closePos.line) {
      return position.character < closePos.character;
    }

    return false;
  }
}

class PostgresCompletionProvider extends BasePostgresProvider implements vscode.CompletionItemProvider {
  private workspaceNames: Set<string> = new Set();
  private workspaceInfo: Map<string, { isFunction: boolean; parameters: string; description: string }> = new Map();
  private cacheReady: boolean = false;
  private refreshTimeout: any = undefined;

  async initialize(context: vscode.ExtensionContext) {
    // Wstępne zapełnienie cache w tle
    this.refreshWorkspaceCache();

    const watcher = vscode.workspace.createFileSystemWatcher("**/*.{sql,SQL}");
    const schedule = () => this.scheduleRefresh();
    watcher.onDidChange(schedule);
    watcher.onDidCreate(schedule);
    watcher.onDidDelete(schedule);

    context.subscriptions.push(watcher);
  }

  private scheduleRefresh(delay = 500) {
    if (this.refreshTimeout) clearTimeout(this.refreshTimeout);
    this.refreshTimeout = setTimeout(() => {
      this.refreshWorkspaceCache();
    }, delay);
  }

  private async refreshWorkspaceCache() {
    this.cacheReady = false;
    this.workspaceNames.clear();
    this.workspaceInfo.clear();

    const sqlFiles = await vscode.workspace.findFiles("**/*.{sql,SQL}");
    for (const uri of sqlFiles) {
      try {
        const doc = await vscode.workspace.openTextDocument(uri);
        const text = doc.getText();
        const regex = /create\s+(?:or\s+replace\s+)?(?:function|procedure)\s+([a-zA-Z0-9_\.\"]+)\s*\(/gi;
        let m: RegExpExecArray | null;
        while ((m = regex.exec(text)) !== null) {
          const raw = m[1].replace(/\\"/g, "");
          this.workspaceNames.add(raw);
          if (!this.workspaceInfo.has(raw)) {
            const info = this.findFunctionInfoInText(text, raw);
            if (info) this.workspaceInfo.set(raw, info);
          }
        }
      } catch (e) {
        // ignoruj
      }
    }

    this.cacheReady = true;
  }

  async provideCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position,
    _token: vscode.CancellationToken,
    _context: vscode.CompletionContext
  ): Promise<vscode.CompletionItem[] | vscode.CompletionList | null> {
    const items: vscode.CompletionItem[] = [];

    // Dodaj słowa kluczowe Postgresa
    for (const kw of POSTGRES_KEYWORDS) {
      const item = new vscode.CompletionItem(kw.toUpperCase(), vscode.CompletionItemKind.Keyword);
      item.detail = "Postgres keyword";
      items.push(item);
    }

    // Wyciągnij nazwy funkcji/procedur z bieżącego dokumentu
    const docText = document.getText();
    const nameRegex = /create\s+(?:or\s+replace\s+)?(?:function|procedure)\s+([a-zA-Z0-9_\.\"]+)\s*\(/gi;
    const names = new Set<string>();
    let m: RegExpExecArray | null;
    while ((m = nameRegex.exec(docText)) !== null) {
      names.add(m[1].replace(/\"/g, ""));
    }

    // Dodatkowo użyj cache workspace (szybkie). Jeśli cache niegotowe,
    // uruchom odświeżenie w tle, ale nie czekaj na nie.
    if (this.cacheReady) {
      for (const n of this.workspaceNames) names.add(n);
    } else {
      // uruchom tło
      this.refreshWorkspaceCache();
    }

    for (const n of names) {
      const item = new vscode.CompletionItem(n, vscode.CompletionItemKind.Function);
      item.detail = "Function/Procedure (Postgres)";

      // Dołącz dokumentację (parametry + opis) jeśli dostępna
      try {
        const info = await this.getFunctionInfo(n, document);
        if (info) {
          const md = new vscode.MarkdownString();
          md.appendMarkdown(`**${info.isFunction ? "Function" : "Procedure"}**: \`${n}\`\n\n`);
          if (info.parameters && info.parameters.trim().length > 0) {
            md.appendMarkdown("**Parameters:**\n```sql\n");
            md.appendMarkdown(info.parameters.trim());
            md.appendMarkdown("\n```\n\n");
          }
          md.appendMarkdown(`**Description:**\n${info.description || "Brak opisu"}`);
          item.documentation = md;
        }
      } catch (e) {
        // ignore
      }

      items.push(item);
    }

    return items;
  }

  // findAllFunctionProcedureNamesInWorkspace pozostawione dla kompatybilności,
  // ale preferowane jest użycie cache (workspaceNames/workspaceInfo).
  private async findAllFunctionProcedureNamesInWorkspace(): Promise<Set<string>> {
    if (this.cacheReady) return new Set(this.workspaceNames);
    const result = new Set<string>();
    const sqlFiles = await vscode.workspace.findFiles("**/*.{sql,SQL}");
    for (const uri of sqlFiles) {
      try {
        const doc = await vscode.workspace.openTextDocument(uri);
        const text = doc.getText();
        const regex = /create\s+(?:or\s+replace\s+)?(?:function|procedure)\s+([a-zA-Z0-9_\.\"]+)\s*\(/gi;
        let m: RegExpExecArray | null;
        while ((m = regex.exec(text)) !== null) {
          result.add(m[1].replace(/\\"/g, ""));
        }
      } catch (e) {
        // ignoruj pliki, których nie można otworzyć
      }
    }
    return result;
  }

  private async getFunctionInfo(name: string, document: vscode.TextDocument): Promise<{ isFunction: boolean; parameters: string; description: string } | null> {
    // Najpierw spróbuj w bieżącym dokumencie
    const inDoc = this.findFunctionInfoInText(document.getText(), name);
    if (inDoc) return inDoc;
    // Jeśli mamy cache, użyj go (szybkie)
    if (this.cacheReady && this.workspaceInfo.has(name)) {
      return this.workspaceInfo.get(name) || null;
    }

    // W przeciwnym razie spróbuj wyszukać w workspace (wolniejsze)
    const found = await this.findInWorkspace((doc) => {
      const info = this.findFunctionInfoInText(doc.getText(), name);
      return info ? info : null;
    });

    return found as { isFunction: boolean; parameters: string; description: string } | null;
  }

  private findFunctionInfoInText(text: string, name: string): { isFunction: boolean; parameters: string; description: string } | null {
    const functionRegex = new RegExp(
      `create\\s+(or\\s+replace\\s+)?(function|procedure)\\s+${escapeRegex(name)}\\s*\\(([^)]*?)\\)`,
      "i"
    );

    const functionMatch = text.match(functionRegex);
    if (!functionMatch) return null;

    const isFunction = functionMatch[2].toLowerCase() === "function";
    const parameters = (functionMatch[3] || "").trim();

    const commentRegex = new RegExp(
      `comment\\s+on\\s+(function|procedure)\\s+${escapeRegex(name)}\\s*(?:\\([^)]*?\\))?\\s+is\\s+['"]([^'"]+)['"]`,
      "i"
    );
    const commentMatch = text.match(commentRegex);
    const description = commentMatch ? commentMatch[2] : "Brak opisu";

    return { isFunction, parameters, description };
  }
}

export const activate = (context: vscode.ExtensionContext) => {
  const symbolProvider = new PostgresDocumentSymbolProvider();
  const hoverProvider = new PostgresHoverProvider();
  const definitionProvider = new PostgresDefinitionProvider();
  const referenceProvider = new PostgresReferenceProvider();
  const renameProvider = new PostgresRenameProvider();
  const completionProvider = new PostgresCompletionProvider();
  // Inicjalizuj cache i watcher plików dla szybkich podpowiedzi
  completionProvider.initialize(context);

  const selector: vscode.DocumentSelector = [
    { language: "sql" }
  ];

  context.subscriptions.push(
    vscode.languages.registerDocumentSymbolProvider(selector, symbolProvider),
    vscode.languages.registerHoverProvider(selector, hoverProvider),
    vscode.languages.registerDefinitionProvider(selector, definitionProvider),
    vscode.languages.registerReferenceProvider(selector, referenceProvider),
    vscode.languages.registerRenameProvider(selector, renameProvider)
    ,
    vscode.languages.registerCompletionItemProvider(selector, completionProvider)
  );

  const showFunctionsCommand = vscode.commands.registerCommand(
    "postgres.showFunctions",
    async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) return;

      const document = editor.document;
      const symbols = await symbolProvider.provideDocumentSymbols(
        document,
        new vscode.CancellationTokenSource().token
      );

      if (!symbols || !Array.isArray(symbols) || symbols.length === 0) {
        vscode.window.showInformationMessage("Brak funkcji/procedur w pliku.");
        return;
      }

      const pick = await vscode.window.showQuickPick(
        symbols.map((s) => ({
          label: s.name,
          detail: s.detail || undefined,
          symbol: s
        })),
        { placeHolder: "Wybierz funkcję lub procedurę" }
      );

      if (!pick) return;

      const { symbol } = pick;
      const range = (symbol as vscode.DocumentSymbol).range;
      editor.selection = new vscode.Selection(range.start, range.start);
      editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
    }
  );

  context.subscriptions.push(showFunctionsCommand);
};

export const deactivate = () => { };
