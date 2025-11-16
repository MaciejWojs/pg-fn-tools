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

            const edit = await this.provideHeuristicRenameEdits(document, position, wordRange, newName, oldName);

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
        position: vscode.Position,
        wordRange: vscode.Range,
        newName: string,
        oldName: string
    ): Promise<vscode.WorkspaceEdit | undefined> {
        const edit = new vscode.WorkspaceEdit();

        const isOnFunctionDeclaration = this.isOnFunctionDeclaration(document, position, oldName);
        
        if (isOnFunctionDeclaration) {
            console.log('Applying GLOBAL rename for function declaration');
            return await this.applyGlobalRename(document, edit, oldName, newName);
        }

        const isFunctionCall = this.isFunctionCall(document, position, wordRange, oldName);
        
        if (isFunctionCall) {
            console.log('Applying GLOBAL rename for function call');
            return await this.applyGlobalRename(document, edit, oldName, newName);
        }

        const declStart = findDeclarationStart(document, position.line);
        const declEnd = findDeclarationEnd(document, declStart);

        console.log(`Local rename - declStart: ${declStart}, declEnd: ${declEnd}, position: ${position.line}`);

        return this.applyLocalRename(document, edit, declStart, declEnd, oldName, newName);
    }

    private isOnFunctionDeclaration(
        document: vscode.TextDocument,
        position: vscode.Position,
        oldName: string
    ): boolean {
        const lineText = document.lineAt(position.line).text;
        
        const isFunctionDeclaration = this.looksLikeFunctionDeclaration(lineText);
        
        if (!isFunctionDeclaration) {
            console.log('Not a function declaration line:', lineText);
            return false;
        }

        const functionNameRegex = new RegExp(`\\b${escapeRegex(oldName)}\\b`, 'i');
        const nameMatch = functionNameRegex.exec(lineText);
        
        if (!nameMatch) {
            console.log('Function name not found in declaration line');
            return false;
        }

        const nameStart = nameMatch.index;
        const nameEnd = nameStart + oldName.length;
        
        const isCursorOnName = position.character >= nameStart && position.character <= nameEnd;
        
        console.log(`Cursor on function name: ${isCursorOnName}, name: ${oldName}, position: ${position.character}, nameRange: [${nameStart}, ${nameEnd}]`);
        
        return isCursorOnName;
    }

    private looksLikeFunctionDeclaration(lineText: string): boolean {
        const normalizedLine = lineText.toLowerCase().trim();
        
        const functionPatterns = [
            /create\s+function/i,
            /create\s+or\s+replace\s+function/i,
            /function\s+\w+/i,
            /procedure\s+\w+/i,
            /create\s+procedure/i,
            /create\s+or\s+replace\s+procedure/i
        ];

        return functionPatterns.some(pattern => pattern.test(normalizedLine));
    }

    private isFunctionCall(
        document: vscode.TextDocument,
        position: vscode.Position,
        wordRange: vscode.Range,
        oldName: string
    ): boolean {
        const lineText = document.lineAt(position.line).text;
        
        const wordStart = wordRange.start.character;
        const wordEnd = wordRange.end.character;
        
        let afterWord = lineText.substring(wordEnd).trimStart();
        
        if (afterWord.startsWith('(')) {
            console.log(`Function call detected: ${oldName}(...) at line ${position.line}`);
            return true;
        }
        
        return false;
    }

    private async applyGlobalRename(
        document: vscode.TextDocument,
        edit: vscode.WorkspaceEdit,
        oldName: string,
        newName: string
    ): Promise<vscode.WorkspaceEdit> {
        console.log(`Starting GLOBAL rename: ${oldName} -> ${newName}`);
        
        const regex = new RegExp(`\\b${escapeRegex(oldName)}\\b`, "gi");

        for (let line = 0; line < document.lineCount; line++) {
            const textLine = document.lineAt(line);
            let match: RegExpExecArray | null;
            regex.lastIndex = 0;
            while ((match = regex.exec(textLine.text))) {
                const start = new vscode.Position(line, match.index);
                const end = new vscode.Position(line, match.index + oldName.length);
                edit.replace(document.uri, new vscode.Range(start, end), newName);
                console.log(`Replaced in current document at line ${line}`);
            }
        }

        try {
            const sqlFilesLower = await vscode.workspace.findFiles("**/*.sql", "**/node_modules/**");
            const sqlFilesUpper = await vscode.workspace.findFiles("**/*.SQL", "**/node_modules/**");
            const allSqlFiles = [...sqlFilesLower, ...sqlFilesUpper];
            
            const uniqueFiles = Array.from(new Set(allSqlFiles.map(uri => uri.fsPath)))
                .map(fsPath => allSqlFiles.find(uri => uri.fsPath === fsPath)!);
            
            console.log(`Found ${uniqueFiles.length} SQL files to search`);
            
            for (const uri of uniqueFiles) {
                if (uri.fsPath === document.uri.fsPath) {
                    console.log(`Skipping current document: ${uri.fsPath}`);
                    continue;
                }
                
                try {
                    console.log(`Processing file: ${uri.fsPath}`);
                    const doc = await vscode.workspace.openTextDocument(uri);
                    let replacementCount = 0;
                    
                    for (let line = 0; line < doc.lineCount; line++) {
                        const textLine = doc.lineAt(line);
                        let match: RegExpExecArray | null;
                        regex.lastIndex = 0;
                        while ((match = regex.exec(textLine.text))) {
                            const start = new vscode.Position(line, match.index);
                            const end = new vscode.Position(line, match.index + oldName.length);
                            edit.replace(doc.uri, new vscode.Range(start, end), newName);
                            replacementCount++;
                            console.log(`Replaced in ${uri.fsPath} at line ${line}, column ${match.index}`);
                        }
                    }
                    
                    if (replacementCount > 0) {
                        console.log(`Total replacements in ${uri.fsPath}: ${replacementCount}`);
                    }
                } catch (e) {
                    console.error(`Error processing file ${uri.fsPath}:`, e);
                }
            }
        } catch (error) {
            console.error('Error finding SQL files:', error);
        }

        console.log('Global rename completed');
        return edit;
    }

    private applyLocalRename(
        document: vscode.TextDocument,
        edit: vscode.WorkspaceEdit,
        declStart: number,
        declEnd: number,
        oldName: string,
        newName: string
    ): vscode.WorkspaceEdit {
        console.log(`Applying LOCAL rename from line ${declStart} to ${declEnd}`);
        
        const bodyRegex = new RegExp(`\\b${escapeRegex(oldName)}\\b`, "g");

        for (let line = declStart; line <= declEnd; line++) {
            const textLine = document.lineAt(line);
            let match: RegExpExecArray | null;
            bodyRegex.lastIndex = 0;

            while ((match = bodyRegex.exec(textLine.text))) {
                const start = new vscode.Position(line, match.index);
                const end = new vscode.Position(line, match.index + oldName.length);
                edit.replace(document.uri, new vscode.Range(start, end), newName);
                console.log(`Local replace at line ${line}`);
            }
        }

        return edit;
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