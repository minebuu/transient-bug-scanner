# **🛡️ Transient Bug Scanner**

**🌐 Try it Live: https://transient-bug-scanner.vercel.app/**

<img width="1302" height="881" alt="image" src="https://github.com/user-attachments/assets/83257356-8fb5-4f3c-aee3-6ee07eee48c6" />

A fast, 100% local, browser-based static analyzer for detecting the **Solidity Storage Clearing Collision Bug**.

Root cause of bug: https://www.soliditylang.org/blog/2026/02/18/transient-storage-clearing-helper-collision-bug

This tool checks whether your Solidity smart contracts are vulnerable to the transient storage clearing collision bug that occurs in compiler versions 0.8.28 through 0.8.33 when the IR pipeline (via-ir) is enabled.

## **✨ Features**

* **100% Local Execution:** All analysis is performed directly in your browser's memory or local terminal. No code is ever transmitted to an external server.  
* **Project Folder Support:** Drag and drop your entire project folder (Web) or pass it as an argument (CLI).  
* **Auto-Config Detection:** Automatically detects foundry.toml, hardhat.config.ts, or hardhat.config.js to accurately determine compiler versions and IR pipeline (viaIR) settings.  
* **Instant Cross-Validation:** Highlights exactly which variables are conflicting and verifies the risk based on your framework settings. Includes cross-file inheritance and library tracking.

## **🚨 About the Vulnerability**

When a contract uses delete on both a transient state variable and a regular (persistent) state variable of the **exact same type**, the Solidity compiler (versions 0.8.28 to 0.8.33 with IR pipeline enabled) incorrectly shares the cleanup helper function. This leads to severe storage corruption or failure to clear data properly.

### **Required Conditions for Exploitation:**

1. Compiler version is **0.8.28 \~ 0.8.33**.  
2. IR Pipeline (via-ir / viaIR: true) is **enabled** in your project config.  
3. Both transient and persistent variables of the **same type** are deleted via delete.

## **🔒 Security Guarantee**

We understand that smart contract code is highly sensitive.

* **Zero Data Transmission:** This tool uses the HTML5 FileReader API. Your source code never leaves your computer.  
* **Works Offline:** Once the page is loaded (or if you use the CLI), you can turn off your Wi-Fi/Internet connection. The scanner will continue to work perfectly.  
* **No Analytics:** We do not track what you scan.

## **⚠️ Limitations & Constraints**

Since this scanner performs heuristic analysis using Regular Expressions (Regex) rather than an actual Solidity compiler (AST), it has the following limitations:

1. **Limitations of Regex-based Analysis:** Because it doesn't generate and analyze an Abstract Syntax Tree (AST), it may not perfectly separate variable types or scopes (Creation vs. Runtime) in heavily obfuscated code, code with non-standard line breaks, or highly complex nested bracket logic.  
2. **Name Collision Handling:** If there are multiple contracts or libraries with the exact same name in the project (e.g., MockERC20 in a test folder and MockERC20 in the src folder), the scanner merges the bodies of all identically named entities for scanning. As a result, it may output more conservative results (reporting suspected collisions) than the actual inheritance relationship dictates.  
3. **Exclusion of External Dependency Folders:** For memory optimization and scanning speed, folders such as node\_modules, test, out, and artifacts are excluded from the scan by default. If you need to track vulnerabilities inside excluded external modules, you must modify the ignoredDirs array in the source code.  
4. **Limits on Framework Config Detection:** The tool automatically finds foundry.toml and hardhat.config.js/ts files to determine if via-ir is enabled and what solc version is used. However, if you use inline compilation scripts or custom build tools, it might not automatically recognize these settings.

## **🚀 How to Run Locally (Web UI)**

If you prefer to run the web-based scanner on your local machine instead of the hosted website:

1. Clone this repository:

```
git clone https://github.com/minebuu/transient-bug-scanner.git
cd transient-bug-scanner
```

2. Install dependencies:

```
npm install
```

3. Start the development server:

```
npm run dev
```

4. Open http://localhost:5173 in your browser.

## **💻 CLI Usage (scanner.js)**

If you prefer using the terminal, a standalone Node.js script (scanner.js) is included. It features the same cross-file inheritance tracking and automatic config detection (Foundry/Hardhat) as the Web UI.

### **Prerequisites**

* [Node.js](https://nodejs.org/) installed on your machine.

### **Running the Scanner**

You can execute the script by passing a directory or a specific file path as an argument. If no argument is provided, it scans the current working directory.

```
// #1. Make the script executable (Mac/Linux)  
chmod \+x scanner.js

// #2. Scan the current directory  
./scanner.js

// #3. Scan a specific project folder  
./scanner.js path/to/your/foundry-project

// #4. Scan a single Solidity file  
./scanner.js src/MyContract.sol
```

## **🛠️ Built With**

* React  
* Vite  
* Tailwind CSS  
* Lucide Icons  
* Node.js (CLI)
