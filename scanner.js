#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

// ANSI codes for terminal color output
const colors = {
    reset: "\x1b[0m",
    red: "\x1b[31m",
    green: "\x1b[32m",
    yellow: "\x1b[33m",
    blue: "\x1b[34m",
    magenta: "\x1b[35m",
    cyan: "\x1b[36m",
    bold: "\x1b[1m"
};

// ==========================================
// 1. File System & Parsing Utilities
// ==========================================

// Recursive Solidity file search
function findSolFiles(dir, fileList = []) {
    // 웹 버전과 동일하게 'lib' 폴더를 제외 목록에서 제거하여 외부 라이브러리도 스캔에 포함
    const ignoredDirs = ['node_modules', 'test', 'out', 'artifacts', 'cache', 'typechain-types', '.git', 'coverage'];
    if (!fs.existsSync(dir)) return fileList;

    const files = fs.readdirSync(dir);
    for (const file of files) {
        const fullPath = path.join(dir, file);
        const stat = fs.statSync(fullPath);

        if (stat.isDirectory()) {
            if (!ignoredDirs.includes(file)) {
                findSolFiles(fullPath, fileList);
            }
        } else if (file.endsWith('.sol')) {
            fileList.push(fullPath);
        }
    }
    return fileList;
}

// Find configuration file (Hardhat/Foundry) - Updated to search from target dir upwards
function findConfig(targetDir) {
    const configFiles = ['foundry.toml', 'hardhat.config.js', 'hardhat.config.ts'];

    let currentDir = targetDir;
    // 드래그한 폴더부터 상위로 3단계 정도 탐색 (src 폴더 드롭 등의 케이스 대비)
    for (let i = 0; i < 3; i++) {
        if (!fs.existsSync(currentDir) || !fs.statSync(currentDir).isDirectory()) {
            currentDir = path.dirname(currentDir);
            continue;
        }
        for (const file of configFiles) {
            const fullPath = path.join(currentDir, file);
            if (fs.existsSync(fullPath)) {
                return { name: file, content: fs.readFileSync(fullPath, 'utf8') };
            }
        }
        const parentDir = path.dirname(currentDir);
        if (parentDir === currentDir) break; // 루트 도달
        currentDir = parentDir;
    }

    // 못 찾으면 스크립트 실행 디렉토리(process.cwd)도 마지막으로 확인
    for (const file of configFiles) {
        const fullPath = path.join(process.cwd(), file);
        if (fs.existsSync(fullPath)) {
            return { name: file, content: fs.readFileSync(fullPath, 'utf8') };
        }
    }
    return { name: 'None', content: '' };
}

// ==========================================
// 2. Multi-File Core Analysis Logic
// ==========================================

function analyzeProject(solFiles, config) {
    const globalEntities = {};
    const globalStructs = {};
    const freeCodeByFile = {};

    let activeVersion = "Unknown";
    let isViaIrEnabled = null;
    let configVersion = null;

    // Parse config
    if (config.content && config.content.trim()) {
        const cleanedConfig = config.content.replace(/\/\*[\s\S]*?\*\/|\/\/.*/g, '');

        if (cleanedConfig.includes('via_ir') || cleanedConfig.includes('[profile.')) {
            if (/via_ir\s*=\s*true/.test(cleanedConfig)) isViaIrEnabled = true;
            else if (/via_ir\s*=\s*false/.test(cleanedConfig)) isViaIrEnabled = false;

            const solcMatch = cleanedConfig.match(/solc_version\s*=\s*['"]([^'"]+)['"]/);
            if (solcMatch) configVersion = solcMatch[1];
        }
        else if (cleanedConfig.includes('hardhat') || cleanedConfig.includes('solidity')) {
            if (/viaIR\s*:\s*true/.test(cleanedConfig)) isViaIrEnabled = true;
            else if (/viaIR\s*:\s*false/.test(cleanedConfig)) isViaIrEnabled = false;

            const hardhatVerMatch = cleanedConfig.match(/version\s*:\s*['"]([^'"]+)['"]/);
            const hardhatVerMatchAlt = cleanedConfig.match(/solidity\s*:\s*['"]([^'"]+)['"]/);
            if (hardhatVerMatch) configVersion = hardhatVerMatch[1];
            else if (hardhatVerMatchAlt) configVersion = hardhatVerMatchAlt[1];
        }
    }

    // Pass 1: Global Discovery (Parse all files to build the global registry)
    for (const filePath of solFiles) {
        const sourceCode = fs.readFileSync(filePath, 'utf8');
        // Clean comments and strings
        let cleanedSol = sourceCode.replace(/\/\*[\s\S]*?\*\/|\/\/.*/g, '').replace(/(["'])(?:(?=(\\?))\2.)*?\1/g, '');

        if (activeVersion === "Unknown") {
            const pragmaMatch = cleanedSol.match(/pragma\s+solidity\s+([^;]+);/);
            if (pragmaMatch) activeVersion = pragmaMatch[1].trim();
        }

        // Extract structs
        const structRegex = /struct\s+([a-zA-Z0-9_]+)\s*\{([^}]+)\}/g;
        for (const match of cleanedSol.matchAll(structRegex)) {
            const structName = match[1];
            const structBody = match[2];
            const members = {};
            const statements = structBody.split(';');
            for (const stmt of statements) {
                const trimmed = stmt.trim();
                if (!trimmed) continue;
                const parts = trimmed.split(/\s+/);
                if (parts.length >= 2) {
                    const varName = parts.pop();
                    const typeStr = parts.join('').replace(/\s+/g, '');
                    members[varName] = typeStr;
                }
            }
            globalStructs[structName] = members;
        }

        // Extract entities (contracts, libraries, interfaces)
        const regex = /(?:abstract\s+)?(contract|library|interface)\s+([a-zA-Z0-9_]+)(?:\s+is\s+([^{]+))?\s*\{/g;
        let match;
        let lastEnd = 0;
        let freeCode = "";

        while ((match = regex.exec(cleanedSol)) !== null) {
            const type = match[1];
            const name = match[2];
            const bases = match[3] ? match[3].split(',').map(b => b.replace(/\s+/g, '').trim()).filter(Boolean) : [];

            freeCode += cleanedSol.substring(lastEnd, match.index);

            let braceCount = 1;
            let i = match.index + match[0].length;
            let bodyStart = i;
            while (i < cleanedSol.length && braceCount > 0) {
                if (cleanedSol[i] === '{') braceCount++;
                else if (cleanedSol[i] === '}') braceCount--;
                i++;
            }
            const body = cleanedSol.substring(bodyStart, i > bodyStart ? i - 1 : bodyStart);

            if (!globalEntities[name]) globalEntities[name] = [];
            globalEntities[name].push({ type, name, bases, body, filePath });

            lastEnd = i;
            regex.lastIndex = i; // Prevent infinite loops
        }
        freeCode += cleanedSol.substring(lastEnd);
        freeCodeByFile[filePath] = freeCode;
    }

    if (configVersion) activeVersion = configVersion;

    const isVulnerableVersion = /(0\.8\.(28|29|30|31|32|33))/.test(activeVersion) ||
        (/(\^0\.8\.(2[0-8]))/.test(activeVersion) && !configVersion);

    // Recursive helper to build flattened body resolving bases from ANY file
    function getFullBody(entityName, specificEntity = null, visited = new Set()) {
        const cleanName = entityName.split('(')[0].split('.').pop().trim();
        const visitKey = specificEntity ? specificEntity.filePath + ":" + specificEntity.name : cleanName;

        if (visited.has(visitKey)) return "";
        visited.add(visitKey);

        let full = "";

        if (specificEntity) {
            full += specificEntity.body + "\n";
            for (let baseName of specificEntity.bases) {
                full += getFullBody(baseName, null, visited) + "\n";
            }
        } else {
            const entities = globalEntities[cleanName];
            if (!entities) return "";

            for (const e of entities) {
                const eKey = e.filePath + ":" + e.name;
                if (visited.has(eKey)) continue;
                visited.add(eKey);

                full += e.body + "\n";
                for (let baseName of e.bases) {
                    full += getFullBody(baseName, null, visited) + "\n";
                }
            }
        }
        return full;
    }

    const projectCollisions = [];

    // Pass 2: Contextual Analysis per Physical Contract Entity
    for (const [cName, entityList] of Object.entries(globalEntities)) {
        for (const cEntity of entityList) {
            if (cEntity.type !== 'contract') continue;

            let visited = new Set();
            let fullBody = getFullBody(cName, cEntity, visited);

            // Include free functions from the same file
            let contractScopeBody = fullBody + "\n" + (freeCodeByFile[cEntity.filePath] || "");

            // Recursively pull in libraries used from ANY file in the project
            let addedLibs;
            do {
                addedLibs = false;
                for (const libName in globalEntities) {
                    if (globalEntities[libName][0].type === 'library' && !visited.has(libName)) {
                        const libRegex = new RegExp(`\\b${libName}\\b`);
                        if (libRegex.test(contractScopeBody)) {
                            contractScopeBody += "\n" + getFullBody(libName, null, visited);
                            addedLibs = true;
                        }
                    }
                }
            } while (addedLibs);

            let creationCode = "";
            let runtimeCode = "";

            // Scope Separation (Creation vs Runtime)
            const runtimeBlockRegex = /\b(?:function|modifier|fallback|receive)\b[^{]*\{/g;
            let lastIdx = 0;
            let match;
            while ((match = runtimeBlockRegex.exec(contractScopeBody)) !== null) {
                creationCode += contractScopeBody.substring(lastIdx, match.index);
                let start = match.index;
                let braceStart = start + match[0].length - 1;
                let braceCount = 1;
                let i = braceStart + 1;
                while (i < contractScopeBody.length && braceCount > 0) {
                    if (contractScopeBody[i] === '{') braceCount++;
                    else if (contractScopeBody[i] === '}') braceCount--;
                    i++;
                }
                runtimeCode += contractScopeBody.substring(start, i) + "\n";
                lastIdx = i;
                runtimeBlockRegex.lastIndex = i;
            }
            creationCode += contractScopeBody.substring(lastIdx);

            const allExprRegexes = [
                /delete\s+([a-zA-Z0-9_]+(?:(?:\.[a-zA-Z0-9_]+)|(?:\[.*?\]))*)/g,
                /([a-zA-Z0-9_]+(?:(?:\.[a-zA-Z0-9_]+)|(?:\[.*?\]))*)\.pop\s*\(\s*\)/g,
                /([a-zA-Z0-9_]+(?:(?:\.[a-zA-Z0-9_]+)|(?:\[.*?\]))*)\s*=(?!=)[^;]+;/g
            ];

            const allRawMatches = [];
            allExprRegexes.forEach(regex => {
                for (const m of contractScopeBody.matchAll(regex)) {
                    allRawMatches.push(m[1].trim());
                }
            });

            const rootVarsSet = new Set(allRawMatches.map(expr => {
                const m = expr.match(/^([a-zA-Z0-9_]+)/);
                return m ? m[1] : null;
            }).filter(Boolean));

            const varsInfo = {};

            rootVarsSet.forEach(varName => {
                const declRegex = new RegExp(
                    `(?:(mapping\\s*\\([^{};]+\\))|([a-zA-Z0-9_]+(?:\\s*\\[.*?\\])*))` +
                    `\\s+` +
                    `((?:(?:public|private|internal|transient|constant|immutable|memory|storage|calldata)\\s+)*)` +
                    `\\b${varName}\\b\\s*(?:=|;|,|\\))`
                );

                const declMatch = contractScopeBody.match(declRegex);
                if (declMatch) {
                    varsInfo[varName] = {
                        type: (declMatch[1] || declMatch[2]).replace(/\s+/g, ''),
                        isTransient: (declMatch[3] || "").includes('transient'),
                    };
                }
            });

            const checkScope = (scopeName, scopeCode) => {
                const clearExprs = [];

                const deleteRegex = /delete\s+([a-zA-Z0-9_]+(?:(?:\.[a-zA-Z0-9_]+)|(?:\[.*?\]))*)/g;
                for (const m of scopeCode.matchAll(deleteRegex)) {
                    clearExprs.push({ text: m[1].trim(), kind: 'delete' });
                }
                const popRegex = /([a-zA-Z0-9_]+(?:(?:\.[a-zA-Z0-9_]+)|(?:\[.*?\]))*)\.pop\s*\(\s*\)/g;
                for (const m of scopeCode.matchAll(popRegex)) {
                    clearExprs.push({ text: m[1].trim(), kind: 'pop' });
                }
                const assignRegex = /([a-zA-Z0-9_]+(?:(?:\.[a-zA-Z0-9_]+)|(?:\[.*?\]))*)\s*=(?!=)[^;]+;/g;
                for (const m of scopeCode.matchAll(assignRegex)) {
                    clearExprs.push({ text: m[1].trim(), kind: 'assign' });
                }

                if (clearExprs.length === 0) return;

                const expandedTypeMap = {};
                const addExpandedType = (type, exprStr, isTransient) => {
                    if (!expandedTypeMap[type]) expandedTypeMap[type] = { transient: new Set(), persistent: new Set() };
                    if (isTransient) expandedTypeMap[type].transient.add(exprStr);
                    else expandedTypeMap[type].persistent.add(exprStr);
                };

                clearExprs.forEach(exprObj => {
                    const expr = exprObj.text;
                    const kind = exprObj.kind;

                    const rootMatch = expr.match(/^([a-zA-Z0-9_]+)/);
                    if (!rootMatch) return;
                    const rootVar = rootMatch[1];
                    const vInfo = varsInfo[rootVar];
                    if (!vInfo) return;

                    let currentType = vInfo.type;
                    const isTransient = vInfo.isTransient;

                    const accessRegex = /(?:\.([a-zA-Z0-9_]+))|(?:\[.*?\])/g;
                    let accMatch;
                    const accessStr = expr.substring(rootVar.length);

                    while ((accMatch = accessRegex.exec(accessStr)) !== null) {
                        const access = accMatch[0];
                        if (access.startsWith('[')) {
                            if (currentType.endsWith(']')) {
                                const lastBracket = currentType.lastIndexOf('[');
                                currentType = currentType.substring(0, lastBracket);
                            } else if (currentType.includes('=>')) {
                                const arrowIdx = currentType.indexOf('=>');
                                const endParen = currentType.lastIndexOf(')');
                                if (arrowIdx !== -1) {
                                    currentType = endParen !== -1
                                        ? currentType.substring(arrowIdx + 2, endParen).trim()
                                        : currentType.substring(arrowIdx + 2).trim();
                                }
                            }
                        } else if (access.startsWith('.')) {
                            const member = accMatch[1];
                            if (globalStructs[currentType] && globalStructs[currentType][member]) {
                                currentType = globalStructs[currentType][member];
                            }
                        }
                    }

                    if (kind === 'assign') {
                        const baseTypesToClear = [];
                        const searchDynamicArrays = (t, visited) => {
                            if (visited.has(t)) return;
                            visited.add(t);
                            if (t.endsWith(']')) {
                                const lastBracket = t.lastIndexOf('[');
                                if (lastBracket > 0) baseTypesToClear.push(t.substring(0, lastBracket));
                            } else if (globalStructs[t]) {
                                Object.values(globalStructs[t]).forEach(member => searchDynamicArrays(member, visited));
                            }
                        };
                        searchDynamicArrays(currentType, new Set());
                        if (baseTypesToClear.length === 0) return;

                        baseTypesToClear.forEach(t => {
                            addExpandedType(t, `${expr} = ... (Array Shrink)`, isTransient);
                        });
                        return;
                    } else if (kind === 'pop') {
                        if (currentType.endsWith(']')) {
                            const lastBracket = currentType.lastIndexOf('[');
                            if (lastBracket > 0) currentType = currentType.substring(0, lastBracket);
                        }
                    }

                    const visitedTypes = new Set();
                    const queue = [currentType];

                    while (queue.length > 0) {
                        let t = queue.shift();
                        t = t.replace(/\s+/g, '');
                        if (visitedTypes.has(t)) continue;
                        visitedTypes.add(t);

                        let displayExpr = expr;
                        if (kind === 'pop') displayExpr += '.pop()';
                        else displayExpr = 'delete ' + displayExpr;

                        addExpandedType(t, displayExpr, isTransient);

                        if (t.endsWith(']')) {
                            if (!visitedTypes.has('uint256')) {
                                queue.push('uint256');
                            }
                            const lastBracket = t.lastIndexOf('[');
                            if (lastBracket > 0) {
                                queue.push(t.substring(0, lastBracket));
                            }
                        }

                        if (globalStructs[t]) {
                            Object.values(globalStructs[t]).forEach(memberType => queue.push(memberType));
                        }

                        if (t.includes('=>')) {
                            const arrowIdx = t.indexOf('=>');
                            const endParen = t.lastIndexOf(')');
                            if (arrowIdx !== -1) {
                                queue.push(endParen !== -1
                                    ? t.substring(arrowIdx + 2, endParen).trim()
                                    : t.substring(arrowIdx + 2).trim());
                            }
                        }
                    }
                });

                Object.keys(expandedTypeMap).forEach(type => {
                    const transVars = Array.from(expandedTypeMap[type].transient);
                    const persisVars = Array.from(expandedTypeMap[type].persistent);

                    if (transVars.length > 0 && persisVars.length > 0) {
                        projectCollisions.push({
                            contract: cName,
                            filePath: cEntity.filePath,
                            scope: scopeName,
                            type,
                            transientVars: transVars,
                            persistentVars: persisVars
                        });
                    }
                });
            };

            checkScope("Creation Code (Constructor/Init)", creationCode);
            checkScope("Runtime Code (Functions)", runtimeCode);
        }
    }

    let status = 'SAFE';
    let reason = '';

    if (projectCollisions.length === 0) {
        status = 'SAFE';
        reason = 'No collision pattern causing the bug was found.';
    } else if (!isVulnerableVersion) {
        status = 'WARNING';
        reason = `Collision pattern found, but the detected compiler version (${activeVersion}) is not in the vulnerable range (0.8.28 ~ 0.8.33).`;
    } else if (isViaIrEnabled === false) {
        status = 'SAFE';
        reason = 'Collision pattern and vulnerable version detected, but it is safe because via-ir (IR Pipeline) is explicitly disabled in the config.';
    } else if (isViaIrEnabled === true) {
        status = 'VULNERABLE';
        reason = 'Vulnerable version, collision pattern, and via-ir activation all confirmed. A critical bug may occur.';
    } else {
        status = 'WARNING';
        reason = 'Vulnerable version and collision pattern detected. Vulnerability triggers if via-ir is enabled in the config.';
    }

    return { status, reason, collisions: projectCollisions };
}

// ==========================================
// 3. Execution Entry Point
// ==========================================

function run() {
    console.log(`${colors.cyan}${colors.bold}🔍 Transient Storage Collision Scanner (Multi-File Context CLI)${colors.reset}`);
    console.log(`${colors.cyan}==============================================================${colors.reset}\n`);

    // 드래그 앤 드롭 인자 처리 (따옴표 제거 포함)
    let targetPath = process.cwd();
    if (process.argv.length > 2) {
        let argPath = process.argv[2];
        if ((argPath.startsWith('"') && argPath.endsWith('"')) || (argPath.startsWith("'") && argPath.endsWith("'"))) {
            argPath = argPath.slice(1, -1);
        }
        targetPath = path.resolve(process.cwd(), argPath);
    }

    const config = findConfig(targetPath);
    if (config.name !== 'None') {
        console.log(`[+] Configuration file detected: ${colors.yellow}${config.name}${colors.reset}`);
    } else {
        console.log(`[!] Warning: Hardhat or Foundry configuration file not found.`);
    }

    console.log(`[+] Scanning target directory/file... (${targetPath})`);

    let solFiles = [];
    if (fs.existsSync(targetPath)) {
        if (fs.statSync(targetPath).isFile()) {
            if (targetPath.endsWith('.sol')) solFiles.push(targetPath);
        } else {
            solFiles = findSolFiles(targetPath);
        }
    }

    if (solFiles.length === 0) {
        console.log(`\n${colors.red}[-] No .sol files found in the specified path.${colors.reset}`);
        return;
    }

    console.log(`[+] Starting global analysis of ${solFiles.length} .sol files...\n`);

    const result = analyzeProject(solFiles, config);

    if (result.status === 'VULNERABLE' || result.status === 'WARNING') {
        const color = result.status === 'VULNERABLE' ? colors.red : colors.yellow;
        console.log(`${color}${colors.bold}[${result.status}] Project Analysis Completed${colors.reset}`);
        console.log(`  └─ Reason: ${result.reason}\n`);

        // Group collisions by Contract and File path
        const groupedCollisions = {};
        result.collisions.forEach(col => {
            const key = `${col.contract} (${col.filePath})`;
            if (!groupedCollisions[key]) {
                groupedCollisions[key] = {
                    contract: col.contract,
                    filePath: col.filePath,
                    issues: []
                };
            }
            groupedCollisions[key].issues.push(col);
        });

        for (const [key, data] of Object.entries(groupedCollisions)) {
            const relativePath = path.relative(process.cwd(), data.filePath);
            console.log(`${colors.magenta}${colors.bold}Contract: ${data.contract}${colors.reset} (in ${relativePath})`);

            data.issues.forEach((col, idx) => {
                console.log(`  └─ [Collision ${idx + 1}] Scope: ${col.scope} | Type: ${colors.cyan}${col.type}${colors.reset}`);
                console.log(`     ├─ Cleared Transient Variables: ${col.transientVars.join(', ')}`);
                console.log(`     └─ Cleared Persistent Variables: ${col.persistentVars.join(', ')}`);
            });
            console.log('');
        }
    } else {
        console.log(`${colors.green}${colors.bold}[SAFE]${colors.reset}`);
        console.log(`  └─ Reason: ${result.reason}\n`);
    }

    console.log(`${colors.cyan}==============================================================${colors.reset}`);
    console.log(`${colors.bold}📊 Analysis Results Summary${colors.reset}`);
    console.log(`- Project Status : ${result.status === 'VULNERABLE' ? colors.red + result.status :
        result.status === 'WARNING' ? colors.yellow + result.status :
            colors.green + result.status
        }${colors.reset}`);
    console.log(`- Total Conflicts Detected : ${result.collisions.length}`);
    console.log(`${colors.cyan}==============================================================${colors.reset}`);

    if (result.status === 'VULNERABLE') {
        process.exit(1);
    } else {
        process.exit(0);
    }
}

// Execute
run();