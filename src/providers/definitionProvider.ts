import * as vscode from 'vscode';
import { BasePostgresProvider, parseDeclarationsFromText, normalizeIdentifier } from '../utils';

export class PostgresDefinitionProvider extends BasePostgresProvider implements vscode.DefinitionProvider {
    provideDefinition(
        document: vscode.TextDocument,
        position: vscode.Position,
        _token: vscode.CancellationToken
    ): vscode.ProviderResult<vscode.Definition> {
        const extracted = this.extractWordAtPosition(document, position);
        if (!extracted) return null;

        const localDefinition = this.findDefinitionInDocument(document, extracted.word);
        if (localDefinition) {
            return localDefinition;
        }

        return this.findInWorkspace(doc => this.findDefinitionInDocument(doc, extracted.word));
    }

    private findDefinitionInDocument(document: vscode.TextDocument, wordName: string): vscode.Location | null {
        const fullText = document.getText();
        const decls = parseDeclarationsFromText(fullText);
        const name = normalizeIdentifier(wordName);
        const found = decls.find(d => d.name.toLowerCase() === name.toLowerCase());
        if (!found) return null;

        const declText = fullText.substring(found.startIndex, found.endIndex + 1);
        const relIdx = declText.indexOf(found.nameRaw);
        const absIdx = relIdx >= 0 ? found.startIndex + relIdx : found.startIndex;
        const startPos = document.positionAt(absIdx);
        const endPos = document.positionAt(absIdx + (found.nameRaw.length));

        return new vscode.Location(document.uri, new vscode.Range(startPos, endPos));
    }
}
