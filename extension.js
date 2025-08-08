let coreFunctionsParsed = false;
const vscode = require('vscode');
const AdmZip = require('adm-zip');
const fs = require('fs');
const path = require('path');

let functionSignatures = new Map();
let outputChannel = null;
let parsedProjectPaths = new Set();

function parseZScriptText(text, fileName, verbose = false) {
  outputChannel.appendLine(`Parsing file: ${fileName}`);
  text = text.replace(/\/\*[\s\S]*?\*\//g, ''); // Remove multi-line comments
  text = text.replace(/\/\/.*$/gm, ''); // Remove single-line comments

  const funcRegex = /(?:\b(?:native|static|virtual|protected|private|clearscope|action|ui|play|const|override|vararg|out|in|readonly|deprecated\("[^"]*"(?:,\s*"[^"]*")?\)|version\("[^"]*"\))\s+)*((?:\w+(?:\s+\w+)*(?:\s*,\s*\w+(?:\s+\w+)*)*)?)\s+(\w+)\s*\(\s*([^)]*?(?:\s*,\s*\.\..\.)?)\s*\)\s*(?:const)?\s*[;{]/;
  const structRegex = /\b(class|struct)\s+(\w+)/;
  let braceDepth = 0;
  let currentStructure = { type: null, name: null };
  let lines = text.split('\n');
  let functionsFound = 0;
  let currentLine = '';

  for (let i = 0; i < lines.length; i++) {
    let line = lines[i].trim();
    if (!line) continue;

    if (braceDepth >= 1 && !line.match(/[;{]$/) && !line.match(/^\}/)) {
      currentLine += ' ' + line;
      continue;
    } else if (currentLine) {
      line = (currentLine + ' ' + line).trim();
      currentLine = '';
    }

    let structMatch = structRegex.exec(line);
    if (structMatch && braceDepth === 0) {
      currentStructure.type = structMatch[1];
      currentStructure.name = structMatch[2];
    }

    if (braceDepth === 1) {
      if (line.match(/\belse\s+if\b/)) continue;
      let match = funcRegex.exec(line);
      if (match) {
        let returnType = match[1] || 'void';
        const name = match[2];
        const paramsStr = match[3].trim();

        if (name.match(/^(if|else|while|for|return|struct|class)$/)) continue;

        const params = paramsStr ? paramsStr.split(/\s*,\s*/).filter(p => p) : [];
        const paramInfos = params.map(param => {
          const parts = param.trim().split(/\s+/);
          let type = parts[0];
          let nameAndDefault = parts.slice(1).join(' ');
          if (type.startsWith('class<') && param.indexOf('>') !== -1) {
            const closeIndex = param.indexOf('>');
            type = param.substring(0, closeIndex + 1).trim();
            nameAndDefault = param.substring(closeIndex + 1).trim();
          }
          const nameMatch = nameAndDefault.match(/^(\w+)/);
          const paramName = nameMatch ? nameMatch[1] : nameAndDefault || 'param';
          return new vscode.ParameterInformation(paramName, type);
        });

        const signatureLabel = `${returnType} ${name}(${paramsStr})`;
        const sig = new vscode.SignatureInformation(signatureLabel);
        sig.parameters = paramInfos;
        sig.documentation = new vscode.MarkdownString(
          currentStructure.name ? `Defined in: ${currentStructure.type} ${currentStructure.name}` : 'Built-in ZScript function'
        );

        functionSignatures.set(name.toLowerCase(), sig);
        functionsFound++;
      }
    }

    for (let char of line) {
      if (char === '{') {
        braceDepth++;
      } else if (char === '}') {
        braceDepth--;
        if (braceDepth < 0) braceDepth = 0;
        if (braceDepth === 0) {
          currentStructure = { type: null, name: null };
        }
      }
    }
  }

  outputChannel.appendLine(`Parsed ${functionsFound} functions from ${fileName}`);
  return functionsFound;
}

function parsePk3(verbose = false) {
  try {
    outputChannel.appendLine('Started parsing gzdoom.pk3');
    const pk3Path = vscode.workspace.getConfiguration('zscript').get('gzdoomPk3Path');
    if (!pk3Path) {
      vscode.window.showErrorMessage('Set the "zscript.gzdoomPk3Path" in settings first.');
      return;
    }

    const zip = new AdmZip(pk3Path);
    const entries = zip.getEntries();
    functionSignatures.clear();
    let totalFunctions = 0;

    entries.forEach(entry => {
      const entryNameLower = entry.entryName.toLowerCase();
      if (entryNameLower.startsWith('zscript/') && !entry.isDirectory && !entryNameLower.endsWith('.txt')) {
        const text = zip.readAsText(entry);
        totalFunctions += parseZScriptText(text, entry.entryName, verbose);
      }
    });

    outputChannel.appendLine(`Parsed ${totalFunctions} functions from gzdoom.pk3`);
    vscode.window.showInformationMessage(`Parsed ${totalFunctions} built-in functions from gzdoom.pk3`);
  } catch (error) {
    vscode.window.showErrorMessage(`Error parsing gzdoom.pk3: ${error.message}`);
    outputChannel.appendLine(`Error: ${error.message}`);
  }
}

function parseProjectFromRootZScript(rootDoc) {
  const rootDir = path.dirname(rootDoc.uri.fsPath);
  const alreadyParsed = new Set();

  function parseFileRecursively(filePath) {
    const normalizedPath = path.normalize(filePath).toLowerCase();
    if (alreadyParsed.has(normalizedPath)) return;
    alreadyParsed.add(normalizedPath);

    if (!fs.existsSync(filePath)) return;
    const content = fs.readFileSync(filePath, 'utf8');
    parseZScriptText(content, path.basename(filePath));

    const includeRegex = /^\s*#include\s+"([^"]+)"\s*$/gmi;
    let match;
    while ((match = includeRegex.exec(content))) {
      const includePath = path.resolve(rootDir, match[1]);
      parseFileRecursively(includePath);
    }
  }

  parseFileRecursively(rootDoc.uri.fsPath);
  outputChannel.appendLine(`Finished parsing user project. Total functions: ${functionSignatures.size}`);
}

function tryParseProjectFromZScript(doc) {
  const docPath = doc.uri.fsPath;
  const dirName = path.dirname(docPath);
  const baseName = path.parse(docPath).name.toLowerCase();

  if (baseName === 'zscript' && !parsedProjectPaths.has(dirName.toLowerCase())) {
    try {
      const siblingFiles = fs.readdirSync(dirName).map(f => path.parse(f).name.toLowerCase());
      if (siblingFiles.includes('zscript')) {
        outputChannel.appendLine(`Detected project root zscript in: ${dirName}`);
        parseProjectFromRootZScript(doc);
        parsedProjectPaths.add(dirName.toLowerCase());
      }
    } catch (err) {
      outputChannel.appendLine(`Error checking sibling files in ${dirName}: ${err.message}`);
    }
  }
}

exports.activate = function(context) {
  try {
    outputChannel = vscode.window.createOutputChannel('ZScript Extension');
    outputChannel.appendLine('ZScript extension activated.');

    context.subscriptions.push(vscode.commands.registerCommand('zscript.parsePk3', () => {
      parsePk3(false);
    }));

    context.subscriptions.push(vscode.commands.registerCommand('zscript.parsePk3Verbose', () => {
      parsePk3(true);
    }));

    context.subscriptions.push(vscode.languages.registerSignatureHelpProvider('zscript', {
      provideSignatureHelp(document, position) {
        const lineText = document.lineAt(position).text.substring(0, position.character);
        const funcMatch = lineText.match(/(\w+)\s*\(\s*[^)]*$/);
        if (!funcMatch) return null;

        const funcName = funcMatch[1].toLowerCase();
        const signature = functionSignatures.get(funcName);
        if (!signature) return null;

        const openParenPos = lineText.lastIndexOf('(');
        const argsText = lineText.substring(openParenPos + 1);
        const args = argsText.split(',').map(a => a.trim()).filter(Boolean);

        let currentIndex = 0;
        for (let i = 0; i < args.length - 1; i++) {
          if (args[i].includes(':')) {
            const name = args[i].split(':')[0];
            const paramIndex = signature.parameters.findIndex(p => p.label === name);
            if (paramIndex !== -1) currentIndex = paramIndex + 1;
          } else {
            currentIndex++;
          }
        }

        const help = new vscode.SignatureHelp();
        help.signatures = [signature];
        help.activeSignature = 0;
        help.activeParameter = currentIndex;

        return help;
      }
    }, '(', ',', ':'));

    context.subscriptions.push(vscode.languages.registerCompletionItemProvider('zscript', {
      provideCompletionItems(document, position) {
        const lineText = document.lineAt(position).text.substring(0, position.character);
        const wordMatch = lineText.match(/\b(\w*)$/);
        if (!wordMatch) return [];

        const prefix = wordMatch[1].toLowerCase();
        const completions = [];

        for (const [name, signature] of functionSignatures.entries()) {
          if (name.startsWith(prefix)) {
            const item = new vscode.CompletionItem(name, vscode.CompletionItemKind.Function);
            item.detail = signature.label;
            item.documentation = signature.documentation;
            completions.push(item);
          }
        }

        return completions;
      }
    }, ...'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('')));

    vscode.workspace.onDidOpenTextDocument(doc => {
      if (doc.languageId === 'zscript') {
        if (!coreFunctionsParsed) {
          parsePk3(false);
          coreFunctionsParsed = true;
        }
        tryParseProjectFromZScript(doc);
      }
    });

    vscode.window.onDidChangeActiveTextEditor(editor => {
      if (editor && editor.document.languageId === 'zscript') {
        if (!coreFunctionsParsed) {
          parsePk3(false);
          coreFunctionsParsed = true;
        }
        tryParseProjectFromZScript(editor.document);
      }
    });

  } catch (error) {
    outputChannel.appendLine(`Extension activation failed: ${error.message}`);
    vscode.window.showErrorMessage(`ZScript extension failed: ${error.message}`);
  }
};