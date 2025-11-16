import * as vscode from 'vscode';
import { BasePostgresProvider, normalizeIdentifier, escapeRegex } from '../utils';

export class PostgresReferenceProvider extends BasePostgresProvider implements vscode.ReferenceProvider {
    async provideReferences(
        document: vscode.TextDocument,
        position: vscode.Position,
        _context: vscode.ReferenceContext,
        _token: vscode.CancellationToken
    ): Promise<vscode.Location[]> {
        const extracted = this.extractWordAtPosition(document, position);
        if (!extracted) return [];

        const references: vscode.Location[] = [];

        this.findReferencesInDocument(document, extracted.word, references);

        const sqlFiles = await vscode.workspace.findFiles("**/*.{sql,SQL}");
        for (const uri of sqlFiles) {
            try {
                const doc = await vscode.workspace.openTextDocument(uri);
                this.findReferencesInDocument(doc, extracted.word, references);
            } catch (e) {
            }
        }

        return references;
    }

    private findReferencesInDocument(document: vscode.TextDocument, wordName: string, references: vscode.Location[]): void {
        const fullText = document.getText();
        const name = normalizeIdentifier(wordName);
        const quoted = '"' + name.replace(/"/g, '""') + '"';
        const referenceRegex = new RegExp(`(${escapeRegex(quoted)}|${escapeRegex(name)})`, "gi");
        let match: RegExpExecArray | null;

        while ((match = referenceRegex.exec(fullText)) !== null) {
            const lineStart = fullText.substring(0, match.index).split("\n").length - 1;
            const lineText = document.lineAt(lineStart).text;
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
