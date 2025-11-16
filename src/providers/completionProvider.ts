import * as vscode from 'vscode';
import { BasePostgresProvider, POSTGRES_KEYWORDS, parseDeclarationsFromText, splitParameters, normalizeIdentifier, escapeRegex, extractCommentDescription } from '../utils';

export class PostgresCompletionProvider extends BasePostgresProvider implements vscode.CompletionItemProvider {
    private workspaceNames: Set<string> = new Set();
    private workspaceInfo: Map<string, { isFunction: boolean; parameters: string; description: string }> = new Map();
    private cacheReady: boolean = false;
    private refreshTimeout: any = undefined;
    private workspaceFileIndex: Map<string, string[]> = new Map();

    async initialize(context: vscode.ExtensionContext) {
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

            for (const p of prev) {
                if (p && !this.isNameDeclaredElsewhere(p, key)) {
                    this.workspaceNames.delete(p);
                    this.workspaceInfo.delete(p);
                }
            }

            for (const n of names) {
                this.workspaceNames.add(n);
                if (!this.workspaceInfo.has(n)) {
                    const info = this.findFunctionInfoInText(text, n);
                    if (info) this.workspaceInfo.set(n, info);
                }
            }

            this.workspaceFileIndex.set(key, names);
        } catch (e) {
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

        for (const kw of POSTGRES_KEYWORDS) {
            const item = new vscode.CompletionItem(kw.toUpperCase(), vscode.CompletionItemKind.Keyword);
            item.detail = "Postgres keyword";
            items.push(item);
        }

        const docText = document.getText();
        const nameRegex = /create\s+(?:or\s+replace\s+)?(?:function|procedure)\s+([a-zA-Z0-9_\.\"]+)\s*\(/gi;
        const names = new Set<string>();
        let m: RegExpExecArray | null;
        while ((m = nameRegex.exec(docText)) !== null) {
            names.add(m[1].replace(/\"/g, ""));
        }

        if (this.cacheReady) {
            for (const n of this.workspaceNames) names.add(n);
        } else {
            this.refreshWorkspaceCache();
        }

        for (const n of names) {
            const item = new vscode.CompletionItem(n, vscode.CompletionItemKind.Function);
            item.detail = "Function/Procedure (Postgres)";

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
                    const desc = info.description || extractCommentDescription(document.getText(), n) || 'No description';
                    md.appendMarkdown(`**Description:**\n${desc}`);
                    item.documentation = md;
                }
            } catch (e) {
            }

            items.push(item);
        }

        return items;
    }

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
            }
        }
        return result;
    }

    private async getFunctionInfo(name: string, document: vscode.TextDocument): Promise<{ isFunction: boolean; parameters: string; description: string } | null> {
        const inDoc = this.findFunctionInfoInText(document.getText(), name);
        if (inDoc) return inDoc;
        if (this.cacheReady && this.workspaceInfo.has(name)) {
            return this.workspaceInfo.get(name) || null;
        }

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
        const description = extractCommentDescription(text, found.nameRaw) || 'No description';

        return { isFunction, parameters: parameters.trim(), description };
    }
}
