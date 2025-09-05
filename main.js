// main.js
const { app, BrowserWindow, ipcMain, shell } = require('electron');
const path = require('path');
const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const WebSocket = require('ws');

const isWin = process.platform === 'win32';
const isMac = process.platform === 'darwin';

let mainWindow;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 900,
    height: 600,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      devTools: true
    }
  });
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

function run(cmd, args = [], opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { windowsHide: true, ...opts }, (err, stdout, stderr) => {
      if (err) {
        err.stderr = stderr?.toString?.() || '';
        return reject(err);
      }
      resolve({ stdout: stdout?.toString() ?? '', stderr: stderr?.toString() ?? '' });
    });
  });
}

// --- Liệt kê máy in ---
async function listPrintersWin() {
  const psArgs = [
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command',
    "Get-Printer | Select-Object Name,ShareName,DriverName,PortName,PrinterStatus,Default | ConvertTo-Json -Depth 2"
  ];
  const { stdout } = await run('powershell.exe', psArgs);
  let arr;
  try { arr = JSON.parse(stdout); } catch { arr = []; }
  if (!Array.isArray(arr)) arr = [arr].filter(Boolean);
  return arr.map(p => ({
    name: p.Name,
    sharedName: p.ShareName || null,
    driver: p.DriverName,
    port: p.PortName,
    status: String(p.PrinterStatus),
    isDefault: !!p.Default,
    source: 'windows'
  }));
}

async function listPrintersCUPS() {
  let defaultPrinter = null;
  try {
    const { stdout: d } = await run('bash', ['-lc', 'lpstat -d || true']);
    const m = d.match(/system default destination:\s+(.+)\s*$/m);
    if (m) defaultPrinter = m[1].trim();
  } catch {}

  let printers = {};
  try {
    const { stdout } = await run('bash', ['-lc', 'lpstat -p || true']);
    stdout.split('\n').forEach(line => {
      const m = line.match(/^printer\s+(\S+)\s+is\s+(.+?)\.\s+(enabled|disabled)/i);
      if (m) {
        const name = m[1];
        printers[name] = printers[name] || { name };
        printers[name].status = m[2];
        printers[name].enabled = m[3].toLowerCase() === 'enabled';
      }
    });
  } catch {}

  try {
    const { stdout } = await run('bash', ['-lc', 'lpstat -v || true']);
    stdout.split('\n').forEach(line => {
      const m = line.match(/^device for\s+(\S+):\s+(.+)$/i);
      if (m) {
        const name = m[1];
        printers[name] = printers[name] || { name };
        printers[name].device = m[2].trim();
      }
    });
  } catch {}

  return Object.values(printers).map(p => ({
    name: p.name,
    device: p.device || null,
    status: p.status || null,
    enabled: typeof p.enabled === 'boolean' ? p.enabled : null,
    isDefault: defaultPrinter ? p.name === defaultPrinter : false,
    source: 'cups'
  }));
}

ipcMain.handle('printers:list', async () => {
  try {
    if (isWin) return await listPrintersWin();
    return await listPrintersCUPS();
  } catch (err) {
    return { error: true, message: err.message, stderr: err.stderr };
  }
});

function safePSString(s) {
  return String(s).replace(/'/g, "''");
}

ipcMain.handle('printers:setDefault', async (_evt, name) => {
  if (!name) return { ok: false, error: 'Tên máy in trống' };
  try {
    if (isWin) {
      await run('RUNDLL32', ['PRINTUI.DLL,PrintUIEntry', '/y', '/n', name]);
    } else {
      await run('bash', ['-lc', `lpoptions -d ${JSON.stringify(name)}`]);
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message, stderr: err.stderr };
  }
});

ipcMain.handle('printers:printTest', async (_evt, name) => {
  if (!name) return { ok: false, error: 'Tên máy in trống' };
  try {
    const tmpDir = app.getPath('temp');
    const testFile = path.join(tmpDir, `printer_test_${Date.now()}.txt`);
    fs.writeFileSync(testFile, `Printer Test Page
====================
Máy in: ${name}
Ngày: ${new Date().toString()}
Hệ điều hành: ${os.platform()} ${os.release()}
--------------------
Dòng tiếng Việt: Xin chào!
`, 'utf8');

    if (isWin) {
      const ps = [
        '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command',
        `$file='${safePSString(testFile)}'; $printer='${safePSString(name)}'; Get-Content -Path $file | Out-Printer -Name $printer`
      ];
      await run('powershell.exe', ps);
    } else {
      await run('bash', ['-lc', `lp -d ${JSON.stringify(name)} ${JSON.stringify(testFile)}`]);
    }
    return { ok: true, file: testFile };
  } catch (err) {
    return { ok: false, error: err.message, stderr: err.stderr };
  }
});

ipcMain.handle('app:openLogs', async () => {
  const logDir = app.getPath('logs');
  await shell.openPath(logDir);
  return { ok: true };
});

function connectToBridgeServer() {
  const bridgeServerUrl = 'ws://localhost:3001';
  
  console.log('🌉 Connecting to Bridge Server...');
  console.log(`🔗 Bridge Server URL: ${bridgeServerUrl}`);
  
  const ws = new WebSocket(bridgeServerUrl);
  
  ws.on('open', function() {
    console.log('✅ Connected to Bridge Server successfully!');
    
    const registerMessage = {
      type: 'register',
      clientType: 'Printer Manager',
      clientId: 'electron-printer-' + Date.now(),
      capabilities: ['print', 'listPrinters']
    };
    
    ws.send(JSON.stringify(registerMessage));
    console.log('📝 Registered as Printer Manager client');
  });
  
  ws.on('message', function(data) {
    try {
      const message = JSON.parse(data);
      console.log('📥 Received from Bridge Server:', message);
      
      if (message.type === 'printCommand') {
        handlePrintCommand(message, ws);
      } else if (message.type === 'listPrinters') {
        handleListPrintersCommand(message, ws);
      } else if (message.type === 'direct_message' && message.data) {
        if (message.data.type === 'printTest') {
          handlePrintTestCommand(message.data, ws, message.from);
        } else if (message.data.type === 'printContent') {
          handlePrintContentCommand(message.data, ws, message.from);
        } else if (message.data.type === 'listPrinters') {
          handleListPrintersCommand(message.data, ws, message.from);
        }
      }
    } catch (error) {
      console.error('❌ Error parsing message from Bridge Server:', error);
    }
  });
  
  ws.on('close', function() {
    console.log('🔌 Connection to Bridge Server closed. Attempting to reconnect...');
    setTimeout(connectToBridgeServer, 5000);
  });
  
  ws.on('error', function(error) {
    console.error('❌ Bridge Server connection error:', error.message);
    console.log('🔄 Will attempt to reconnect in 5 seconds...');
  });
  
  global.bridgeWS = ws;
}

function handlePrintCommand(message, ws) {
  console.log('📄 Handling print command:', message);
}

async function handleListPrintersCommand(message, ws, from = null) {
  console.log('🖨️ Handling list printers command');
  
  try {
    const printers = isWin ? await listPrintersWin() : await listPrintersCUPS();
    const response = {
      type: from ? 'direct_message' : 'response',
      targetId: from,
      data: {
        success: true,
        type: 'printerList',
        printers: printers,
        id: message.id
      }
    };
    
    ws.send(JSON.stringify(response));
    console.log('✅ Sent printer list:', printers.length, 'printers');
  } catch (error) {
    console.error('❌ Error getting printer list:', error);
    const errorResponse = {
      type: from ? 'direct_message' : 'response',
      targetId: from,
      data: {
        success: false,
        type: 'error',
        error: error.message,
        id: message.id
      }
    };
    ws.send(JSON.stringify(errorResponse));
  }
}

function handlePrintTestCommand(message, ws, from) {
  console.log('🧪 Handling print test command from:', from);
  
  printTestPage(message.printer).then(result => {
    const response = {
      type: 'direct_message',
      targetId: from,
      data: {
        success: true,
        type: 'printResult',
        message: 'Print test completed successfully',
        data: result,
        id: message.id
      }
    };
    
    ws.send(JSON.stringify(response));
    console.log('✅ Print test completed successfully');
  }).catch(error => {
    const response = {
      type: 'direct_message',
      targetId: from,
      data: {
        success: false,
        type: 'printResult',
        error: error.message,
        id: message.id
      }
    };
    
    ws.send(JSON.stringify(response));
    console.error('❌ Print test failed:', error.message);
  });
}

function handlePrintContentCommand(message, ws, from) {
  console.log('📄 Handling print content command from:', from);
  
  printContent(message.content, message.printer).then(result => {
    const response = {
      type: 'direct_message',
      targetId: from,
      data: {
        success: true,
        type: 'printResult',
        message: 'Print content completed successfully',
        data: result,
        id: message.id
      }
    };
    
    ws.send(JSON.stringify(response));
    console.log('✅ Print content completed successfully');
  }).catch(error => {
    const response = {
      type: 'direct_message',
      targetId: from,
      data: {
        success: false,
        type: 'printResult',
        error: error.message,
        id: message.id
      }
    };
    
    ws.send(JSON.stringify(response));
    console.error('❌ Print content failed:', error.message);
  });
}

async function printTestPage(printerName) {
  try {
    const tmpDir = app.getPath('temp');
    const testFile = path.join(tmpDir, `printer_test_${Date.now()}.txt`);
    fs.writeFileSync(testFile, `Printer Test Page\n====================\nMáy in: ${printerName}\nNgày: ${new Date().toString()}\nHệ điều hành: ${os.platform()} ${os.release()}\n--------------------\nDòng tiếng Việt: Xin chào!\nTest in silent không popup\n`, 'utf8');

    if (isWin) {
      const ps = [
        '-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-Command',
        `$file='${safePSString(testFile)}'; $printer='${safePSString(printerName)}'; ` +
        `try { Get-Content -Path $file -Raw | Out-Printer -Name $printer; Write-Host 'Test print sent successfully' } ` +
        `catch { Write-Error $_.Exception.Message; exit 1 }`
      ];
      await run('powershell.exe', ps, { windowsHide: true });
    } else {
      await run('bash', ['-lc', `lp -d ${JSON.stringify(printerName)} -o media=A4 -o fit-to-page ${JSON.stringify(testFile)}`]);
    }
    
    setTimeout(() => {
      try {
        if (fs.existsSync(testFile)) {
          fs.unlinkSync(testFile);
        }
      } catch (e) {
        console.log('Could not delete temp file:', e.message);
      }
    }, 5000);
    
    return { ok: true, file: testFile, message: 'Test print sent silently without popup' };
  } catch (err) {
    return { ok: false, error: err.message, stderr: err.stderr };
  }
}

async function printContent(content, printerName) {
  try {
    const tmpDir = app.getPath('temp');
    const printFile = path.join(tmpDir, `print_content_${Date.now()}.txt`);
    fs.writeFileSync(printFile, content, 'utf8');

    if (isWin) {
      const ps = [
        '-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-Command',
        `$file='${safePSString(printFile)}'; $printer='${safePSString(printerName)}'; ` +
        `try { Get-Content -Path $file -Raw | Out-Printer -Name $printer; Write-Host 'Print job sent successfully' } ` +
        `catch { Write-Error $_.Exception.Message; exit 1 }`
      ];
      await run('powershell.exe', ps, { windowsHide: true });
    } else {
      await run('bash', ['-lc', `lp -d ${JSON.stringify(printerName)} -o media=A4 -o fit-to-page ${JSON.stringify(printFile)}`]);
    }
    
    setTimeout(() => {
      try {
        if (fs.existsSync(printFile)) {
          fs.unlinkSync(printFile);
        }
      } catch (e) {
        console.log('Could not delete temp file:', e.message);
      }
    }, 5000);
    
    return { ok: true, file: printFile, message: 'Print job sent silently without popup' };
  } catch (err) {
    return { ok: false, error: err.message, stderr: err.stderr };
  }
}

app.whenReady().then(() => {
  createWindow();
  connectToBridgeServer();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (!isMac) app.quit();
});

app.on('before-quit', () => {
  if (global.bridgeWS) {
    console.log('Closing Bridge Server connection...');
    global.bridgeWS.close();
  }
});