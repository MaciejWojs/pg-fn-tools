import * as vscode from 'vscode';
import { findDeclarationEnd, escapeRegex } from './utils';
import {
  PostgresDocumentSymbolProvider,
  PostgresHoverProvider,
  PostgresDefinitionProvider,
  PostgresReferenceProvider,
  PostgresRenameProvider,
  PostgresCompletionProvider,
  PostgresSignatureHelpProvider
} from './providers';

export const activate = (context: vscode.ExtensionContext) => {
  const symbolProvider = new PostgresDocumentSymbolProvider();
  const hoverProvider = new PostgresHoverProvider();
  const definitionProvider = new PostgresDefinitionProvider();
  const referenceProvider = new PostgresReferenceProvider();
  const renameProvider = new PostgresRenameProvider();
  const completionProvider = new PostgresCompletionProvider();
  completionProvider.initialize(context);

  const signatureProvider = new PostgresSignatureHelpProvider();

  const selector: vscode.DocumentSelector = [
    { language: 'sql' }
  ];

  context.subscriptions.push(
    vscode.languages.registerDocumentSymbolProvider(selector, symbolProvider),
    vscode.languages.registerHoverProvider(selector, hoverProvider),
    vscode.languages.registerDefinitionProvider(selector, definitionProvider),
    vscode.languages.registerReferenceProvider(selector, referenceProvider),
    vscode.languages.registerRenameProvider(selector, renameProvider),
    vscode.languages.registerCompletionItemProvider(selector, completionProvider)
  );

  context.subscriptions.push(
    vscode.languages.registerSignatureHelpProvider(selector, signatureProvider, '(', ',')
  );

  const showFunctionsCommand = vscode.commands.registerCommand(
    'postgres.showFunctions',
    async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) return;

      const document = editor.document;
      const symbols = await symbolProvider.provideDocumentSymbols(
        document,
        new vscode.CancellationTokenSource().token
      );

      if (!symbols || !Array.isArray(symbols) || symbols.length === 0) {
        vscode.window.showInformationMessage('No functions/procedures in the file.');
        return;
      }

      const pick = await vscode.window.showQuickPick(
        symbols.map((s) => ({ label: s.name, detail: s.detail || undefined, symbol: s })),
        { placeHolder: 'Select a function or procedure' }
      );

      if (!pick) return;

      const { symbol } = pick;
      const range = (symbol as vscode.DocumentSymbol).range;
      editor.selection = new vscode.Selection(range.start, range.start);
      editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
    }
  );

  context.subscriptions.push(showFunctionsCommand);

  const moveFunctionCommand = vscode.commands.registerCommand(
    'postgres.moveFunction',
    async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) return;

      const document = editor.document;
      const text = document.getText();

      const declRegex = /create\s+(?:or\s+replace\s+)?(function|procedure)\s+([a-zA-Z0-9_\.\"]+)\s*\(/gi;
      const entries: Array<any> = [];

      let m: RegExpExecArray | null;
      while ((m = declRegex.exec(text)) !== null) {
        const declType = (m[1] || '').toLowerCase();
        const rawName = (m[2] || '').replace(/\"/g, '');
        const declIndex = m.index;
        const declLine = text.substring(0, declIndex).split('\n').length - 1;
        const declEnd = findDeclarationEnd(document, declLine);

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

        entries.push({ name: rawName, declLine, startLine: commentStart, endLine: declEnd, preview: preview, type: declType, lines: linesCount });
      }

      if (entries.length === 0) {
        vscode.window.showInformationMessage('No functions/procedures in the current file.');
        return;
      }

      const pick = await vscode.window.showQuickPick(entries.map(e => `${e.name}`), { placeHolder: 'Select function/procedure to move' });
      if (!pick) return;

      const idx = entries.findIndex(e => pick.startsWith(e.name));
      if (idx === -1) return;

      const chosen = entries[idx];
      const srcStart = new vscode.Position(chosen.startLine, 0);
      const srcEnd = new vscode.Position(chosen.endLine, document.lineAt(chosen.endLine).text.length);
      const srcRange = new vscode.Range(srcStart, srcEnd);
      let funcText = document.getText(srcRange);

      const commentRegex = new RegExp(`comment\\s+on\\s+(function|procedure)\\s+${escapeRegex(chosen.name)}\\s*(?:\\([^)]*?\\))?\\s+is\\s+['\"][^'\"]*['\"]\\s*;?`, 'gi');
      const commentMatches: { range: vscode.Range; text: string }[] = [];
      let cm: RegExpExecArray | null;
      while ((cm = commentRegex.exec(text)) !== null) {
        const cStart = cm.index;
        const cEnd = commentRegex.lastIndex;
        const cStartLine = text.substring(0, cStart).split('\n').length - 1;
        const cEndLine = text.substring(0, cEnd).split('\n').length - 1;
        const cRange = new vscode.Range(new vscode.Position(cStartLine, 0), new vscode.Position(cEndLine, document.lineAt(cEndLine).text.length));
        if (cRange.start.line >= srcRange.start.line && cRange.end.line <= srcRange.end.line) continue;
        const cText = text.substring(cStart, cEnd).trim();
        commentMatches.push({ range: cRange, text: cText });
      }

      if (commentMatches.length > 0) {
        funcText = funcText + '\n\n' + commentMatches.map(c => c.text).join('\n\n');
      }

      const sqlFiles = await vscode.workspace.findFiles('**/*.{sql,SQL}');
      const fileItems = sqlFiles.map(u => ({ label: vscode.workspace.asRelativePath(u), uri: u }));
      fileItems.unshift({ label: 'Create new file...', uri: undefined as any });

      const destPickLabel = await vscode.window.showQuickPick(fileItems.map(f => f.label), { placeHolder: 'Select destination file' });
      if (!destPickLabel) return;

      let destUri: vscode.Uri | undefined;
      if (destPickLabel === 'Create new file...') {
        const filename = await vscode.window.showInputBox({ prompt: 'Path for new file (relative to workspace root)' });
        if (!filename) return;
        const folders = vscode.workspace.workspaceFolders;
        const base = folders && folders[0] ? folders[0].uri.fsPath : undefined;
        if (!base) {
          vscode.window.showErrorMessage('No workspace open.');
          return;
        }
        const full = require('path').join(base, filename);
        destUri = vscode.Uri.file(full);
        try {
          await vscode.workspace.fs.writeFile(destUri, new Uint8Array());
        } catch (e) {
        }
      } else {
        const found = fileItems.find(f => f.label === destPickLabel);
        destUri = found ? found.uri : undefined;
      }

      if (!destUri) return;

      if (destUri.toString() === document.uri.toString()) {
        vscode.window.showInformationMessage('Selected the same file — choose a different destination file.');
        return;
      }

      const destDoc = await vscode.workspace.openTextDocument(destUri);

      const edit = new vscode.WorkspaceEdit();
      edit.delete(document.uri, srcRange);
      for (const cmItem of commentMatches) {
        edit.delete(document.uri, cmItem.range);
      }

      const lastLine = Math.max(0, destDoc.lineCount - 1);
      const insertPos = new vscode.Position(lastLine, destDoc.lineAt(lastLine).text.length);
      const prefix = destDoc.getText().trim().length > 0 ? '\n\n' : '';
      edit.insert(destDoc.uri, insertPos, prefix + funcText + '\n');

      const success = await vscode.workspace.applyEdit(edit);
      if (success) {
        vscode.window.showInformationMessage('Function/procedure moved.');
      } else {
        vscode.window.showErrorMessage('Failed to move function.');
      }
    }
  );

  context.subscriptions.push(moveFunctionCommand);

  const generateSkeletonCommand = vscode.commands.registerCommand(
    'postgres.generateSkeleton',
    async () => {
      const type = await vscode.window.showQuickPick(['function', 'procedure'], { placeHolder: 'Choose type' });
      if (!type) return;

      const name = await vscode.window.showInputBox({ prompt: `Name ${type}` });
      if (!name) return;

      const params = await vscode.window.showInputBox({ prompt: 'Parameters (e.g. id integer, name text) - leave empty if none' }) || '';

      let returns = '';
      if (type === 'function') {
        returns = await vscode.window.showInputBox({ prompt: 'Return type (e.g. void, integer, TABLE(...))', value: 'void' }) || 'void';
      }

      const language = await vscode.window.showInputBox({ prompt: 'Language (e.g. plpgsql)', value: 'plpgsql' }) || 'plpgsql';

      const editor = vscode.window.activeTextEditor;
      let targetDoc: vscode.TextDocument | undefined = editor ? editor.document : undefined;

      if (!targetDoc) {
        const sqlFiles = await vscode.workspace.findFiles('**/*.{sql,SQL}');
        const pick = await vscode.window.showQuickPick(sqlFiles.map(u => u.fsPath), { placeHolder: 'Select destination file' });
        if (!pick) return;
        const found = sqlFiles.find(u => u.fsPath === pick);
        if (!found) return;
        targetDoc = await vscode.workspace.openTextDocument(found);
      }

      const isFunction = type === 'function';
      const paramsStr = params.trim();
      const returnsStr = isFunction ? `RETURNS ${returns}` : '';

      const skeleton = `CREATE OR REPLACE ${type.toUpperCase()} ${name}(${paramsStr})\n${returnsStr}\nLANGUAGE ${language}\nAS $$\nBEGIN\n  -- TODO: implement\n  RETURN${isFunction ? ' NULL;' : ';'}\nEXCEPTION WHEN OTHERS THEN\n  -- handle\n  RAISE;\nEND;\n$$;\n`;

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
        vscode.window.showErrorMessage('Failed to insert skeletons.');
      }
    }
  );

  context.subscriptions.push(generateSkeletonCommand);
};

export const deactivate = () => { };
