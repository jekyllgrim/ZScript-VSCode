const vscode = require('vscode');
const AdmZip = require('adm-zip');
const fs = require('fs');

let functionSignatures = new Map();
let outputChannel = null;

// Parse ZScript text for function signatures at brace depth 1
function parseZScriptText(text, fileName) {
  outputChannel.appendLine(`Parsing file: ${fileName}`);
  text = text.replace(/\/\*[\s\S]*?\*\//g, ''); // Remove multi-line comments
  text = text.replace(/\/\/.*$/gm, ''); // Remove single-line comments

  // Regex for function signatures
  const funcRegex = /(?:\b(?:native|static|virtual|protected|private|clearscope|action|ui|play|const|override|vararg|out|in|readonly|deprecated\("[^"]*"(?:,\s*"[^"]*")?\)|version\("[^"]*"\))\s+)*((?:\w+(?:\s+\w+)*(?:\s*,\s*\w+(?:\s+\w+)*)*)?)\s+(\w+)\s*\(\s*([^)]*?(?:\s*,\s*\.\.\.)?)\s*\)\s*(?:const)?\s*[;{]/;
  // Regex for class/struct declarations
  const structRegex = /\b(class|struct)\s+(\w+)/;
  let braceDepth = 0;
  let currentStructure = { type: null, name: null }; // Track current class/struct
  let lines = text.split('\n');
  let functionsFound = 0;
  let currentLine = '';

  outputChannel.appendLine(`First 20 lines of ${fileName}:`);
  for (let i = 0; i < Math.min(20, lines.length); i++) {
    outputChannel.appendLine(`Line ${i}: ${lines[i].trim()}`);
  }

  for (let i = 0; i < lines.length; i++) {
    let line = lines[i].trim();
    if (!line) continue;

    // Accumulate lines for multi-line signatures
    if (braceDepth >= 1 && !line.match(/[;{]$/) && !line.match(/^\}/)) {
      currentLine += ' ' + line;
      continue;
    } else if (currentLine) {
      line = (currentLine + ' ' + line).trim();
      currentLine = '';
    }

    // Debug all lines in actor.zs with depth
    if (fileName.toLowerCase().endsWith('actor.zs')) {
      outputChannel.appendLine(`Debug actor.zs line ${i} (depth ${braceDepth}): "${line}"`);
    }

    // Check for class/struct declarations
    let structMatch = structRegex.exec(line);
    if (structMatch && braceDepth === 0) {
      currentStructure.type = structMatch[1]; // class or struct
      currentStructure.name = structMatch[2]; // e.g., Actor, Translate
      outputChannel.appendLine(`Line ${i} detected ${currentStructure.type} ${currentStructure.name}`);
    }

    // Parse functions only at brace depth 1
    if (braceDepth === 1) {
      // Skip lines with 'else if' or reserved keywords
      if (line.match(/\belse\s+if\b/)) {
        outputChannel.appendLine(`Line ${i} skipped (else if, depth ${braceDepth}): "${line}"`);
        continue;
      }

      // Debug potential function lines in actor.zs
      if (fileName.toLowerCase().endsWith('actor.zs') && line.match(/\w+\s+\w+\s*\(/)) {
        outputChannel.appendLine(`Debug actor.zs potential function line ${i} (depth ${braceDepth}): "${line}"`);
      }

      let match = funcRegex.exec(line);
      if (match) {
        let returnType = match[1] || 'void'; // Default to 'void' if no return type
        const name = match[2];
        const paramsStr = match[3].trim();

        // Validate function name
        if (name.match(/^(if|else|while|for|return|struct|class)$/)) {
          outputChannel.appendLine(`Line ${i} skipped (invalid function name, depth ${braceDepth}): "${line}"`);
          continue;
        }

        // Parse parameters
        const params = paramsStr ? paramsStr.split(/\s*,\s*/).filter(p => p) : [];
        const paramInfos = params.map(param => {
          const parts = param.trim().split(/\s+/);
          let type = parts[0];
          let nameAndDefault = parts.slice(1).join(' ');
          // Handle complex types like 'class<Actor>'
          if (type.startsWith('class<') && param.indexOf('>') !== -1) {
            const closeIndex = param.indexOf('>');
            type = param.substring(0, closeIndex + 1).trim();
            nameAndDefault = param.substring(closeIndex + 1).trim();
          }
          // Extract parameter name (before '=' if default exists)
          const nameMatch = nameAndDefault.match(/^(\w+)/);
          const paramName = nameMatch ? nameMatch[1] : nameAndDefault || 'param';
          return new vscode.ParameterInformation(paramName, type);
        });

        // Create signature with class/struct context
        const signatureLabel = `${returnType} ${name}(${paramsStr})`;
        const sig = new vscode.SignatureInformation(signatureLabel);
        sig.parameters = paramInfos;
        if (currentStructure.type && currentStructure.name) {
          sig.documentation = `Built-in function. Defined in: ${currentStructure.type} ${currentStructure.name}`;
        } else {
          sig.documentation = 'Built-in ZScript function';
        }

        functionSignatures.set(name, sig);
        functionsFound++;
        outputChannel.appendLine(`Found function: ${signatureLabel} at line ${i} (depth ${braceDepth})`);
      } else if (line.match(/\w+\s+\w+\s*\(/)) {
        outputChannel.appendLine(`Line ${i} partial function match (depth ${braceDepth}): "${line}"`);
      }
    } else {
      outputChannel.appendLine(`Line ${i} skipped (depth ${braceDepth}): "${line}"`);
    }

    // Count braces
    for (let char of line) {
      if (char === '{') {
        braceDepth++;
        outputChannel.appendLine(`Line ${i} braceDepth increased to ${braceDepth}: "${line}"`);
      } else if (char === '}') {
        braceDepth--;
        if (braceDepth < 0) braceDepth = 0; // Prevent negative depth
        outputChannel.appendLine(`Line ${i} braceDepth decreased to ${braceDepth}: "${line}"`);
        if (braceDepth === 0) {
          currentStructure = { type: null, name: null }; // Reset structure context
          outputChannel.appendLine(`Line ${i} exited structure context`);
        }
      }
    }
  }

  outputChannel.appendLine(`Parsed ${functionsFound} functions from ${fileName}`);
  return functionsFound;
}

// Parse the entire PK3
function parsePk3() {
  try {
    outputChannel.appendLine('Starting parsePk3 command');
    const pk3Path = vscode.workspace.getConfiguration('zscript').get('gzdoomPk3Path');
    outputChannel.appendLine(`PK3 path from settings: ${pk3Path}`);
    if (!pk3Path) {
      vscode.window.showErrorMessage('Set the "zscript.gzdoomPk3Path" in settings first.');
      outputChannel.appendLine('No PK3 path set');
      return;
    }

    outputChannel.appendLine(`Attempting to open PK3: ${pk3Path}`);
    const zip = new AdmZip(pk3Path);
    const entries = zip.getEntries();
    outputChannel.appendLine(`Found ${entries.length} entries in PK3`);
    functionSignatures.clear();
    let totalFunctions = 0;
    let filesProcessed = 0;

    // Log all entries for debugging
    outputChannel.appendLine('Listing all PK3 entries:');
    entries.forEach(entry => {
      outputChannel.appendLine(`PK3 entry: ${entry.entryName}`);
    });

    entries.forEach(entry => {
      const entryNameLower = entry.entryName.toLowerCase();
      if (entryNameLower.startsWith('zscript/') && !entry.isDirectory) {
        outputChannel.appendLine(`Found file in PK3: ${entry.entryName}`);
        if (!entryNameLower.endsWith('.txt')) {
          outputChannel.appendLine(`Processing ZScript file: ${entry.entryName}`);
          const text = zip.readAsText(entry);
          totalFunctions += parseZScriptText(text, entry.entryName);
          filesProcessed++;
        } else {
          outputChannel.appendLine(`Skipped text file: ${entry.entryName}`);
        }
      } else {
        outputChannel.appendLine(`Skipped non-ZScript file: ${entry.entryName}`);
      }
    });

    outputChannel.appendLine(`Processed ${filesProcessed} ZScript files with ${totalFunctions} functions`);
    outputChannel.appendLine(`Total function signatures: ${functionSignatures.size}`);
    vscode.window.showInformationMessage(`Parsed ${totalFunctions} built-in functions from gzdoom.pk3`);
  } catch (error) {
    vscode.window.showErrorMessage(`Error parsing gzdoom.pk3: ${error.message}`);
    outputChannel.appendLine(`Error parsing gzdoom.pk3: ${error.message}\n${error.stack}`);
  }
}

// List all zscript/ files and their first 20 lines
function listZScriptFiles() {
  try {
    outputChannel.appendLine('Starting listZScriptFiles command');
    const pk3Path = vscode.workspace.getConfiguration('zscript').get('gzdoomPk3Path');
    outputChannel.appendLine(`PK3 path from settings: ${pk3Path}`);
    if (!pk3Path) {
      vscode.window.showErrorMessage('Set the "zscript.gzdoomPk3Path" in settings first.');
      outputChannel.appendLine('No PK3 path set');
      return;
    }

    outputChannel.appendLine(`Attempting to open PK3: ${pk3Path}`);
    const zip = new AdmZip(pk3Path);
    const entries = zip.getEntries();
    outputChannel.appendLine(`Found ${entries.length} entries in PK3`);

    entries.forEach(entry => {
      const entryNameLower = entry.entryName.toLowerCase();
      if (entryNameLower.startsWith('zscript/') && !entry.isDirectory && !entryNameLower.endsWith('.txt')) {
        outputChannel.appendLine(`ZScript file: ${entry.entryName}`);
        const text = zip.readAsText(entry);
        const lines = text.split('\n').slice(0, 20);
        outputChannel.appendLine(`First 20 lines of ${entry.entryName}:`);
        lines.forEach((line, i) => {
          outputChannel.appendLine(`Line ${i}: ${line.trim()}`);
        });
      } else {
        outputChannel.appendLine(`Skipped file: ${entry.entryName}`);
      }
    });
  } catch (error) {
    vscode.window.showErrorMessage(`Error listing files in gzdoom.pk3: ${error.message}`);
    outputChannel.appendLine(`Error listing files in gzdoom.pk3: ${error.message}\n${error.stack}`);
  }
}

// Test parsing zscriptref.txt
function parseTestFile() {
  try {
    outputChannel.appendLine('Starting parseTestFile command');
    const testFilePath = 'c:/Users/mi/My Drive/_MyDoomProjects/ZScript-VSCode/zscriptref.txt';
    if (!fs.existsSync(testFilePath)) {
      vscode.window.showErrorMessage('Test file zscriptref.txt not found');
      outputChannel.appendLine('Test file not found: ' + testFilePath);
      return;
    }
    const text = fs.readFileSync(testFilePath, 'utf8');
    outputChannel.appendLine(`First 20 lines of zscriptref.txt:`);
    const lines = text.split('\n').slice(0, 20);
    lines.forEach((line, i) => {
      outputChannel.appendLine(`Line ${i}: ${line.trim()}`);
    });
    functionSignatures.clear();
    const functionsFound = parseZScriptText(text, 'zscriptref.txt');
    outputChannel.appendLine(`Parsed ${functionsFound} functions from test file`);
    outputChannel.appendLine(`Total function signatures: ${functionSignatures.size}`);
    vscode.window.showInformationMessage(`Parsed ${functionsFound} functions from zscriptref.txt`);
  } catch (error) {
    vscode.window.showErrorMessage(`Error parsing test file: ${error.message}`);
    outputChannel.appendLine(`Error parsing test file: ${error.message}\n${error.stack}`);
  }
}

// Extension activation
function activate(context) {
  try {
    outputChannel = vscode.window.createOutputChannel('ZScript Extension');
    outputChannel.appendLine('Extension activated: kaptainmicila.gzdoom-zscript');

    // Register commands
    const parsePk3Command = vscode.commands.registerCommand('zscript.parsePk3', () => {
      outputChannel.appendLine('Command zscript.parsePk3 triggered');
      parsePk3();
    });
    context.subscriptions.push(parsePk3Command);
    outputChannel.appendLine('Command zscript.parsePk3 registered');

    const listFilesCommand = vscode.commands.registerCommand('zscript.listFiles', () => {
      outputChannel.appendLine('Command zscript.listFiles triggered');
      listZScriptFiles();
    });
    context.subscriptions.push(listFilesCommand);
    outputChannel.appendLine('Command zscript.listFiles registered');

    const parseTestFileCommand = vscode.commands.registerCommand('zscript.parseTestFile', () => {
      outputChannel.appendLine('Command zscript.parseTestFile triggered');
      parseTestFile();
    });
    context.subscriptions.push(parseTestFileCommand);
    outputChannel.appendLine('Command zscript.parseTestFile registered');

    // Register signature help provider with named argument support
    context.subscriptions.push(vscode.languages.registerSignatureHelpProvider('zscript', {
      provideSignatureHelp(document, position, token, sigContext) {
        const lineText = document.lineAt(position).text.substring(0, position.character);

        // Find function name before '('
        const funcMatch = lineText.match(/(\w+)\s*\(\s*[^)]*$/);
        if (!funcMatch) return null;

        const funcName = funcMatch[1];
        if (!functionSignatures.has(funcName)) {
          outputChannel.appendLine(`No signature found for function: ${funcName}`);
          return null;
        }

        const signature = functionSignatures.get(funcName);

        // Get args text inside parentheses
        const openParenPos = lineText.lastIndexOf('(');
        const argsText = lineText.substring(openParenPos + 1);

        // Split args by ','
        const args = argsText.split(',').map(a => a.trim()).filter(a => a);

        // Process args to find current index
        let currentIndex = 0;
        for (let i = 0; i < args.length - 1; i++) {
          const arg = args[i];
          const namedMatch = arg.match(/^(\w+):/);
          if (namedMatch) {
            const paramName = namedMatch[1];
            const paramIndex = signature.parameters.findIndex(param => param.label === paramName);
            if (paramIndex !== -1) {
              currentIndex = paramIndex + 1;
            }
          } else if (arg) {
            currentIndex++;
          }
        }

        // Last arg (where cursor is)
        const lastArg = args[args.length - 1] || '';
        const namedMatch = lastArg.match(/^(\w+):/);
        let activeParameter;
        if (namedMatch) {
          const paramName = namedMatch[1];
          const paramIndex = signature.parameters.findIndex(param => param.label === paramName);
          if (paramIndex !== -1) {
            activeParameter = paramIndex;
          } else {
            activeParameter = currentIndex;
          }
        } else {
          activeParameter = currentIndex;
        }

        const help = new vscode.SignatureHelp();
        help.signatures = [signature];
        help.activeSignature = 0;
        help.activeParameter = activeParameter;

        outputChannel.appendLine(`Providing signature help for ${funcName}, active param index: ${activeParameter}`);
        return help;
      }
    }, '(', ',', ':'));

    // Register completion item provider
    context.subscriptions.push(vscode.languages.registerCompletionItemProvider('zscript', {
      provideCompletionItems(document, position, token, context) {
        const lineText = document.lineAt(position).text.substring(0, position.character);
        const wordMatch = lineText.match(/\b(\w*)$/);
        if (!wordMatch) return [];

        const prefix = wordMatch[1];
        const completions = [];

        for (const [name, signature] of functionSignatures) {
          if (name.startsWith(prefix)) {
            const item = new vscode.CompletionItem(name, vscode.CompletionItemKind.Function);
            item.detail = signature.label;
            item.documentation = new vscode.MarkdownString(signature.documentation);
            completions.push(item);
          }
        }

        outputChannel.appendLine(`Providing ${completions.length} completion items for prefix: ${prefix}`);
        return completions;
      }
    }, 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ'));

    outputChannel.appendLine('All commands and providers registered successfully');
  } catch (error) {
    outputChannel.appendLine(`Extension activation failed: ${error.message}\n${error.stack}`);
    vscode.window.showErrorMessage(`ZScript Extension activation failed: ${error.message}`);
  }
}

exports.activate = activate;