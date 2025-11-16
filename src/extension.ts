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

const DECLARATION_REGEX = /create\s+(or\s+replace\s+)?(function|procedure)\b/i;
const DECLARE_REGEX = /\bDECLARE\b/i;
const BEGIN_REGEX = /\bBEGIN\b/i;
const END_REGEX = /\bend\s*;/i;
const WORD_RANGE_REGEX = /"[^"]+"|[a-zA-Z0-9_:\.]+/;

// Balanced-parenthesis extractor and declaration parser helpers
function extractBalancedParentheses(text: string, openIndex: number): { content: string; endIndex: number } | null {
  let i = openIndex;
  if (text[i] !== '(') return null;

  let depth = 0;
  let inSingleQuote = false;
  let inDoubleQuote = false;
  let inLineComment = false;
  let inBlockComment = false;

  i++; // start after '('
  const start = i;
  for (; i < text.length; i++) {
    const ch = text[i];
    const prev = text[i - 1];

    if (inLineComment) {
      if (ch === '\n') inLineComment = false;
      continue;
    }
    if (inBlockComment) {
      if (prev === '*' && ch === '/') inBlockComment = false;
      continue;
    }

    if (!inSingleQuote && !inDoubleQuote) {
      if (ch === '-' && text[i + 1] === '-') {
        inLineComment = true;
        i++;
        continue;
      }
      if (ch === '/' && text[i + 1] === '*') {
        inBlockComment = true;
        i++;
        continue;
      }
    }

    if (ch === "'" && !inDoubleQuote) {
      inSingleQuote = !inSingleQuote;
      continue;
    }
    if (ch === '"' && !inSingleQuote) {
      inDoubleQuote = !inDoubleQuote;
      continue;
    }

    if (inSingleQuote || inDoubleQuote) continue;

    if (ch === '(') depth++;
    else if (ch === ')') {
      if (depth === 0) {
        const content = text.substring(start, i);
        return { content, endIndex: i };
      }
      depth--;
    }
  }

  return null;
}

interface DeclarationInfo {
  nameRaw: string;
  name: string;
  isFunction: boolean;
  params: string;
  startIndex: number;
  endIndex: number;
}

function parseDeclarationsFromText(text: string): DeclarationInfo[] {
  const results: DeclarationInfo[] = [];
  const regex = /create\s+(or\s+replace\s+)?(function|procedure)\b/ig;
  let m: RegExpExecArray | null;
  while ((m = regex.exec(text)) !== null) {
    const declType = (m[2] || '').toLowerCase();
    const after = regex.lastIndex;
    // skip whitespace
    let i = after;
    while (i < text.length && /\s/.test(text[i])) i++;

    // parse name (could be quoted or schema.qualified)
    if (i >= text.length) continue;
    let nameRaw = '';
    if (text[i] === '"') {
      // quoted identifier
      let j = i + 1;
      while (j < text.length) {
        if (text[j] === '"') {
          // allow escaped quotes by doubling
          if (text[j + 1] === '"') {
            j += 2;
            continue;
          }
          j++;
          break;
        }
        j++;
      }
      nameRaw = text.substring(i, j);
      i = j;
    } else {
      let j = i;
      while (j < text.length && /[a-zA-Z0-9_:\.\$]/.test(text[j])) j++;
      nameRaw = text.substring(i, j);
      i = j;
    }

    // find first '(' after name
    const parenIndex = text.indexOf('(', i);
    if (parenIndex === -1) continue;
    const balanced = extractBalancedParentheses(text, parenIndex);
    if (!balanced) continue;

    const endIndex = balanced.endIndex;
    const params = balanced.content;
    const normalized = nameRaw.startsWith('"') ? nameRaw.replace(/^"|"$/g, '') : nameRaw;

    results.push({ nameRaw, name: normalized, isFunction: declType === 'function', params, startIndex: m.index, endIndex });

    // advance regex position
    regex.lastIndex = endIndex;
  }
  return results;
}

function splitParameters(paramText: string): string[] {
  const params: string[] = [];
  let current = '';
  let inSingle = false;
  let inDouble = false;
  let inLineComment = false;
  let inBlockComment = false;
  let depth = 0;

  for (let i = 0; i < paramText.length; i++) {
    const ch = paramText[i];
    const prev = paramText[i - 1];

    if (inLineComment) {
      current += ch;
      if (ch === '\n') inLineComment = false;
      continue;
    }
    if (inBlockComment) {
      current += ch;
      if (prev === '*' && ch === '/') inBlockComment = false;
      continue;
    }

    if (!inSingle && !inDouble) {
      if (ch === '-' && paramText[i + 1] === '-') {
        inLineComment = true;
        current += ch;
        continue;
      }
      if (ch === '/' && paramText[i + 1] === '*') {
        inBlockComment = true;
        current += ch;
        continue;
      }
    }

    if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
      current += ch;
      continue;
    }
    if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
      current += ch;
      continue;
    }

    if (inSingle || inDouble) {
      current += ch;
      continue;
    }

    if (ch === '(') {
      depth++;
      current += ch;
      continue;
    }
    if (ch === ')') {
      if (depth > 0) depth--;
      current += ch;
      continue;
    }

    if (ch === ',' && depth === 0) {
      params.push(current.trim());
      current = '';
      continue;
    }

    current += ch;
  }

  if (current.trim().length > 0) params.push(current.trim());
  return params;
}

class PostgresSignatureHelpProvider implements vscode.SignatureHelpProvider {
  public async provideSignatureHelp(
    document: vscode.TextDocument,
    position: vscode.Position,
    _token: vscode.CancellationToken,
    _context: vscode.SignatureHelpContext
  ): Promise<vscode.SignatureHelp | null> {
    const text = document.getText();
    const offset = document.offsetAt(position);

    // find nearest '(' before cursor
    const before = text.substring(0, offset);
    const parenIdx = before.lastIndexOf('(');
    if (parenIdx === -1) return null;

    // find function name before paren
    let i = parenIdx - 1;
    while (i >= 0 && /\s/.test(before[i])) i--;
    if (i < 0) return null;

    // collect name token (could be quoted or qualified)
    let nameEnd = i + 1;
    let nameStart = i;
    if (before[nameStart] === '"') {
      // find matching opening quote
      nameStart = before.lastIndexOf('"', nameStart - 1);
      if (nameStart === -1) return null;
    } else {
      while (nameStart >= 0 && /[a-zA-Z0-9_:\.\"]/.test(before[nameStart])) nameStart--;
      nameStart++;
    }

    const rawName = before.substring(nameStart, nameEnd).trim();
    const name = normalizeIdentifier(rawName);

    // compute parameter text from paren to cursor
    const paramsText = before.substring(parenIdx + 1);

    // count comma-separated params at top level
    const paramParts = splitParameters(paramsText);
    const activeParameter = Math.max(0, paramParts.length - 1);

    // find declaration in current document or workspace
    let info: { isFunction: boolean; parameters: string; description: string } | null = null;
    const localDecls = parseDeclarationsFromText(text);
    const foundLocal = localDecls.find(d => d.name.toLowerCase() === name.toLowerCase());
    if (foundLocal) info = { isFunction: foundLocal.isFunction, parameters: foundLocal.params, description: '' };

    if (!info) {
      const sqlFiles = await vscode.workspace.findFiles("**/*.{sql,SQL}");
      for (const uri of sqlFiles) {
        try {
          const doc = await vscode.workspace.openTextDocument(uri);
          const decls = parseDeclarationsFromText(doc.getText());
          const f = decls.find(d => d.name.toLowerCase() === name.toLowerCase());
          if (f) {
            info = { isFunction: f.isFunction, parameters: f.params, description: '' };
            break;
          }
        } catch (e) { }
      }
    }

    if (!info) return null;

    const paramList = splitParameters(info.parameters || '');
    const sigLabel = `${name}(${paramList.join(', ')})`;
    const sig = new vscode.SignatureInformation(sigLabel, info.description || '');
    sig.parameters = paramList.map(p => new vscode.ParameterInformation(p));

    const help = new vscode.SignatureHelp();
    help.signatures = [sig];
    help.activeSignature = 0;
    help.activeParameter = Math.min(activeParameter, paramList.length - 1 >= 0 ? paramList.length - 1 : 0);
    return help;
  }
}

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
    // try to get word/token at position; handle quoted identifiers
    const wordRange = document.getWordRangeAtPosition(position, WORD_RANGE_REGEX);
    if (!wordRange) return null;

    return {
      word: document.getText(wordRange),
      range: wordRange
    };
  }
}

function normalizeIdentifier(id: string): string {
  if (!id) return id;
  id = id.trim();
  if (id.startsWith('"') && id.endsWith('"')) {
    // remove outer quotes and unescape doubled quotes
    return id.slice(1, -1).replace(/""/g, '"');
  }
  return id;
}

class PostgresDocumentSymbolProvider implements vscode.DocumentSymbolProvider {
  provideDocumentSymbols(
    document: vscode.TextDocument,
    _token: vscode.CancellationToken
  ): vscode.ProviderResult<vscode.DocumentSymbol[]> {
    const symbols: vscode.DocumentSymbol[] = [];
    const text = document.getText();
    const decls = parseDeclarationsFromText(text);
    for (const d of decls) {
      const start = document.positionAt(d.startIndex);
      const end = document.positionAt(d.endIndex);
      // find name position inside the declaration region
      const declText = text.substring(d.startIndex, d.endIndex + 1);
      const nameIdx = declText.indexOf(d.nameRaw);
      const nameStart = nameIdx >= 0 ? document.positionAt(d.startIndex + nameIdx) : start;
      const nameEnd = nameStart ? new vscode.Position(nameStart.line, nameStart.character + d.name.length) : nameStart;
      const symbol = new vscode.DocumentSymbol(
        d.name,
        "",
        vscode.SymbolKind.Function,
        new vscode.Range(start, end),
        new vscode.Range(nameStart, nameEnd)
      );
      symbols.push(symbol);
    }

    return symbols;
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
    const decls = parseDeclarationsFromText(fullText);
    const name = normalizeIdentifier(wordName);
    const found = decls.find(d => d.name.toLowerCase() === name.toLowerCase());
    if (!found) return null;

    const isFunction = found.isFunction;
    const parameters = found.params.trim();

    // try to find COMMENT ON ...
    const commentRegex = new RegExp(
      `comment\\s+on\\s+(function|procedure)\\s+${escapeRegex(found.nameRaw)}\\s*(?:\\([^)]*?\\))?\\s+is\\s+['\"]([^'\"]+)['\"]`,
      "i"
    );
    const commentMatch = fullText.match(commentRegex);
    const description = commentMatch ? commentMatch[2] : "Brak opisu";

    const markdownContent = new vscode.MarkdownString();
    markdownContent.appendMarkdown(`**${isFunction ? "Function" : "Procedure"}**: \`${found.name}\`\n\n`);

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
    const decls = parseDeclarationsFromText(fullText);
    const name = normalizeIdentifier(wordName);
    const found = decls.find(d => d.name.toLowerCase() === name.toLowerCase());
    if (!found) return null;

    // locate nameRaw position within declaration
    const declText = fullText.substring(found.startIndex, found.endIndex + 1);
    const relIdx = declText.indexOf(found.nameRaw);
    const absIdx = relIdx >= 0 ? found.startIndex + relIdx : found.startIndex;
    const startPos = document.positionAt(absIdx);
    const endPos = document.positionAt(absIdx + (found.nameRaw.length));

    return new vscode.Location(document.uri, new vscode.Range(startPos, endPos));
  }
}

class PostgresReferenceProvider extends BasePostgresProvider implements vscode.ReferenceProvider {
  async provideReferences(
    document: vscode.TextDocument,
    position: vscode.Position,
    _context: vscode.ReferenceContext,
    _token: vscode.CancellationToken
  ): Promise<vscode.Location[]> {
    const extracted = this.extractWordAtPosition(document, position);
    if (!extracted) return [];

    const references: vscode.Location[] = [];

    // Szukaj w bieżącym dokumencie
    this.findReferencesInDocument(document, extracted.word, references);

    // Szukaj w innych plikach workspace i agreguj wyniki
    const sqlFiles = await vscode.workspace.findFiles("**/*.{sql,SQL}");
    for (const uri of sqlFiles) {
      try {
        const doc = await vscode.workspace.openTextDocument(uri);
        this.findReferencesInDocument(doc, extracted.word, references);
      } catch (e) {
        // ignore
      }
    }

    return references;
  }

  private findReferencesInDocument(document: vscode.TextDocument, wordName: string, references: vscode.Location[]): void {
    const fullText = document.getText();
    const name = normalizeIdentifier(wordName);
    // Match either quoted form or bare form
    const quoted = '"' + name.replace(/"/g, '""') + '"';
    const referenceRegex = new RegExp(`(${escapeRegex(quoted)}|${escapeRegex(name)})`, "gi");
    let match: RegExpExecArray | null;

    while ((match = referenceRegex.exec(fullText)) !== null) {
      const lineStart = fullText.substring(0, match.index).split("\n").length - 1;
      const lineText = document.lineAt(lineStart).text;
      // try to find the matched substring in the line (case-insensitive)
      const matchText = match[0];
      const idx = lineText.toLowerCase().indexOf(matchText.toLowerCase());
      if (idx !== -1) {
        references.push(
          new vscode.Location(
            document.uri,
            new vscode.Range(new vscode.Position(lineStart, idx), new vscode.Position(lineStart, idx + matchText.length))
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
    // make this provider async so we can search workspace files
    return (async () => {
      const wordRange = document.getWordRangeAtPosition(position, WORD_RANGE_REGEX);
      if (!wordRange) {
        return Promise.reject("Nie można zmienić nazwy w tym miejscu.");
      }

      const oldName = document.getText(wordRange);

      // Walidacja nazw
      if (!this.validateRenameNames(oldName, newName)) {
        return Promise.reject("Nowa nazwa musi być inna od starej i nie może być słowem kluczowym.");
      }

      const edit = await this.provideHeuristicRenameEdits(document, wordRange, newName, oldName);

      if (!edit) {
        return Promise.reject("Brak wyniku dla zmiany nazwy w tym miejscu.");
      }

      // ensure there is at least one change
      let any = false;
      for (const [uri, changes] of edit.entries()) {
        if (changes && changes.length > 0) {
          any = true;
          break;
        }
      }

      if (!any) {
        return Promise.reject("Brak zmian do zastosowania.");
      }

      return edit;
    })();
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

  private async provideHeuristicRenameEdits(
    document: vscode.TextDocument,
    wordRange: vscode.Range,
    newName: string,
    oldName: string
  ): Promise<vscode.WorkspaceEdit | undefined> {
    const edit = new vscode.WorkspaceEdit();

    const declStart = findDeclarationStart(document, wordRange.start.line);
    const declEnd = findDeclarationEnd(document, declStart);

    const declarationLineText = document.lineAt(declStart).text;
    const isOnDeclarationName =
      DECLARATION_REGEX.test(declarationLineText) &&
      declarationLineText.toLowerCase().includes(oldName.toLowerCase());

    // ✅ GLOBALNA ZMIANA NAZWY FUNKCJI/PROCEDURY (workspace-wide)
    if (isOnDeclarationName && wordRange.start.line === declStart) {
      return await this.applyGlobalRename(document, edit, oldName, newName);
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

  private async applyGlobalRename(
    document: vscode.TextDocument,
    edit: vscode.WorkspaceEdit,
    oldName: string,
    newName: string
  ): Promise<vscode.WorkspaceEdit | undefined> {
    const regex = new RegExp(`\\b${escapeRegex(oldName)}\\b`, "gi");

    // Przeszukaj wszystkie pliki .sql w workspace
    const sqlFiles = await vscode.workspace.findFiles("**/*.{sql,SQL}");
    for (const uri of sqlFiles) {
      try {
        const doc = await vscode.workspace.openTextDocument(uri);
        for (let line = 0; line < doc.lineCount; line++) {
          const textLine = doc.lineAt(line);
          let match: RegExpExecArray | null;
          regex.lastIndex = 0;
          while ((match = regex.exec(textLine.text))) {
            const start = new vscode.Position(line, match.index ?? 0);
            const end = new vscode.Position(line, (match.index ?? 0) + oldName.length);
            edit.replace(doc.uri, new vscode.Range(start, end), newName);
          }
        }
      } catch (e) {
        // ignoruj pliki, których nie można otworzyć
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
  // map fileUri -> declared names in that file (for incremental updates)
  private workspaceFileIndex: Map<string, string[]> = new Map();

  async initialize(context: vscode.ExtensionContext) {
    // Wstępne zapełnienie cache w tle
    this.refreshWorkspaceCache();

    const watcher = vscode.workspace.createFileSystemWatcher("**/*.{sql,SQL}");
    watcher.onDidChange((uri) => this.scheduleRefresh(uri));
    watcher.onDidCreate((uri) => this.scheduleRefresh(uri));
    watcher.onDidDelete((uri) => this.scheduleRefresh(uri));

    context.subscriptions.push(watcher);
  }

  private scheduleRefresh(uri?: vscode.Uri, delay = 500) {
    if (this.refreshTimeout) clearTimeout(this.refreshTimeout);
    this.refreshTimeout = setTimeout(() => {
      this.refreshWorkspaceCache(uri);
    }, delay);
  }

  private async refreshWorkspaceCache(uri?: vscode.Uri) {
    // if uri provided -> incremental update for that file, otherwise full refresh
    if (!uri) {
      this.cacheReady = false;
      this.workspaceNames.clear();
      this.workspaceInfo.clear();
      this.workspaceFileIndex.clear();

      const sqlFiles = await vscode.workspace.findFiles("**/*.{sql,SQL}");
      for (const f of sqlFiles) {
        await this.updateFileCache(f);
      }

      this.cacheReady = true;
      return;
    }

    // incremental: update single file
    await this.updateFileCache(uri);
    this.cacheReady = true;
  }

  private async updateFileCache(uri: vscode.Uri) {
    try {
      const doc = await vscode.workspace.openTextDocument(uri);
      const text = doc.getText();
      const decls = parseDeclarationsFromText(text);
      const names: string[] = decls.map(d => d.name);

      const key = uri.toString();
      const prev = this.workspaceFileIndex.get(key) || [];

      // remove previous names
      for (const p of prev) {
        // if name is no longer declared anywhere else, delete from sets/maps
        if (p && !this.isNameDeclaredElsewhere(p, key)) {
          this.workspaceNames.delete(p);
          this.workspaceInfo.delete(p);
        }
      }

      // add new names
      for (const n of names) {
        this.workspaceNames.add(n);
        if (!this.workspaceInfo.has(n)) {
          const info = this.findFunctionInfoInText(text, n);
          if (info) this.workspaceInfo.set(n, info);
        }
      }

      this.workspaceFileIndex.set(key, names);
    } catch (e) {
      // if file can't be opened (deleted), remove its index
      const key = uri.toString();
      const prev = this.workspaceFileIndex.get(key) || [];
      for (const p of prev) {
        if (p && !this.isNameDeclaredElsewhere(p, key)) {
          this.workspaceNames.delete(p);
          this.workspaceInfo.delete(p);
        }
      }
      this.workspaceFileIndex.delete(key);
    }
  }

  private isNameDeclaredElsewhere(name: string, excludingUri?: string): boolean {
    for (const [k, names] of this.workspaceFileIndex.entries()) {
      if (excludingUri && k === excludingUri) continue;
      if (names.includes(name)) return true;
    }
    return false;
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
    const decls = parseDeclarationsFromText(text);
    const n = normalizeIdentifier(name);
    const found = decls.find(d => d.name.toLowerCase() === n.toLowerCase());
    if (!found) return null;

    const isFunction = found.isFunction;
    const parameters = found.params || "";
    // try to find COMMENT ON ... nearby
    const commentRegex = new RegExp(
      `comment\\s+on\\s+(function|procedure)\\s+${escapeRegex(found.nameRaw)}\\s*(?:\\([^)]*?\\))?\\s+is\\s+['\"]([^'\"]+)['\"]`,
      "i"
    );
    const commentMatch = text.match(commentRegex);
    const description = commentMatch ? commentMatch[2] : "Brak opisu";

    return { isFunction, parameters: parameters.trim(), description };
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

  const signatureProvider = new PostgresSignatureHelpProvider();

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

  context.subscriptions.push(
    vscode.languages.registerSignatureHelpProvider(selector, signatureProvider, '(', ',')
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
  // Komenda: przenieś funkcję/procedurę między plikami
  const moveFunctionCommand = vscode.commands.registerCommand(
    "postgres.moveFunction",
    async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) return;

      const document = editor.document;
      const text = document.getText();

      const declRegex = /create\s+(?:or\s+replace\s+)?(function|procedure)\s+([a-zA-Z0-9_\.\"]+)\s*\(/gi;
      const entries: Array<{
        name: string;
        declLine: number;
        startLine: number;
        endLine: number;
        preview: string;
      }> = [];

      let m: RegExpExecArray | null;
      while ((m = declRegex.exec(text)) !== null) {
        const declType = (m[1] || "").toLowerCase();
        const rawName = (m[2] || "").replace(/\"/g, "");
        const declIndex = m.index;
        const declLine = text.substring(0, declIndex).split('\n').length - 1;
        const declEnd = findDeclarationEnd(document, declLine);

        // wykryj komentarz poprzedzający (linie zaczynające się od -- lub blok /* ... */)
        let commentStart = declLine;
        let line = declLine - 1;
        while (line >= 0) {
          const ltext = document.lineAt(line).text.trim();
          if (ltext.startsWith('--') || ltext === '') {
            commentStart = line;
            line--;
            continue;
          }
          if (ltext.endsWith('*/')) {
            // wpadliśmy w blokowy komentarz — znajdź początek
            let b = line;
            while (b >= 0 && !document.lineAt(b).text.includes('/*')) b--;
            commentStart = b >= 0 ? b : line;
            line = b - 1;
            break;
          }
          break;
        }

        const startPos = new vscode.Position(commentStart, 0);
        const endPos = new vscode.Position(declEnd, document.lineAt(declEnd).text.length);
        const preview = document.getText(new vscode.Range(startPos, endPos)).split('\n').slice(0, 3).map(s => s.trim()).join(' ');
        const linesCount = declEnd - commentStart + 1;

        entries.push({ name: rawName, declLine, startLine: commentStart, endLine: declEnd, preview: preview, type: declType, lines: linesCount } as any);
      }

      if (entries.length === 0) {
        vscode.window.showInformationMessage('Brak funkcji/procedur w bieżącym pliku.');
        return;
      }

      const pick = await vscode.window.showQuickPick(
        entries.map(e => {
          return `${e.name}`;
        }),
        { placeHolder: 'Wybierz funkcję/procedurę do przeniesienia' }
      );
      if (!pick) return;

      const idx = entries.findIndex(e => pick.startsWith(e.name));
      if (idx === -1) return;

      const chosen = entries[idx];
      const srcStart = new vscode.Position(chosen.startLine, 0);
      const srcEnd = new vscode.Position(chosen.endLine, document.lineAt(chosen.endLine).text.length);
      const srcRange = new vscode.Range(srcStart, srcEnd);
      let funcText = document.getText(srcRange);

      // Znajdź powiązane instrukcje COMMENT ON FUNCTION/PROCEDURE w tym samym pliku
      const commentRegex = new RegExp(`comment\\s+on\\s+(function|procedure)\\s+${escapeRegex(chosen.name)}\\s*(?:\\([^)]*?\\))?\\s+is\\s+['"][^'"]*['"]\\s*;?`, 'gi');
      const commentMatches: { range: vscode.Range; text: string }[] = [];
      let cm: RegExpExecArray | null;
      while ((cm = commentRegex.exec(text)) !== null) {
        const cStart = cm.index;
        const cEnd = commentRegex.lastIndex;
        const cStartLine = text.substring(0, cStart).split('\n').length - 1;
        const cEndLine = text.substring(0, cEnd).split('\n').length - 1;
        const cRange = new vscode.Range(new vscode.Position(cStartLine, 0), new vscode.Position(cEndLine, document.lineAt(cEndLine).text.length));
        // jeśli komentarz jest już częścią srcRange (np. poprzedzający komentarz), pomiń
        if (cRange.start.line >= srcRange.start.line && cRange.end.line <= srcRange.end.line) continue;
        const cText = text.substring(cStart, cEnd).trim();
        commentMatches.push({ range: cRange, text: cText });
      }

      // Dołącz znalezione komentarze do wstawianego tekstu (po funkcji)
      if (commentMatches.length > 0) {
        funcText = funcText + '\n\n' + commentMatches.map(c => c.text).join('\n\n');
      }

      // Wybierz plik docelowy
      const sqlFiles = await vscode.workspace.findFiles('**/*.{sql,SQL}');
      const fileItems = sqlFiles.map(u => ({ label: vscode.workspace.asRelativePath(u), uri: u }));
      fileItems.unshift({ label: 'Utwórz nowy plik...', uri: undefined as any });

      const destPickLabel = await vscode.window.showQuickPick(fileItems.map(f => f.label), { placeHolder: 'Wybierz plik docelowy' });
      if (!destPickLabel) return;

      let destUri: vscode.Uri | undefined;
      if (destPickLabel === 'Utwórz nowy plik...') {
        const filename = await vscode.window.showInputBox({ prompt: 'Ścieżka nowego pliku (relatywnie do workspace root)' });
        if (!filename) return;
        const folders = vscode.workspace.workspaceFolders;
        const base = folders && folders[0] ? folders[0].uri.fsPath : undefined;
        if (!base) {
          vscode.window.showErrorMessage('Brak otwartego workspace.');
          return;
        }
        const full = require('path').join(base, filename);
        destUri = vscode.Uri.file(full);
        try {
          await vscode.workspace.fs.writeFile(destUri, new Uint8Array());
        } catch (e) {
          // ignore
        }
      } else {
        const found = fileItems.find(f => f.label === destPickLabel);
        destUri = found ? found.uri : undefined;
      }

      if (!destUri) return;

      // If destination is same file, cancel (to avoid complex intra-file repositioning)
      if (destUri.toString() === document.uri.toString()) {
        vscode.window.showInformationMessage('Wybrano ten sam plik — wybierz inny plik docelowy.');
        return;
      }

      const destDoc = await vscode.workspace.openTextDocument(destUri);

      const edit = new vscode.WorkspaceEdit();
      // usuń fragment funkcji/procedury
      edit.delete(document.uri, srcRange);
      // usuń również znalezione instrukcje COMMENT ON
      for (const cmItem of commentMatches) {
        edit.delete(document.uri, cmItem.range);
      }

      const lastLine = Math.max(0, destDoc.lineCount - 1);
      const insertPos = new vscode.Position(lastLine, destDoc.lineAt(lastLine).text.length);
      const prefix = destDoc.getText().trim().length > 0 ? '\n\n' : '';
      edit.insert(destDoc.uri, insertPos, prefix + funcText + '\n');

      const success = await vscode.workspace.applyEdit(edit);
      if (success) {
        vscode.window.showInformationMessage('Funkcja/procedura przeniesiona.');
      } else {
        vscode.window.showErrorMessage('Nie udało się przenieść funkcji.');
      }
    }
  );

  context.subscriptions.push(moveFunctionCommand);

  // Komenda: wygeneruj szkielet funkcji/procedury
  const generateSkeletonCommand = vscode.commands.registerCommand(
    "postgres.generateSkeleton",
    async () => {
      const type = await vscode.window.showQuickPick(["function", "procedure"], { placeHolder: "Wybierz typ" });
      if (!type) return;

      const name = await vscode.window.showInputBox({ prompt: `Nazwa ${type}` });
      if (!name) return;

      const params = await vscode.window.showInputBox({ prompt: "Parametry (np. id integer, name text) - zostaw puste jeśli brak" }) || "";

      let returns = "";
      if (type === "function") {
        returns = await vscode.window.showInputBox({ prompt: "Zwracany typ (np. void, integer, TABLE(...))", value: "void" }) || "void";
      }

      const language = await vscode.window.showInputBox({ prompt: "Język (np. plpgsql)", value: "plpgsql" }) || "plpgsql";

      // Wybierz miejsce wstawienia
      const editor = vscode.window.activeTextEditor;
      let targetDoc: vscode.TextDocument | undefined = editor ? editor.document : undefined;

      if (!targetDoc) {
        const sqlFiles = await vscode.workspace.findFiles("**/*.{sql,SQL}");
        const pick = await vscode.window.showQuickPick(sqlFiles.map(u => u.fsPath), { placeHolder: "Wybierz plik docelowy" });
        if (!pick) return;
        const found = sqlFiles.find(u => u.fsPath === pick);
        if (!found) return;
        targetDoc = await vscode.workspace.openTextDocument(found);
      }

      const isFunction = type === "function";
      const paramsStr = params.trim();
      const returnsStr = isFunction ? `RETURNS ${returns}` : "";

      const skeleton = `CREATE OR REPLACE ${type.toUpperCase()} ${name}(${paramsStr})\n${returnsStr}\nLANGUAGE ${language}\nAS $$\nBEGIN\n  -- TODO: implement\n  RETURN${isFunction ? " NULL;" : ";"}\nEXCEPTION WHEN OTHERS THEN\n  -- handle\n  RAISE;\nEND;\n$$;\n`;

      const edit = new vscode.WorkspaceEdit();
      const uri = targetDoc.uri;
      const insertPos = editor && editor.document.uri.toString() === uri.toString()
        ? editor.selection.active
        : new vscode.Position(Math.max(0, targetDoc.lineCount - 1), targetDoc.lineAt(Math.max(0, targetDoc.lineCount - 1)).text.length);

      edit.insert(uri, insertPos, `\n${skeleton}\n`);
      const ok = await vscode.workspace.applyEdit(edit);
      if (ok) {
        vscode.window.showInformationMessage(`${type} skeleton inserted.`);
      } else {
        vscode.window.showErrorMessage("Nie udało się wstawić szkieletów.");
      }
    }
  );

  context.subscriptions.push(generateSkeletonCommand);
};

export const deactivate = () => { };
