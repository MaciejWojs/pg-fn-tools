import * as vscode from 'vscode';
import { parseDeclarationsFromText } from '../utils';

export class PostgresDocumentSymbolProvider implements vscode.DocumentSymbolProvider {
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
