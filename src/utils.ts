import * as vscode from 'vscode';

export const POSTGRES_KEYWORDS: string[] = [
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

export const DECLARATION_REGEX = /create\s+(or\s+replace\s+)?(function|procedure)\b/i;
export const DECLARE_REGEX = /\bDECLARE\b/i;
export const BEGIN_REGEX = /\bBEGIN\b/i;
export const END_REGEX = /\bend\s*;/i;
export const WORD_RANGE_REGEX = /"[^"]+"|[a-zA-Z0-9_:\.]+/;

export function extractBalancedParentheses(text: string, openIndex: number): { content: string; endIndex: number } | null {
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

export interface DeclarationInfo {
    nameRaw: string;
    name: string;
    isFunction: boolean;
    params: string;
    startIndex: number;
    endIndex: number;
}

export function parseDeclarationsFromText(text: string): DeclarationInfo[] {
    const results: DeclarationInfo[] = [];
    const regex = /create\s+(or\s+replace\s+)?(function|procedure)\b/ig;
    let m: RegExpExecArray | null;
    while ((m = regex.exec(text)) !== null) {
        const declType = (m[2] || '').toLowerCase();
        const after = regex.lastIndex;
        let i = after;
        while (i < text.length && /\s/.test(text[i])) i++;
        if (i >= text.length) continue;
        let nameRaw = '';
        if (text[i] === '"') {
            let j = i + 1;
            while (j < text.length) {
                if (text[j] === '"') {
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

        const parenIndex = text.indexOf('(', i);
        if (parenIndex === -1) continue;
        const balanced = extractBalancedParentheses(text, parenIndex);
        if (!balanced) continue;

        let endIndex = balanced.endIndex;
        try {
            const endRegex = /\bend\s*;/ig;
            endRegex.lastIndex = balanced.endIndex;
            const endMatch = endRegex.exec(text);
            if (endMatch && endMatch.index >= 0) {
                endIndex = endMatch.index + endMatch[0].length;
            } else {
                const semi = text.indexOf(';', balanced.endIndex);
                if (semi !== -1) endIndex = semi + 1;
            }
        } catch (e) {
            // ignore and keep balanced.endIndex
        }
        const params = balanced.content;
        const normalized = nameRaw.startsWith('"') ? nameRaw.replace(/^"|"$/g, '') : nameRaw;

        results.push({ nameRaw, name: normalized, isFunction: declType === 'function', params, startIndex: m.index, endIndex });

        regex.lastIndex = endIndex;
    }
    return results;
}

export function splitParameters(paramText: string): string[] {
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

export function extractCommentDescription(text: string, nameRaw: string): string | null {
    if (!text || !nameRaw) return null;
    try {
        const commentRegex = new RegExp(
            `comment\\s+on\\s+(function|procedure)\\s+${escapeRegex(nameRaw)}\\s*(?:\\([^)]*?\\))?\\s+is\\s+['\"]([^'\"]+)['\"]`,
            'i'
        );
        const m = text.match(commentRegex);
        if (m) return m[2];
    } catch (e) {
        // ignore
    }
    return null;
}

export abstract class BasePostgresProvider {
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

export function normalizeIdentifier(id: string): string {
    if (!id) return id;
    id = id.trim();
    if (id.startsWith('"') && id.endsWith('"')) {
        return id.slice(1, -1).replace(/""/g, '"');
    }
    return id;
}

export function escapeRegex(str: string): string {
    return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function isPostgresKeyword(word: string): boolean {
    return POSTGRES_KEYWORDS.includes(word.toLowerCase());
}

export function findDeclarationStart(document: vscode.TextDocument, line: number): number {
    for (let currentLine = line; currentLine >= 0; currentLine--) {
        if (DECLARATION_REGEX.test(document.lineAt(currentLine).text)) {
            return currentLine;
        }
    }
    return -1;
}

export function findDeclarationEnd(document: vscode.TextDocument, line: number): number {
    if (line < 0) return -1;

    const lastLine = document.lineCount - 1;

    let beginCount = 0;
    let sawBegin = false;
    for (let currentLine = line; currentLine <= lastLine; currentLine++) {
        const text = document.lineAt(currentLine).text;
        const begins = (text.match(/\bBEGIN\b/ig) || []).length;
        const ends = (text.match(/\bEND\b/ig) || []).length;

        if (begins > 0) {
            sawBegin = true;
            beginCount += begins;
        }
        if (ends > 0) {
            beginCount -= ends;
            if (sawBegin && beginCount <= 0 && END_REGEX.test(text)) {
                return currentLine;
            }
        }
    }

    for (let currentLine = line; currentLine <= lastLine; currentLine++) {
        const text = document.lineAt(currentLine).text;
        if (END_REGEX.test(text)) {
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
