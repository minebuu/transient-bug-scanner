import React, { useState, useEffect, useRef } from 'react';
import {
  ShieldAlert, AlertTriangle, CheckCircle, Info, Code, FileJson,
  Settings, FolderUp, ChevronRight, LayoutGrid,
  Lock, WifiOff, Github
} from 'lucide-react';

// Core analysis logic (state independent)
const performAnalysis = (sourceCode, configStr) => {
  try {
    let cleanedSol = sourceCode.replace(/\/\*[\s\S]*?\*\/|\/\/.*/g, '').replace(/(["'])(?:(?=(\\?))\2.)*?\1/g, '');
    const pragmaMatch = cleanedSol.match(/pragma\s+solidity\s+([^;]+);/);
    let activeVersion = pragmaMatch ? pragmaMatch[1].trim() : "Unknown";

    let framework = 'none';
    let isViaIrEnabled = null;
    let configVersion = null;

    if (configStr && configStr.trim()) {
      const cleanedConfig = configStr.replace(/\/\*[\s\S]*?\*\/|\/\/.*/g, '');

      if (cleanedConfig.includes('via_ir') || cleanedConfig.includes('[profile.')) {
        framework = 'foundry';
        if (/via_ir\s*=\s*true/.test(cleanedConfig)) isViaIrEnabled = true;
        else if (/via_ir\s*=\s*false/.test(cleanedConfig)) isViaIrEnabled = false;

        const solcMatch = cleanedConfig.match(/solc_version\s*=\s*['"]([^'"]+)['"]/);
        if (solcMatch) configVersion = solcMatch[1];
      }
      else if (cleanedConfig.includes('hardhat') || cleanedConfig.includes('solidity')) {
        framework = 'hardhat';
        if (/viaIR\s*:\s*true/.test(cleanedConfig)) isViaIrEnabled = true;
        else if (/viaIR\s*:\s*false/.test(cleanedConfig)) isViaIrEnabled = false;

        const hardhatVerMatch = cleanedConfig.match(/version\s*:\s*['"]([^'"]+)['"]/);
        const hardhatVerMatchAlt = cleanedConfig.match(/solidity\s*:\s*['"]([^'"]+)['"]/);
        if (hardhatVerMatch) configVersion = hardhatVerMatch[1];
        else if (hardhatVerMatchAlt) configVersion = hardhatVerMatchAlt[1];
      }
    }

    if (configVersion) activeVersion = configVersion;

    const isVulnerableVersion = /(0\.8\.(28|29|30|31|32|33))/.test(activeVersion) ||
      (/(\^0\.8\.(2[0-8]))/.test(activeVersion) && !configVersion);

    // 1. Extract Global Struct Definitions
    const structs = {};
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
      structs[structName] = members;
    }

    // 2. Extract Entities (Contracts/Libraries) & Free Code
    function extractEntities(code) {
      const entities = {};
      const regex = /(?:abstract\s+)?(contract|library|interface)\s+([a-zA-Z0-9_]+)(?:\s+is\s+([^{]+))?\s*\{/g;
      let match;
      while ((match = regex.exec(code)) !== null) {
        const type = match[1];
        const name = match[2];
        const bases = match[3] ? match[3].split(',').map(b => b.trim()) : [];

        let braceCount = 1;
        let i = match.index + match[0].length;
        let bodyStart = i;
        while (i < code.length && braceCount > 0) {
          if (code[i] === '{') braceCount++;
          else if (code[i] === '}') braceCount--;
          i++;
        }
        const body = code.substring(bodyStart, i > bodyStart ? i - 1 : bodyStart);
        entities[name] = { type, name, bases, body, start: match.index, end: i };
      }

      let lastEnd = 0;
      let freeCode = "";
      const sortedEntities = Object.values(entities).sort((a, b) => a.start - b.start);
      for (const e of sortedEntities) {
        freeCode += code.substring(lastEnd, e.start);
        lastEnd = e.end;
      }
      freeCode += code.substring(lastEnd);

      return { entities, freeCode };
    }

    const { entities, freeCode } = extractEntities(cleanedSol);

    function getFullBody(entityName, visited = new Set()) {
      if (visited.has(entityName)) return "";
      visited.add(entityName);

      const e = entities[entityName];
      if (!e) return "";

      let full = e.body + "\n";
      for (const base of e.bases) {
        const baseName = base.split('(')[0].trim();
        full += getFullBody(baseName, visited) + "\n";
      }
      return full;
    }

    const contractKeys = Object.keys(entities).filter(k => entities[k].type === 'contract');
    const analysisBlocks = [];

    if (contractKeys.length === 0) {
      analysisBlocks.push({ name: "Global Snippet", body: cleanedSol });
    } else {
      for (const cName of contractKeys) {
        let visited = new Set();
        let fullBody = getFullBody(cName, visited);
        // Free functions can be inlined into any contract, so merge them
        let contractScopeBody = fullBody + "\n" + freeCode;

        // [Case 1 Fix] When referencing a library, pull its code into the current contract context
        let addedLibs;
        do {
          addedLibs = false;
          for (const libName in entities) {
            if (entities[libName].type === 'library' && !visited.has(libName)) {
              const regex = new RegExp(`\\b${libName}\\b`);
              if (regex.test(contractScopeBody)) {
                contractScopeBody += "\n" + getFullBody(libName, visited);
                addedLibs = true;
              }
            }
          }
        } while (addedLibs);

        analysisBlocks.push({ name: cName, body: contractScopeBody });
      }
    }

    const totalCollisions = [];
    const allVarsInfo = [];

    // 3. Separate scopes per contract and start isolated analysis
    for (const block of analysisBlocks) {
      const cName = block.name;
      const contractScopeBody = block.body;

      // [Case 2 Fix] Physical separation of Creation Code vs Runtime Code
      let creationCode = "";
      let runtimeCode = "";

      // Extract runtime blocks (functions, modifiers, etc.) - the rest remains in the constructor area
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

      // Extract variable info (Variable declarations can be in the Creation area, so parse based on the entire body)
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
        // Improved to cover mapping parameters and various forms (allowing commas, closing parentheses)
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
          if (!allVarsInfo.some(v => v.name === varName && v.contract === cName)) {
            allVarsInfo.push({ name: varName, contract: cName, isTransient: varsInfo[varName].isTransient });
          }
        }
      });

      // Function to inspect each separated scope independently
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

          // Progressive access type inference
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
              if (structs[currentType] && structs[currentType][member]) {
                currentType = structs[currentType][member];
              }
            }
          }

          // [Case 2 Fix] Detect element clearing behavior due to array shrinking upon assignment
          if (kind === 'assign') {
            const baseTypesToClear = [];
            const searchDynamicArrays = (t, visited) => {
              if (visited.has(t)) return;
              visited.add(t);
              if (t.endsWith(']')) {
                const lastBracket = t.lastIndexOf('[');
                if (lastBracket > 0) baseTypesToClear.push(t.substring(0, lastBracket));
              } else if (structs[t]) {
                Object.values(structs[t]).forEach(member => searchDynamicArrays(member, visited));
              }
            };
            searchDynamicArrays(currentType, new Set());
            if (baseTypesToClear.length === 0) return; // Ignore simple assignments that do not involve dynamic arrays

            baseTypesToClear.forEach(t => {
              addExpandedType(t, `${expr} = ... (Array Shrink)`, isTransient);
            });
            return; // Assignment processing is complete
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

            if (structs[t]) {
              Object.values(structs[t]).forEach(memberType => queue.push(memberType));
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

          // Both must occur within the same scope (same Yul Object) for a collision to be established!
          if (transVars.length > 0 && persisVars.length > 0) {
            totalCollisions.push({
              contract: cName,
              scope: scopeName,
              type,
              transientVars: transVars,
              persistentVars: persisVars
            });
          }
        });
      };

      // Treat the two scopes as completely separate for analysis (Case 2 fix)
      checkScope("Creation Code (Constructor/Init)", creationCode);
      checkScope("Runtime Code (Functions)", runtimeCode);
    }

    let status = 'SAFE';
    let reason = '';

    if (totalCollisions.length === 0) {
      status = 'SAFE';
      reason = 'No collision pattern causing the bug was found.';
    } else if (!isVulnerableVersion) {
      status = 'WARNING';
      reason = 'Collision pattern found, but the detected compiler version is not in the vulnerable range (0.8.28 ~ 0.8.33).';
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

    return { status, reason, activeVersion, isVulnerableVersion, framework, isViaIrEnabled, varsInfo: allVarsInfo, collisions: totalCollisions, configVersion };
  } catch (e) {
    return { status: 'ERROR', reason: e.message };
  }
};

export default function App() {
  const [appMode, setAppMode] = useState('single');

  const [activeTab, setActiveTab] = useState('solidity');

  const [code, setCode] = useState(`// SPDX-License-Identifier: MIT
pragma solidity ^0.8.33;

/*
    all_cases_named.sol

    Goal
    - Bundle “collision candidate” cases and “intentional no-collision” cases into a single file.
    - Make it obvious from function names whether a trigger is a collision candidate or not.

    Naming convention
    - triggerPersistentClear__COLLISION(): a path that can generate a persistent clearing helper.
    - triggerTransientDelete__COLLISION(): a transient delete path (i.e., generates a transient clearing helper).
    - trigger*__NO_COLLISION(): intentionally no-collision (e.g., creation/runtime separation assumption, or avoiding \`delete\`).
*/

// =======================================================
// Case01) (COLLISION candidate) persistent clearing + transient delete
// =======================================================
contract Case01_PersistentFirst {
    address public owner; // likely slot0
    mapping(uint256 => address) public delegates;
    address transient _lock;

    constructor() {
        owner = msg.sender;
    }

    function triggerPersistentClear__COLLISION(uint256 id) external {
        delete delegates[id]; // persistent clearing (address)
    }

    function triggerTransientDelete__COLLISION() external {
        require(_lock == address(0), "locked");
        _lock = msg.sender;
        delete _lock; // transient delete (address)
    }
}

// =======================================================
// Case02) (COLLISION candidate) transient delete first + persistent clearing
// =======================================================
contract Case02_TransientFirst {
    mapping(uint256 => address) public approvals;
    address transient _caller;

    function triggerTransientDelete__COLLISION() external {
        require(_caller == address(0), "locked");
        _caller = msg.sender;
        delete _caller; // transient delete first
    }

    function triggerPersistentClear__COLLISION(uint256 id) external {
        delete approvals[id]; // persistent clearing (address)
    }
}

// =======================================================
// Case03) (COLLISION candidate) delete array element + transient delete
// =======================================================
contract Case03_DeleteArrayElement {
    uint256[] public arr;
    uint256 transient _scratch;

    function push(uint256 x) external {
        arr.push(x);
    }

    function triggerPersistentClear__COLLISION(uint256 i) external {
        delete arr[i]; // persistent clearing (uint256 element)
    }

    function triggerTransientDelete__COLLISION() external {
        _scratch = 1;
        delete _scratch; // transient delete (uint256)
    }
}

// =======================================================
// Case04) (COLLISION candidate) array pop (shrinking) + transient delete
// =======================================================
contract Case04_ArrayPopShrink {
    address[] public list;
    address transient _tmp;

    function add(address a) external {
        list.push(a);
    }

    function triggerPersistentClear__COLLISION() external {
        list.pop(); // shrink path (persistent clearing)
    }

    function triggerTransientDelete__COLLISION() external {
        _tmp = msg.sender;
        delete _tmp; // transient delete (address)
    }
}

// =======================================================
// Case05) (COLLISION candidate) delete dynamic array + transient delete
// =======================================================
contract Case05_DeleteDynamicArray {
    uint256[] public nums;
    uint256 transient _tmp;

    function seed() external {
        nums.push(1);
        nums.push(2);
    }

    function triggerPersistentClear__COLLISION() external {
        delete nums; // persistent array clearing
    }

    function triggerTransientDelete__COLLISION() external {
        _tmp = 7;
        delete _tmp; // transient delete
    }
}

// =======================================================
// Case06) (COLLISION candidate) assign shorter array / reset (shrink) + transient delete
// =======================================================
contract Case06_AssignShorterArray {
    uint256[] public nums;
    uint256 transient _tmp;

    function seedLong() external {
        nums.push(1);
        nums.push(2);
        nums.push(3);
    }

    function triggerPersistentClear__COLLISION_assign(uint256[] calldata xs) external {
        nums = xs; // if shorter, tail clearing may happen
    }

    function triggerPersistentClear__COLLISION_reset() external {
        nums = new uint256[](0); // shrink to 0 -> clearing path
        // alternatively: delete nums;
    }

    function triggerTransientDelete__COLLISION() external {
        _tmp = 42;
        delete _tmp;
    }
}

// =======================================================
// Case07) (COLLISION candidate) cross-type: delete bool[] (slot-wise) + transient delete uint256
// =======================================================
contract Case07_CrossType_BoolArrayDelete {
    bool[] public flags;
    uint256 transient _tmp;

    function seed() external {
        flags.push(true);
        flags.push(false);
    }

    function triggerPersistentClear__COLLISION() external {
        delete flags; // slot-wise clearing path
    }

    function triggerTransientDelete__COLLISION() external {
        _tmp = 1;
        delete _tmp; // transient delete uint256
    }
}

// =======================================================
// Case08) (COLLISION candidate) inheritance: base has transient delete, derived has persistent delete
// =======================================================
contract Case08_BaseTransient {
    address transient _lock;

    function triggerTransientDelete__COLLISION_enterExit() external {
        require(_lock == address(0), "locked");
        _lock = msg.sender;
        delete _lock;
    }
}

contract Case08_DerivedPersistent is Case08_BaseTransient {
    mapping(uint256 => address) public delegates;

    function triggerPersistentClear__COLLISION(uint256 id) external {
        delete delegates[id];
    }
}

// =======================================================
// Case09) (COLLISION candidate) persistent delete inside a library + transient delete
// =======================================================
library Case09_LibClear {
    function clear(mapping(uint256 => address) storage m, uint256 id) internal {
        delete m[id]; // persistent clearing inside library
    }
}

contract Case09_LibraryPersistentDelete {
    using Case09_LibClear for mapping(uint256 => address);

    mapping(uint256 => address) public delegates;
    address transient _lock;

    function triggerPersistentClear__COLLISION(uint256 id) external {
        delegates.clear(id);
    }

    function triggerTransientDelete__COLLISION() external {
        _lock = msg.sender;
        delete _lock;
    }
}

// =======================================================
// Case10) (NO_COLLISION intended) persistent delete only in creation code, transient delete in runtime
// - Under the “creation/runtime are separate Yul objects” assumption, helpers are not shared -> no collision.
// =======================================================
contract Case10_CreationVsRuntimeSeparated {
    mapping(uint256 => address) public delegates;
    address transient _lock;

    constructor() {
        delete delegates[1]; // creation-only persistent clearing
    }

    function triggerTransientDelete__NO_COLLISION() external {
        _lock = msg.sender;
        delete _lock;
    }
}

// =======================================================
// Case11) (NO_COLLISION intended) workaround: avoid \`delete\` for transient, assign zero instead
// - This avoids the clearing-helper code path, so it is classified as no-collision.
// =======================================================
contract Case11_Workaround_AssignZero {
    mapping(uint256 => address) public delegates;
    address transient _lock;

    function triggerPersistentClear__COLLISION(uint256 id) external {
        delete delegates[id]; // persistent clearing exists
    }

    function triggerTransientClear__NO_COLLISION() external {
        _lock = msg.sender;
        _lock = address(0); // assign zero instead of delete
    }
}`);
  const [configCode, setConfigCode] = useState(`const config = {
  solidity: {
    version: "0.8.30",
    settings: { viaIR: true }
  }
};
export default config;`);
  const [singleResult, setSingleResult] = useState(null);

  const [projectFiles, setProjectFiles] = useState([]);
  const [projectConfig, setProjectConfig] = useState(null);
  const [selectedFileIndex, setSelectedFileIndex] = useState(null);
  const [isDragging, setIsDragging] = useState(false);
  const fileInputRef = useRef(null);

  useEffect(() => {
    if (appMode === 'single') {
      setSingleResult(performAnalysis(code, configCode));
    }
  }, [code, configCode, appMode]);

  const handleFolderUpload = async (e) => {
    e.preventDefault();
    setIsDragging(false);

    const files = e.dataTransfer ? e.dataTransfer.files : e.target.files;
    if (!files || files.length === 0) return;

    let foundConfigContent = '';
    let foundConfigName = '';
    const tempSolFiles = [];

    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const path = file.webkitRelativePath || file.name;

      if (path.includes('node_modules/') || path.includes('lib/') || path.includes('test/')) continue;

      if (path.match(/foundry\.toml|hardhat\.config\.(ts|js)/)) {
        foundConfigContent = await file.text();
        foundConfigName = file.name;
      } else if (path.endsWith('.sol')) {
        const content = await file.text();
        tempSolFiles.push({ name: file.name, path, content });
      }
    }

    setProjectConfig({ name: foundConfigName || 'No config file found', content: foundConfigContent });

    const analyzedFiles = tempSolFiles.map(file => ({
      ...file,
      result: performAnalysis(file.content, foundConfigContent)
    }));

    analyzedFiles.sort((a, b) => {
      const score = { 'VULNERABLE': 3, 'WARNING': 2, 'SAFE': 1, 'ERROR': 0 };
      return score[b.result.status] - score[a.result.status];
    });

    setProjectFiles(analyzedFiles);
    setSelectedFileIndex(analyzedFiles.length > 0 ? 0 : null);
  };

  const StatusIcon = ({ status, className = "w-5 h-5" }) => {
    if (status === 'VULNERABLE') return <AlertTriangle className={`text-red-500 ${className}`} />;
    if (status === 'WARNING') return <AlertTriangle className={`text-yellow-500 ${className}`} />;
    if (status === 'SAFE') return <CheckCircle className={`text-emerald-500 ${className}`} />;
    return <Info className={`text-slate-500 ${className}`} />;
  };

  const renderAnalysisResult = (result) => {
    if (!result) return null;
    return (
      <div className="space-y-6">
        <div className={`p-6 rounded-2xl shadow-sm border ${result.status === 'VULNERABLE' ? 'bg-red-50 border-red-200' :
          result.status === 'WARNING' ? 'bg-yellow-50 border-yellow-200' :
            result.status === 'SAFE' ? 'bg-emerald-50 border-emerald-200' : 'bg-slate-50 border-slate-200'
          }`}>
          <div className="flex items-start gap-4">
            <div className={`p-3 rounded-full shrink-0 ${result.status === 'VULNERABLE' ? 'bg-red-100' :
              result.status === 'WARNING' ? 'bg-yellow-100' :
                result.status === 'SAFE' ? 'bg-emerald-100' : 'bg-slate-100'
              }`}>
              <StatusIcon status={result.status} className="w-8 h-8" />
            </div>
            <div>
              <h2 className={`text-xl font-bold ${result.status === 'VULNERABLE' ? 'text-red-700' :
                result.status === 'WARNING' ? 'text-yellow-700' :
                  result.status === 'SAFE' ? 'text-emerald-700' : 'text-slate-700'
                }`}>
                {result.status === 'VULNERABLE' ? 'Vulnerable' :
                  result.status === 'WARNING' ? 'Warning (Potential Risk)' :
                    result.status === 'SAFE' ? 'Safe' : 'Analysis Error'}
              </h2>
              <p className="text-slate-700 mt-2 text-sm leading-relaxed">{result.reason}</p>
            </div>
          </div>
        </div>

        {result.status !== 'ERROR' && (
          <div className="bg-white rounded-2xl shadow-sm border border-slate-200 overflow-hidden">
            <div className="px-6 py-4 border-b border-slate-100 bg-slate-50">
              <h3 className="font-semibold text-slate-800">Cross-Validation Report</h3>
            </div>
            <div className="p-6 space-y-6">
              <div className="grid grid-cols-2 gap-4">
                <div className="bg-slate-50 p-4 rounded-xl border border-slate-100">
                  <div className="text-xs font-medium text-slate-500 mb-1 flex items-center gap-1">
                    <Settings className="w-3 h-3" /> Applied Version
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-slate-800 font-semibold">{result.activeVersion}</span>
                    {result.configVersion && <span className="text-[10px] bg-blue-100 text-blue-700 px-1.5 py-0.5 rounded">Config Override</span>}
                  </div>
                </div>
                <div className="bg-slate-50 p-4 rounded-xl border border-slate-100">
                  <div className="text-xs font-medium text-slate-500 mb-1 flex items-center gap-1">
                    <Settings className="w-3 h-3" /> via-ir (IR Pipeline)
                  </div>
                  <div>
                    {result.isViaIrEnabled === true ? (
                      <span className="text-red-600 font-semibold text-sm">Enabled (True)</span>
                    ) : result.isViaIrEnabled === false ? (
                      <span className="text-emerald-600 font-semibold text-sm">Disabled (False)</span>
                    ) : (
                      <span className="text-slate-500 font-medium text-sm">Unknown Status</span>
                    )}
                  </div>
                </div>
              </div>

              <div>
                <div className="text-sm font-medium text-slate-500 mb-3">Detected Collision Groups (Based on Scope Separation Analysis)</div>
                {result.collisions.length > 0 ? (
                  <div className="space-y-3">
                    {result.collisions.map((col, idx) => (
                      <div key={idx} className="bg-red-50 border border-red-100 p-4 rounded-xl">
                        <div className="flex flex-col sm:flex-row sm:items-center justify-between border-b border-red-200 pb-2 mb-3 gap-2">
                          <div className="font-mono text-sm text-red-800 font-bold">
                            Type Conflict: {col.type}
                          </div>
                          <div className="flex flex-wrap gap-2">
                            <div className={`text-xs px-2 py-0.5 rounded font-semibold ${col.scope.includes('Creation') ? 'bg-orange-100 text-orange-700' : 'bg-purple-100 text-purple-700'}`}>
                              Scope: {col.scope.includes('Creation') ? 'Creation' : 'Runtime'}
                            </div>
                            <div className="text-xs bg-red-100 text-red-700 px-2 py-0.5 rounded font-semibold">
                              Contract: {col.contract}
                            </div>
                          </div>
                        </div>
                        <div className="grid grid-cols-2 gap-4">
                          <div>
                            <div className="text-xs text-red-500 font-medium mb-1">Cleared Transient Variables</div>
                            {col.transientVars.map(v => (
                              <div key={v} className="font-mono text-xs text-slate-700 bg-white border border-red-100 px-2 py-1 rounded mt-1 inline-block mr-1">{v}</div>
                            ))}
                          </div>
                          <div>
                            <div className="text-xs text-red-500 font-medium mb-1">Cleared Persistent Variables</div>
                            {col.persistentVars.map(v => (
                              <div key={v} className="font-mono text-xs text-slate-700 bg-white border border-red-100 px-2 py-1 rounded mt-1 inline-block mr-1">{v}</div>
                            ))}
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="text-sm text-slate-500 bg-slate-50 p-4 rounded-xl border border-slate-100 italic">
                    No collision pattern found.
                  </div>
                )}
              </div>
            </div>
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="min-h-screen bg-slate-50 p-4 md:p-8 font-sans">
      <div className="max-w-7xl mx-auto space-y-6">

        {/* 🛡️ Security Guarantee Banner */}
        <div className="bg-emerald-50 border border-emerald-200 rounded-xl p-3 flex flex-col sm:flex-row items-center justify-center gap-2 sm:gap-6 text-emerald-800 text-sm font-medium">
          <div className="flex items-center gap-2">
            <Lock className="w-4 h-4" />
            <span>Runs 100% locally in your browser.</span>
          </div>
          <div className="hidden sm:block text-emerald-300">|</div>
          <div className="flex items-center gap-2">
            <WifiOff className="w-4 h-4" />
            <span>No server data transmission (Works offline)</span>
          </div>
          <div className="hidden sm:block text-emerald-300">|</div>
          <a href="https://github.com/minebuu/transient-bug-scanner" target="_blank" rel="noreferrer" className="flex items-center gap-1.5 hover:text-emerald-600 transition-colors underline underline-offset-4">
            <Github className="w-4 h-4" />
            <span>View Open Source Code</span>
          </a>
        </div>

        {/* Header & Mode Selector */}
        <div className="bg-white p-6 rounded-2xl shadow-sm border border-slate-200 flex flex-col md:flex-row items-center justify-between gap-4">
          <div>
            <h1 className="text-2xl font-bold text-slate-800 flex items-center gap-2">
              <ShieldAlert className="text-red-500 w-8 h-8" />
              Transient Bug Scanner
            </h1>
            <p className="text-slate-500 mt-1 text-sm">
              Solidity 0.8.28 ~ 0.8.33 Storage Clearing Collision Analyzer
            </p>
          </div>
          <div className="flex bg-slate-100 p-1 rounded-xl">
            <button
              onClick={() => setAppMode('single')}
              className={`px-4 py-2 rounded-lg text-sm font-semibold transition-all flex items-center gap-2 ${appMode === 'single' ? 'bg-white text-blue-600 shadow-sm' : 'text-slate-500 hover:text-slate-700'}`}
            >
              <Code className="w-4 h-4" /> Single File Check
            </button>
            <button
              onClick={() => setAppMode('project')}
              className={`px-4 py-2 rounded-lg text-sm font-semibold transition-all flex items-center gap-2 ${appMode === 'project' ? 'bg-white text-blue-600 shadow-sm' : 'text-slate-500 hover:text-slate-700'}`}
            >
              <LayoutGrid className="w-4 h-4" /> Project Folder Check
            </button>
          </div>
        </div>

        {/* --- SINGLE FILE MODE --- */}
        {appMode === 'single' && (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            <div className="bg-slate-900 rounded-2xl shadow-xl overflow-hidden flex flex-col border border-slate-800 h-[650px]">
              <div className="flex bg-slate-950 border-b border-slate-800">
                <button onClick={() => setActiveTab('solidity')} className={`flex-1 flex items-center justify-center gap-2 py-3 text-sm font-medium transition-colors ${activeTab === 'solidity' ? 'bg-slate-800 text-blue-400 border-b-2 border-blue-500' : 'text-slate-400 hover:bg-slate-900 hover:text-slate-200'}`}>
                  <Code className="w-4 h-4" /> Solidity Code (.sol)
                </button>
                <button onClick={() => setActiveTab('config')} className={`flex-1 flex items-center justify-center gap-2 py-3 text-sm font-medium transition-colors ${activeTab === 'config' ? 'bg-slate-800 text-orange-400 border-b-2 border-orange-500' : 'text-slate-400 hover:bg-slate-900 hover:text-slate-200'}`}>
                  <FileJson className="w-4 h-4" /> Config (Hardhat/Foundry)
                </button>
              </div>
              {activeTab === 'solidity' ? (
                <textarea value={code} onChange={(e) => setCode(e.target.value)} className="flex-1 w-full p-4 bg-transparent text-green-400 font-mono text-sm resize-none focus:outline-none" spellCheck="false" />
              ) : (
                <textarea value={configCode} onChange={(e) => setConfigCode(e.target.value)} className="flex-1 w-full p-4 bg-transparent text-orange-300 font-mono text-sm resize-none focus:outline-none" spellCheck="false" />
              )}
            </div>
            <div className="overflow-y-auto h-[650px] pr-2">
              {renderAnalysisResult(singleResult)}
            </div>
          </div>
        )}

        {/* --- PROJECT FOLDER MODE --- */}
        {appMode === 'project' && (
          <div className="grid grid-cols-1 lg:grid-cols-[350px_1fr] gap-6">

            {/* Left: Explorer / Uploader */}
            <div className="bg-white rounded-2xl shadow-sm border border-slate-200 overflow-hidden flex flex-col h-[650px]">
              <div className="p-4 border-b border-slate-100 bg-slate-50 flex items-center justify-between">
                <h3 className="font-semibold text-slate-800 flex items-center gap-2">
                  <FolderUp className="w-5 h-5 text-blue-500" />
                  Project Explorer
                </h3>
              </div>

              {projectFiles.length === 0 ? (
                <div
                  className={`flex-1 flex flex-col items-center justify-center p-8 text-center transition-colors border-2 border-dashed m-4 rounded-xl ${isDragging ? 'border-blue-400 bg-blue-50' : 'border-slate-200 bg-slate-50 hover:bg-slate-100'}`}
                  onDragOver={(e) => { e.preventDefault(); setIsDragging(true); }}
                  onDragLeave={() => setIsDragging(false)}
                  onDrop={handleFolderUpload}
                  onClick={() => fileInputRef.current?.click()}
                >
                  <FolderUp className="w-12 h-12 text-blue-500 mb-4" />
                  <p className="text-base font-bold text-slate-800 mb-2">Drag and drop your project folder here or click.</p>
                  <p className="text-sm text-slate-500 mb-6">Hardhat or Foundry folder (auto-detects .sol and configs)</p>

                  <div className="bg-white px-4 py-3 rounded-lg border border-slate-200 shadow-sm flex items-start gap-3 text-left max-w-sm">
                    <Lock className="w-5 h-5 text-emerald-500 shrink-0 mt-0.5" />
                    <div>
                      <p className="text-xs font-bold text-slate-700">Zero Source Code Leakage</p>
                      <p className="text-[11px] text-slate-500 mt-0.5 leading-relaxed">
                        Files are only read in browser memory and NEVER transmitted to external servers or DBs. Upload with confidence.
                      </p>
                    </div>
                  </div>

                  <input
                    type="file"
                    ref={fileInputRef}
                    className="hidden"
                    webkitdirectory="true"
                    directory="true"
                    multiple
                    onChange={handleFolderUpload}
                  />
                </div>
              ) : (
                <div className="flex-1 overflow-y-auto">
                  <div className="p-3 bg-slate-100 border-b border-slate-200 text-xs text-slate-600 font-medium flex justify-between">
                    <span>Applied Config: {projectConfig?.name}</span>
                    <button onClick={() => setProjectFiles([])} className="text-blue-600 hover:underline">Reset</button>
                  </div>
                  <ul className="divide-y divide-slate-100">
                    {projectFiles.map((file, idx) => (
                      <li key={idx}>
                        <button
                          onClick={() => setSelectedFileIndex(idx)}
                          className={`w-full text-left px-4 py-3 hover:bg-slate-50 transition-colors flex items-center justify-between ${selectedFileIndex === idx ? 'bg-blue-50 border-l-4 border-blue-500' : 'border-l-4 border-transparent'}`}
                        >
                          <div className="flex items-center gap-3 overflow-hidden">
                            <StatusIcon status={file.result.status} className="w-4 h-4 shrink-0" />
                            <div className="truncate">
                              <div className="text-sm font-medium text-slate-800 truncate">{file.name}</div>
                              <div className="text-xs text-slate-400 truncate mt-0.5">{file.path}</div>
                            </div>
                          </div>
                          <ChevronRight className="w-4 h-4 text-slate-300 shrink-0" />
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>

            {/* Right: Detailed Analysis for Selected File */}
            <div className="overflow-y-auto h-[650px] pr-2">
              {projectFiles.length === 0 ? (
                <div className="bg-white rounded-2xl shadow-sm border border-slate-200 overflow-hidden h-full flex flex-col">
                  <div className="px-6 py-4 border-b border-slate-100 bg-slate-50 flex items-center gap-2">
                    <Info className="w-5 h-5 text-blue-500" />
                    <h3 className="font-semibold text-slate-800">About the Vulnerability & How to Use</h3>
                  </div>
                  <div className="p-6 space-y-8 overflow-y-auto">
                    <div>
                      <h4 className="text-lg font-bold text-slate-800 mb-2">What is the Transient Storage Collision Bug?</h4>
                      <p className="text-sm text-slate-600 leading-relaxed">
                        In Solidity versions <strong className="text-slate-800">0.8.28 through 0.8.33</strong>, a critical compiler bug exists in the IR pipeline (<code className="bg-slate-100 text-slate-800 px-1.5 py-0.5 rounded text-xs font-mono">via-ir</code>).
                        When a contract uses <code className="bg-slate-100 text-slate-800 px-1.5 py-0.5 rounded text-xs font-mono">delete</code> on both a <code className="bg-slate-100 text-slate-800 px-1.5 py-0.5 rounded text-xs font-mono">transient</code> state variable and a regular (persistent) state variable of the <strong>exact same type</strong>, the compiler incorrectly shares the cleanup helper function. This leads to severe storage corruption or failure to clear data.
                      </p>
                    </div>

                    <div className="bg-red-50 border border-red-100 rounded-xl p-5 shadow-sm">
                      <h5 className="text-sm font-bold text-red-800 mb-3 flex items-center gap-2">
                        <AlertTriangle className="w-5 h-5" /> Required Conditions for Exploitation
                      </h5>
                      <ul className="text-sm text-red-700 space-y-2.5 list-disc list-inside">
                        <li>Compiler version is between <strong>0.8.28 and 0.8.33</strong>.</li>
                        <li>IR Pipeline (<strong className="bg-white px-1.5 py-0.5 rounded border border-red-100 font-mono text-xs">via-ir / viaIR</strong>) is enabled in your Hardhat/Foundry config.</li>
                        <li>Both a transient and a persistent variable of the same base type are cleared (via direct delete, .pop(), or array shrinking) within the exact same scope (Creation or Runtime) of a single contract.</li>
                      </ul>
                    </div>
                  </div>
                </div>
              ) : selectedFileIndex !== null ? (
                <div>
                  <div className="mb-4 flex items-center justify-between">
                    <h2 className="text-lg font-bold text-slate-800 font-mono">
                      {projectFiles[selectedFileIndex].name}
                    </h2>
                    <span className="text-xs text-slate-500">
                      {projectFiles[selectedFileIndex].path}
                    </span>
                  </div>
                  {renderAnalysisResult(projectFiles[selectedFileIndex].result)}
                </div>
              ) : null}
            </div>

          </div>
        )}

      </div>
    </div>
  );
}