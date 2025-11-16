import * as vscode from 'vscode';
import { splitParameters, parseDeclarationsFromText, normalizeIdentifier } from '../utils';

export class PostgresSignatureHelpProvider implements vscode.SignatureHelpProvider {
    public async provideSignatureHelp(
        document: vscode.TextDocument,
        position: vscode.Position,
        _token: vscode.CancellationToken,
        _context: vscode.SignatureHelpContext
    ): Promise<vscode.SignatureHelp | null> {
        const text = document.getText();
        const offset = document.offsetAt(position);

        const before = text.substring(0, offset);
        const parenIdx = before.lastIndexOf('(');
        if (parenIdx === -1) return null;

        let i = parenIdx - 1;
        while (i >= 0 && /\s/.test(before[i])) i--;
        if (i < 0) return null;

        let nameEnd = i + 1;
        let nameStart = i;
        if (before[nameStart] === '"') {
            nameStart = before.lastIndexOf('"', nameStart - 1);
            if (nameStart === -1) return null;
        } else {
            while (nameStart >= 0 && /[a-zA-Z0-9_:\.\"]/.test(before[nameStart])) nameStart--;
            nameStart++;
        }

        const rawName = before.substring(nameStart, nameEnd).trim();
        const name = normalizeIdentifier(rawName);

        const paramsText = before.substring(parenIdx + 1);
        const paramParts = splitParameters(paramsText);
        const activeParameter = Math.max(0, paramParts.length - 1);

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
