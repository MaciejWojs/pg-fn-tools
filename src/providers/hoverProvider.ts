import * as vscode from 'vscode';
import { BasePostgresProvider, parseDeclarationsFromText, normalizeIdentifier, escapeRegex, extractCommentDescription } from '../utils';

export class PostgresHoverProvider extends BasePostgresProvider implements vscode.HoverProvider {
    async provideHover(
        document: vscode.TextDocument,
        position: vscode.Position,
        _token: vscode.CancellationToken
    ): Promise<vscode.Hover | null> {
        const extracted = this.extractWordAtPosition(document, position);
        if (!extracted) return null;

        const hover = this.findHoverInDocument(document, extracted.word);
        if (hover) {
            return hover;
        }

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

        const desc = extractCommentDescription(fullText, found.nameRaw) || 'No description';

        const markdownContent = new vscode.MarkdownString();
        markdownContent.appendMarkdown(`**${isFunction ? "Function" : "Procedure"}**: \`${found.name}\`\n\n`);

        if (parameters) {
            markdownContent.appendMarkdown("**Parameters:**\n```sql\n");
            markdownContent.appendMarkdown(parameters);
            markdownContent.appendMarkdown("\n```\n\n");
        }

        markdownContent.appendMarkdown(`**Description:**\n${desc}`);

        return new vscode.Hover(markdownContent);
    }
}
