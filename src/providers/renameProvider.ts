import * as vscode from 'vscode';
import { WORD_RANGE_REGEX, isPostgresKeyword, escapeRegex, findDeclarationStart, findDeclarationEnd, DECLARATION_REGEX, DECLARE_REGEX, BEGIN_REGEX } from '../utils';

export class PostgresRenameProvider implements vscode.RenameProvider {
    prepareRename(
        document: vscode.TextDocument,
        position: vscode.Position,
        _token: vscode.CancellationToken
    ): vscode.ProviderResult<vscode.Range | { range: vscode.Range; placeholder: string }> {
        const wordRange = document.getWordRangeAtPosition(position, WORD_RANGE_REGEX);
        if (!wordRange) {
            return Promise.reject("Cannot rename at this location.");
        }

        const word = document.getText(wordRange);
        if (isPostgresKeyword(word)) {
            return Promise.reject("Cannot rename PostgreSQL keywords.");
        }

        return { range: wordRange, placeholder: word };
    }

    provideRenameEdits(
        document: vscode.TextDocument,
        position: vscode.Position,
        newName: string,
        _token: vscode.CancellationToken
    ): vscode.ProviderResult<vscode.WorkspaceEdit> {
        return (async () => {
            const wordRange = document.getWordRangeAtPosition(position, WORD_RANGE_REGEX);
            if (!wordRange) {
                return Promise.reject("Cannot rename at this location.");
            }

            const oldName = document.getText(wordRange);

            if (!this.validateRenameNames(oldName, newName)) {
                return Promise.reject("The new name must be different from the old one and cannot be a reserved keyword.");
            }

            const edit = await this.provideHeuristicRenameEdits(document, wordRange, newName, oldName);

            if (!edit) {
                return Promise.reject("No results for rename at this location.");
            }

            let any = false;
            for (const [uri, changes] of edit.entries()) {
                if (changes && changes.length > 0) {
                    any = true;
                    break;
                }
            }

            if (!any) {
                return Promise.reject("No changes to apply.");
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

        if (isOnDeclarationName && wordRange.start.line === declStart) {
            return await this.applyGlobalRename(document, edit, oldName, newName);
        }

        const isInParams = this.isInParameterRange(document, declStart, declEnd, wordRange.start);
        const isInDeclare = this.isInDeclareRange(document, declStart, declEnd, wordRange.start);

        if (isInParams || isInDeclare) {
            return this.applyLocalRename(document, edit, declStart, declEnd, oldName, newName);
        }

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
