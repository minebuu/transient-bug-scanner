# **🛡️ Transient Bug Scanner**

A fast, 100% local, browser-based static analyzer for detecting the **Solidity Storage Clearing Collision Bug**.

Source: https://www.soliditylang.org/blog/2026/02/18/transient-storage-clearing-helper-collision-bug

This tool checks whether your Solidity smart contracts are vulnerable to the transient storage clearing collision bug that occurs in compiler versions 0.8.28 through 0.8.33 when the IR pipeline (via-ir) is enabled.

## **✨ Features**

* **100% Local Execution:** All analysis is performed directly in your browser's memory. No code is ever transmitted to an external server.  
* **Project Folder Support:** Drag and drop your entire project folder.  
* **Auto-Config Detection:** Automatically detects foundry.toml, hardhat.config.ts, or hardhat.config.js to accurately determine compiler versions and IR pipeline (viaIR) settings.  
* **Instant Cross-Validation:** Highlights exactly which variables are conflicting and verifies the risk based on your framework settings.

## **🚨 About the Vulnerability**

When a contract uses delete on both a transient state variable and a regular (persistent) state variable of the **exact same type**, the Solidity compiler (versions 0.8.28 to 0.8.33 with IR pipeline enabled) incorrectly shares the cleanup helper function. This leads to severe storage corruption or failure to clear data properly.

### **Required Conditions for Exploitation:**

1. Compiler version is **0.8.28 \~ 0.8.33**.  
2. IR Pipeline (via-ir / viaIR: true) is **enabled** in your project config.  
3. Both transient and persistent variables of the **same type** are deleted via delete.

## **🔒 Security Guarantee**

We understand that smart contract code is highly sensitive.

* **Zero Data Transmission:** This tool uses the HTML5 FileReader API. Your source code never leaves your computer.  
* **Works Offline:** Once the page is loaded, you can turn off your Wi-Fi/Internet connection. The scanner will continue to work perfectly.  
* **No Analytics:** We do not track what you scan.

## **🚀 How to Run Locally**

If you prefer to run the scanner on your local machine instead of the hosted website:

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

## **🛠️ Built With**

* React  
* Vite  
* Tailwind CSS  
* Lucide Icons
