import React, { useState, useEffect, useRef } from 'react';
import {
  ShieldAlert, AlertTriangle, CheckCircle, Info, Code, FileJson,
  Settings, FolderUp, FileText, ChevronRight, LayoutGrid,
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

    const deleteRegex = /delete\s+([a-zA-Z0-9_]+)(?:\.[a-zA-Z0-9_]+|\[.*?\])*\s*;/g;
    const uniqueDeletes = [...new Set([...cleanedSol.matchAll(deleteRegex)].map(m => m[1]))];

    const varsInfo = [];
    uniqueDeletes.forEach(varName => {
      const declRegex = new RegExp(`(?:(mapping\\s*\\([\\s\\S]*?\\))|([a-zA-Z0-9_]+(?:\\s*\\[.*?\\])*))\\s+((?:(?:public|private|internal|transient|constant|immutable)\\s+)*)${varName}\\s*(?:=|;)`);
      const match = cleanedSol.match(declRegex);
      if (match) {
        varsInfo.push({
          name: varName,
          type: (match[1] || match[2]).replace(/\s+/g, ''),
          isTransient: (match[3] || "").includes('transient'),
        });
      }
    });

    const typeMap = {};
    varsInfo.forEach(v => {
      if (!typeMap[v.type]) typeMap[v.type] = { transient: [], persistent: [] };
      v.isTransient ? typeMap[v.type].transient.push(v.name) : typeMap[v.type].persistent.push(v.name);
    });

    const collisions = [];
    Object.keys(typeMap).forEach(type => {
      if (typeMap[type].transient.length > 0 && typeMap[type].persistent.length > 0) {
        collisions.push({ type, transientVars: typeMap[type].transient, persistentVars: typeMap[type].persistent });
      }
    });

    let status = 'SAFE';
    let reason = '';

    if (collisions.length === 0) {
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

    return { status, reason, activeVersion, isVulnerableVersion, framework, isViaIrEnabled, varsInfo, collisions, configVersion };
  } catch (e) {
    return { status: 'ERROR', reason: e.message };
  }
};

export default function App() {
  const [appMode, setAppMode] = useState('project'); // 'single' or 'project'

  // Single File Mode States
  const [activeTab, setActiveTab] = useState('solidity');
  const [code, setCode] = useState(`// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

contract VulnerableContract {
    uint256 transient tCount;
    uint256 sCount;

    function clearCounts() public {
        delete tCount;
        delete sCount;
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

  // Project Mode States
  const [projectFiles, setProjectFiles] = useState([]);
  const [projectConfig, setProjectConfig] = useState(null);
  const [selectedFileIndex, setSelectedFileIndex] = useState(null);
  const [isDragging, setIsDragging] = useState(false);
  const fileInputRef = useRef(null);

  // Single mode effect
  useEffect(() => {
    if (appMode === 'single') {
      setSingleResult(performAnalysis(code, configCode));
    }
  }, [code, configCode, appMode]);

  // Handle Folder Upload
  const handleFolderUpload = async (e) => {
    e.preventDefault();
    setIsDragging(false);

    const files = e.dataTransfer ? e.dataTransfer.files : e.target.files;
    if (!files || files.length === 0) return;

    let foundConfigContent = '';
    let foundConfigName = '';
    const tempSolFiles = [];

    // 1. Find config file first & filter .sol files
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const path = file.webkitRelativePath || file.name;

      // Ignore dependency folders (for speed and avoiding false positives)
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

    // 2. Analyze all .sol files based on the found config
    const analyzedFiles = tempSolFiles.map(file => ({
      ...file,
      result: performAnalysis(file.content, foundConfigContent)
    }));

    // Sort by risk (VULNERABLE > WARNING > SAFE)
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
                <div className="text-sm font-medium text-slate-500 mb-3">Detected Collision Groups (Same type transient & persistent)</div>
                {result.collisions.length > 0 ? (
                  <div className="space-y-3">
                    {result.collisions.map((col, idx) => (
                      <div key={idx} className="bg-red-50 border border-red-100 p-4 rounded-xl">
                        <div className="font-mono text-sm text-red-800 font-bold mb-3 border-b border-red-200 pb-2">
                          Type: {col.type}
                        </div>
                        <div className="grid grid-cols-2 gap-4">
                          <div>
                            <div className="text-xs text-red-500 font-medium mb-1">Transient (delete called)</div>
                            {col.transientVars.map(v => (
                              <div key={v} className="font-mono text-xs text-slate-700 bg-white border border-red-100 px-2 py-1 rounded mt-1 inline-block mr-1">{v}</div>
                            ))}
                          </div>
                          <div>
                            <div className="text-xs text-red-500 font-medium mb-1">Persistent (delete called)</div>
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
                    No collision patterns found.
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
                  <p className="text-base font-bold text-slate-800 mb-2">Drag and drop your project folder here or click</p>
                  <p className="text-sm text-slate-500 mb-6">Hardhat or Foundry folder (auto-detects .sol and configs)</p>

                  {/* Security Assurance Message */}
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
                    {/* Vulnerability Explanation */}
                    <div>
                      <h4 className="text-lg font-bold text-slate-800 mb-2">The Transient Storage Collision Bug</h4>
                      <p className="text-sm text-slate-600 leading-relaxed">
                        In Solidity versions <strong className="text-slate-800">0.8.28 through 0.8.33</strong>, a critical compiler bug exists in the IR pipeline (<code className="bg-slate-100 text-slate-800 px-1.5 py-0.5 rounded text-xs font-mono">via-ir</code>).
                        When a contract uses <code className="bg-slate-100 text-slate-800 px-1.5 py-0.5 rounded text-xs font-mono">delete</code> on both a <code className="bg-slate-100 text-slate-800 px-1.5 py-0.5 rounded text-xs font-mono">transient</code> state variable and a regular (persistent) state variable of the <strong>exact same type</strong>, the compiler incorrectly shares the cleanup helper function. This leads to severe storage corruption or failure to clear data.
                      </p>
                    </div>

                    {/* Conditions */}
                    <div className="bg-red-50 border border-red-100 rounded-xl p-5 shadow-sm">
                      <h5 className="text-sm font-bold text-red-800 mb-3 flex items-center gap-2">
                        <AlertTriangle className="w-5 h-5" /> Required Conditions for Exploitation
                      </h5>
                      <ul className="text-sm text-red-700 space-y-2.5 list-disc list-inside">
                        <li>Compiler version is between <strong>0.8.28 and 0.8.33</strong>.</li>
                        <li>IR Pipeline (<strong className="bg-white px-1.5 py-0.5 rounded border border-red-100 font-mono text-xs">via-ir / viaIR</strong>) is enabled in your Hardhat/Foundry config.</li>
                        <li>Both a <code className="bg-white px-1.5 py-0.5 rounded border border-red-100 font-mono text-xs">transient</code> and a persistent variable of the <strong>same type</strong> are deleted via <code className="bg-white px-1.5 py-0.5 rounded border border-red-100 font-mono text-xs">delete</code> in the code.</li>
                      </ul>
                    </div>

                    {/* How to use */}
                    <div>
                      <h4 className="text-lg font-bold text-slate-800 mb-4 border-b border-slate-100 pb-2">How to Use Project Mode</h4>
                      <div className="space-y-4">
                        <div className="flex items-start gap-3">
                          <div className="bg-blue-100 text-blue-700 w-6 h-6 rounded-full flex items-center justify-center font-bold text-xs shrink-0 mt-0.5">1</div>
                          <p className="text-sm text-slate-600"><strong className="text-slate-800">Drag & Drop your project folder</strong> into the left panel. Supported frameworks include Hardhat and Foundry.</p>
                        </div>
                        <div className="flex items-start gap-3">
                          <div className="bg-blue-100 text-blue-700 w-6 h-6 rounded-full flex items-center justify-center font-bold text-xs shrink-0 mt-0.5">2</div>
                          <p className="text-sm text-slate-600"><strong className="text-slate-800">Auto-Detection:</strong> The scanner will automatically find your <code className="bg-slate-100 text-slate-800 px-1.5 py-0.5 rounded text-xs font-mono">foundry.toml</code> or <code className="bg-slate-100 text-slate-800 px-1.5 py-0.5 rounded text-xs font-mono">hardhat.config.*</code> to accurately determine the applied compiler version and IR settings.</p>
                        </div>
                        <div className="flex items-start gap-3">
                          <div className="bg-blue-100 text-blue-700 w-6 h-6 rounded-full flex items-center justify-center font-bold text-xs shrink-0 mt-0.5">3</div>
                          <p className="text-sm text-slate-600"><strong className="text-slate-800">Review Results:</strong> Click on the scanned <code className="bg-slate-100 text-slate-800 px-1.5 py-0.5 rounded text-xs font-mono">.sol</code> files on the left to view detailed cross-validation reports here.</p>
                        </div>
                      </div>
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