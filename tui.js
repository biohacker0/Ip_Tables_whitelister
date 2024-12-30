import { terminal as term } from 'terminal-kit';
import { homedir } from 'os';
import { join } from 'path';
import { mkdir, writeFile, readFile, unlink } from 'fs/promises';
import { existsSync } from 'fs';
import { Octokit } from '@octokit/rest';
import { $ } from 'bun';

// Configuration and Constants
const CONFIG_DIR = join(homedir(), '.config', 'ssh-whitelist');
const CONFIG_FILE = join(CONFIG_DIR, 'config.json');
const GIST_FILENAME = 'config.json';
const UPDATE_INTERVAL = 5 * 60 * 1000; // 5 minutes
let currentView = 'main'; // Tracks current view state
let isViewChanging = false; // Prevents multiple view changes

// System Management Functions
async function checkSudo() {
    try {
        await $`sudo -n true`;
        return true;
    } catch {
        return false;
    }
}

async function checkPackageManager() {
    try {
        await $`which apt`;
        return 'apt';
    } catch {
        try {
            await $`which apt-get`;
            return 'apt-get';
        } catch {
            return null;
        }
    }
}

async function installPackage(packageName) {
    const pkgManager = await checkPackageManager();
    if (!pkgManager) {
        throw new Error('No supported package manager found');
    }

    try {
        term.yellow(`\n  Installing ${packageName}...\n`);
        if (pkgManager === 'apt') {
            await $`sudo apt update`;
            await $`sudo apt install -y ${packageName}`;
        } else {
            await $`sudo apt-get update`;
            await $`sudo apt-get install -y ${packageName}`;
        }
        term.green(`  ✓ ${packageName} installed successfully\n`);
        return true;
    } catch (error) {
        term.red(`  ✗ Failed to install ${packageName}: ${error.message}\n`);
        return false;
    }
}

async function checkAndConfigureSSH() {
    try {
        // Check SSH server installation
        try {
            await $`which sshd`;
        } catch {
            term.yellow('\n  SSH server not found. Would you like to install it?\n');
            const choice = await showMenu(['Yes', 'No']);
            if (choice === 0) {
                const installed = await installPackage('openssh-server');
                if (!installed) return false;
            } else {
                return false;
            }
        }

        // Check SSH service status
        try {
            const status = await $`systemctl is-active ssh`;
            if (!status.stdout.toString().trim().includes('active')) {
                term.yellow('\n  SSH service is not running. Starting it...\n');
                await $`sudo systemctl start ssh`;
                await $`sudo systemctl enable ssh`;
            }
        } catch {
            term.yellow('\n  Starting SSH service...\n');
            await $`sudo systemctl start ssh`;
            await $`sudo systemctl enable ssh`;
        }

        term.green('  ✓ SSH server is configured and running\n');
        return true;
    } catch (error) {
        term.red(`  ✗ SSH configuration failed: ${error.message}\n`);
        return false;
    }
}

async function checkAndConfigureUFW() {
    try {
        // Check UFW installation
        try {
            await $`which ufw`;
        } catch {
            term.yellow('\n  UFW not found. Would you like to install it?\n');
            const choice = await showMenu(['Yes', 'No']);
            if (choice === 0) {
                const installed = await installPackage('ufw');
                if (!installed) return false;
            } else {
                return false;
            }
        }

        // Check UFW status
        const status = await $`sudo ufw status`;
        const statusOutput = status.stdout.toString();

        // Enable UFW if inactive
        if (statusOutput.includes('inactive')) {
            term.yellow('\n  UFW is inactive. Would you like to enable it?\n');
            const choice = await showMenu(['Yes', 'No']);
            if (choice === 0) {
                term.yellow('\n  Enabling UFW and adding SSH rule...\n');
                await $`sudo ufw allow ssh`;
                await $`echo "y" | sudo ufw enable`;
            } else {
                return false;
            }
        }

        // Check if SSH is allowed
        if (!statusOutput.includes('22/tcp') && !statusOutput.includes('22 ')) {
            term.yellow('\n  SSH port not allowed in UFW. Adding rule...\n');
            await $`sudo ufw allow ssh`;
        }

        term.green('  ✓ UFW is configured and running\n');
        return true;
    } catch (error) {
        term.red(`  ✗ UFW configuration failed: ${error.message}\n`);
        return false;
    }
}

// File System Utilities
async function ensureConfigDir() {
    if (!existsSync(CONFIG_DIR)) {
        await mkdir(CONFIG_DIR, { recursive: true });
    }
}

async function loadConfig() {
    try {
        if (!existsSync(CONFIG_FILE)) return null;
        const data = await readFile(CONFIG_FILE, 'utf-8');
        return JSON.parse(data);
    } catch (error) {
        return null;
    }
}

async function saveConfig(config) {
    await ensureConfigDir();
    await writeFile(CONFIG_FILE, JSON.stringify(config, null, 2));
}

async function deleteConfig() {
    try {
        if (existsSync(CONFIG_FILE)) {
            await unlink(CONFIG_FILE);
        }
    } catch (error) {
        console.error('Error deleting config:', error);
    }
}

// GitHub Related Utilities
async function verifyGitHubToken(token) {
    try {
        const octokit = new Octokit({ auth: token });
        await octokit.users.getAuthenticated();
        return true;
    } catch {
        return false;
    }
}

async function findOrCreateGist(octokit) {
    try {
        const gists = await octokit.gists.list();
        const existingGist = gists.data.find(gist => 
            gist.files[GIST_FILENAME] && 
            gist.description?.includes('SSH Whitelist IPs')
        );

        if (existingGist) {
            return { id: existingGist.id, isNew: false };
        }

        const newGist = await octokit.gists.create({
            description: 'SSH Whitelist IPs - Managed by SSH Whitelist Manager',
            public: false,
            files: {
                [GIST_FILENAME]: {
                    content: JSON.stringify({})
                }
            }
        });

        return { id: newGist.data.id, isNew: true };
    } catch (error) {
        throw new Error(`GitHub Gist Error: ${error.message}`);
    }
}

// UI Components
function drawHeader(text = '') {
    term.clear();
    term.bold.cyan('\n  SSH Whitelist Manager\n');
    term.gray('  ' + '='.repeat(50) + '\n');
    if (text) {
        term.white(`\n  ${text}\n`);
    }
}

async function showMenu(items) {
    const response = await term.singleColumnMenu(items).promise;
    return response.selectedIndex;
}

async function getInput(prompt, hidden = false) {
    term(prompt);
    const input = hidden ? 
        await term.inputField({ echo: '*' }).promise :
        await term.inputField().promise;
    term('\n');
    return input;
}

// [Continued in next part...]

// Help Screens and Setup
async function showWelcomeScreen() {
    drawHeader();
    term.white(`
  Welcome to SSH Whitelist Manager!
  
  This tool helps maintain SSH access with dynamic IPs:
  
  1. Connector Node (All OS):
     - Tracks your computer's IP changes
     - Updates central management system
     - No special requirements
  
  2. Server Node (Ubuntu/Debian):
     - Monitors allowed IPs
     - Manages firewall rules
     - Requires: SSH Server & UFW
     
  Requirements:
  - GitHub Token (with gist scope)
    Get it from: https://github.com/settings/tokens
  
  Press any key to continue...`);
    
    await term.inputField({ echo: false }).promise;
}

async function showSystemCheck() {
    drawHeader('System Check');
    
    if (process.platform === 'linux') {
        const hasSudo = await checkSudo();
        if (!hasSudo) {
            term.red(`
  ⚠ Sudo access required!
  
  This application needs sudo rights to:
  - Install required packages
  - Configure SSH server
  - Manage UFW rules
  
  Please run this command and try again:
  sudo echo "SSH Whitelist Manager sudo access granted"
  
  Press any key to exit...`);
            await term.inputField({ echo: false }).promise;
            process.exit(1);
        }
    }
}

async function showInitialMenu(existingConfig) {
    drawHeader('Main Menu');
    
    const options = [
        ...(existingConfig ? ['Use existing configuration'] : []),
        'Set up new configuration',
        'System requirements check',
        'Help',
        'Exit'
    ];

    if (existingConfig) {
        term.white(`  Current Configuration:\n`);
        term.gray(`  - Type: ${existingConfig.nodeType === 'connector' ? 'Connector Node' : 'Server Node'}\n`);
        term.gray(`  - Domain: ${existingConfig.domain}\n`);
        term.gray(`  - Last Run: ${existingConfig.lastRun || 'Never'}\n\n`);
    }

    term.white('  Select an option:\n');
    const choice = await showMenu(options);

    if (existingConfig) {
        switch (choice) {
            case 0: return existingConfig;
            case 1: return setupWizard(true);
            case 2: await performSystemCheck(); return showInitialMenu(existingConfig);
            case 3: await showWelcomeScreen(); return showInitialMenu(existingConfig);
            case 4: process.exit(0);
        }
    } else {
        switch (choice) {
            case 0: return setupWizard(false);
            case 1: await performSystemCheck(); return showInitialMenu(existingConfig);
            case 2: await showWelcomeScreen(); return showInitialMenu(existingConfig);
            case 3: process.exit(0);
        }
    }
}

async function performSystemCheck() {
    drawHeader('System Requirements Check');

    // Basic system info
    term.white('  System Information:\n');
    term.gray(`  - OS: ${process.platform}\n`);
    term.gray(`  - Architecture: ${process.arch}\n\n`);

    if (process.platform === 'linux') {
        // Check package manager
        const pkgManager = await checkPackageManager();
        term.white('  Package Manager:\n');
        term.gray(`  - ${pkgManager ? `✓ Found: ${pkgManager}` : '✗ No supported package manager'}\n\n`);

        // Check sudo access
        const hasSudo = await checkSudo();
        term.white('  Sudo Access:\n');
        term.gray(`  - ${hasSudo ? '✓ Available' : '✗ Not available'}\n\n`);

        // Check SSH server
        try {
            await $`which sshd`;
            const sshStatus = await $`systemctl is-active ssh`;
            term.white('  SSH Server:\n');
            term.gray(`  - ✓ Installed\n`);
            term.gray(`  - ${sshStatus.stdout.toString().trim() === 'active' ? '✓' : '✗'} Running\n\n`);
        } catch {
            term.white('  SSH Server:\n');
            term.gray('  - ✗ Not installed\n\n');
        }

        // Check UFW
        try {
            await $`which ufw`;
            const ufwStatus = await $`sudo ufw status`;
            const statusStr = ufwStatus.stdout.toString();
            term.white('  UFW Firewall:\n');
            term.gray(`  - ✓ Installed\n`);
            term.gray(`  - ${statusStr.includes('inactive') ? '✗' : '✓'} Active\n`);
            term.gray(`  - ${statusStr.includes('22') ? '✓' : '✗'} SSH Allowed\n\n`);
        } catch {
            term.white('  UFW Firewall:\n');
            term.gray('  - ✗ Not installed\n\n');
        }
    }

    term.white('  Press any key to return to menu...');
    await term.inputField({ echo: false }).promise;
}


// Add this function to detect SSH port
async function detectSSHPort() {
    try {
        // Try to read SSH config file
        const sshConfig = await $`cat /etc/ssh/sshd_config`;
        const configContent = sshConfig.stdout.toString();
        
        // Look for Port directive in SSH config
        const portMatch = configContent.match(/^Port\s+(\d+)/m);
        if (portMatch) {
            return parseInt(portMatch[1]);
        }

        // If no explicit port is set, check listening ports
        const netstat = await $`netstat -tlpn | grep sshd`;
        const netstatOutput = netstat.stdout.toString();
        const listeningMatch = netstatOutput.match(/:(\d+)\s/);
        if (listeningMatch) {
            return parseInt(listeningMatch[1]);
        }

        // If we can't detect, we'll need to ask the user
        return null;
    } catch (error) {
        // If we can't read the files or run commands, we'll need to ask the user
        return null;
    }
}

// Modify the UFW management functions to use the configured port
async function addUFWRule(ip, config) {
    try {
        await $`sudo ufw allow from ${ip} to any port ${config.sshPort}`;
        term.green(`  ✓ Added UFW rule: allow from ${ip} to port ${config.sshPort}\n`);
    } catch (error) {
        throw new Error(`Failed to add UFW rule: ${error.message}`);
    }
}

async function removeUFWRule(oldIp, config) {
    try {
        await $`sudo ufw delete deny from ${oldIp} to any port ${config.sshPort}`;
        term.green(`  ✓ Removed UFW rule for ${oldIp}\n`);
    } catch (error) {
        throw new Error(`Failed to remove UFW rule: ${error.message}`);
    }
}




async function setupWizard(isReset = false) {
    // Handle reset request if user wants to create new configuration
    if (isReset) {
        term.yellow('\n  This will override your existing configuration.\n');
        term.white('  Are you sure?\n');
        const confirm = await showMenu(['No, keep existing', 'Yes, set up new']);
        if (confirm === 0) return null;
        await deleteConfig();
    }

    while (true) {
        try {
            drawHeader('Setup Wizard');
            
            // Step 1: Node Type Selection
            term.white('  Select node type:\n');
            const nodeTypeChoice = await showMenu([
                'Connector Node (IP Tracker)',
                'Server Node (Firewall Manager)',
                'Help - Explain the differences'
            ]);
            
            if (nodeTypeChoice === 2) {
                await showWelcomeScreen();
                continue;
            }

            const isServer = nodeTypeChoice === 1;
            let sshPort = null;

            // Step 2: Server-specific Requirements Check
            if (isServer) {
                if (process.platform !== 'linux') {
                    term.red('\n  Error: Server node requires Linux (Ubuntu/Debian)\n');
                    await new Promise(resolve => setTimeout(resolve, 2000));
                    continue;
                }

                // SSH Server Check and Port Detection
                term.yellow('\n  Checking SSH server configuration...');
                try {
                    const sshConfig = await $`cat /etc/ssh/sshd_config`;
                    const configContent = sshConfig.stdout.toString();
                    const portMatch = configContent.match(/^Port\s+(\d+)/m);
                    
                    if (portMatch) {
                        sshPort = parseInt(portMatch[1]);
                    } else {
                        const netstat = await $`netstat -tlpn | grep sshd`;
                        const netstatOutput = netstat.stdout.toString();
                        const listeningMatch = netstatOutput.match(/:(\d+)\s/);
                        if (listeningMatch) {
                            sshPort = parseInt(listeningMatch[1]);
                        }
                    }
                } catch {
                    sshPort = 22; // Default SSH port if detection fails
                }

                term.green(`\n  ✓ Detected SSH port: ${sshPort}\n`);

                // UFW Check and Configuration
                term.yellow('\n  Checking UFW status...');
                try {
                    await $`which ufw`;
                    const ufwStatus = await $`sudo ufw status`;
                    const statusOutput = ufwStatus.stdout.toString();
                    
                    if (!statusOutput.includes('Status: active')) {
                        term.yellow('\n  UFW is not active. Enabling UFW...');
                        await $`sudo ufw allow ${sshPort}`;
                        await $`echo "y" | sudo ufw enable`;
                    }
                    
                    term.green('\n  ✓ UFW is configured and running\n');
                } catch (error) {
                    throw new Error('UFW is required for server node operation');
                }
            }

            // Step 3: GitHub Token Setup
            term.white('\n  GitHub Token Setup\n');
            term.gray('  - Generate at: https://github.com/settings/tokens\n');
            term.gray('  - Required scope: gist\n');
            const token = await getInput('  Enter token: ', true);
            
            // Verify GitHub token
            term.yellow('\n  Verifying GitHub access...');
            if (!await verifyGitHubToken(token)) {
                throw new Error('Invalid GitHub token');
            }
            term.green('\n  ✓ Token verified\n');

            // Step 4: Configure Identifier (only for connector nodes)
            let identifier = null;
            if (!isServer) {
                term.white('\n  Computer Identifier\n');
                term.gray('  - Name to identify this machine\n');
                term.gray('  - Example: home-laptop, office-desktop\n');
                identifier = await getInput('  Enter identifier: ');
            }

            // Step 5: GitHub Gist Setup
            term.yellow('\n  Setting up secure gist...');
            const octokit = new Octokit({ auth: token });
            const { id: gistId, isNew } = await findOrCreateGist(octokit);
            term.green(`\n  ✓ ${isNew ? 'Created new' : 'Found existing'} gist\n`);

            // Create and save configuration
            const config = {
                nodeType: isServer ? 'server' : 'connector',
                githubToken: token,
                gistId: gistId,
                identifier: identifier,  // Will be null for server
                sshPort: sshPort,       // Will be null for connector
                lastRun: new Date().toISOString()
            };

            await saveConfig(config);

            // Show success message
            drawHeader('Setup Complete!');
            term.green(`
  Configuration saved successfully!
  
  Your ${config.nodeType} node will:
  ${config.nodeType === 'connector' ? `
  - Track IP changes for: ${identifier}
  - Update the central gist every ${UPDATE_INTERVAL / 60000} minutes
  - Show real-time status updates` : `
  - Monitor IP whitelist changes
  - Manage UFW rules for port ${sshPort}
  - Update firewall automatically`}
  
  Press any key to start...`);

            await term.inputField({ echo: false }).promise;
            return config;

        } catch (error) {
            term.red(`\n  Error: ${error.message}\n\n`);
            term.white('  What would you like to do?\n');
            const choice = await showMenu([
                'Try again',
                'Show help',
                'Exit'
            ]);

            switch (choice) {
                case 0: continue;
                case 1: 
                    await showWelcomeScreen();
                    continue;
                case 2:
                    process.exit(0);
            }
        }
    }
}

// next part

// Connector Node Implementation
async function runConnectorNode(config) {
    let lastIP = '';
    let lastCheck = null;
    let isUpdating = false;
    let currentView = 'main';
    let isViewChanging = false;

    // Function to handle IP updates
    async function updateIP() {
        if (isUpdating) return;
        isUpdating = true;
        
        try {
            term.saveCursor();
            term.column(2).eraseLine();
            term.yellow('Checking current IP...');
            
            const response = await fetch('https://api.ipify.org?format=json');
            const { ip } = await response.json();
            
            lastCheck = new Date();
            
            if (ip === lastIP) {
                term.column(2).eraseLine();
                term.green(`✓ IP unchanged (${ip})`);
                term.column(2).down(1).eraseLine();
                term.gray(`Last check: ${lastCheck.toLocaleString()}`);
                term.restoreCursor();
                isUpdating = false;
                return;
            }
            
            lastIP = ip;
            term.column(2).eraseLine();
            term.yellow(`IP changed to: ${ip}, updating whitelist...`);
            
            const octokit = new Octokit({ auth: config.githubToken });
            const gist = await octokit.gists.get({ gist_id: config.gistId });
            const currentContent = JSON.parse(gist.data.files[GIST_FILENAME].content || '{}');
            
            currentContent[config.domain] = ip;
            
            await octokit.gists.update({
                gist_id: config.gistId,
                files: {
                    [GIST_FILENAME]: {
                        content: JSON.stringify(currentContent, null, 2)
                    }
                }
            });
            
            config.lastRun = new Date().toISOString();
            await saveConfig(config);
            
            term.column(2).eraseLine();
            term.green(`✓ IP updated successfully to: ${ip}`);
            term.column(2).down(1).eraseLine();
            term.gray(`Last update: ${lastCheck.toLocaleString()}`);
        } catch (error) {
            term.column(2).eraseLine();
            term.red(`✗ Error: ${error.message}`);
            throw error;
        } finally {
            isUpdating = false;
            term.restoreCursor();
        }
    }

    // Function to show the main view
    async function showMainView() {
        currentView = 'main';
        term.clear();
        drawHeader('Connector Node Active');
        term.white(`
  Identifier: ${config.domain}
  Status: Monitoring IP changes
  Update frequency: Every ${UPDATE_INTERVAL / 60000} minutes
  
  Controls:
  - Press R to refresh manually
  - Press C to view current configuration
  - Press H for help
  - Press CTRL+C to exit
  
  Activity Log:
`);
    }

    // Set up keyboard event handling
    term.on('key', async (key) => {
        if (isViewChanging) return;
        isViewChanging = true;

        try {
            // Always handle CTRL+C regardless of view
            if (key === 'CTRL_C') {
                term.clear();
                term.green('\n  Shutting down gracefully...\n');
                process.exit(0);
            }

            switch (key.toLowerCase()) {
                case 'r':
                    if (currentView === 'main') {
                        await updateIP();
                    }
                    break;

                case 'c':
                    if (currentView === 'main') {
                        term.clear();
                        drawHeader('Current Configuration');
                        term.white(`
  Node Type: Connector
  Domain: ${config.domain}
  Gist ID: ${config.gistId}
  Last Run: ${new Date(config.lastRun).toLocaleString()}
  Current IP: ${lastIP || 'Not yet determined'}
  
  Press any key to return to main view...`);
                        currentView = 'config';
                        await term.inputField({ echo: false }).promise;
                        await showMainView();
                    }
                    break;

                case 'h':
                    if (currentView === 'main') {
                        term.clear();
                        drawHeader('Help');
                        term.white(`
  Connector Node Help:
  
  This node monitors your IP address and updates the central
  whitelist when changes are detected. The server nodes will
  automatically pick up these changes.
  
  Troubleshooting:
  - If updates fail, check your internet connection
  - Verify your GitHub token hasn't expired
  - Ensure the gist is accessible
  
  Press any key to return to main view...`);
                        currentView = 'help';
                        await term.inputField({ echo: false }).promise;
                        await showMainView();
                    }
                    break;
            }
        } finally {
            isViewChanging = false;
        }
    });

    // Initialize the display
    await showMainView();
    await updateIP();
    return setInterval(updateIP, UPDATE_INTERVAL);
}

// Server Node Implementation
async function runServerNode(config) {
    let lastUpdate = null;
    let isUpdating = false;
    let currentRules = new Set();
    
    async function updateRules() {
        if (isUpdating) return;
        isUpdating = true;
        
        try {
            term.saveCursor();
            term.column(2).eraseLine();
            
            // Verify system requirements again
            term.yellow('Verifying system requirements...');
            if (!await checkAndConfigureSSH() || !await checkAndConfigureUFW()) {
                throw new Error('System requirements check failed');
            }
            
            // Fetch current whitelist
            term.column(2).eraseLine();
            term.yellow('Fetching whitelist...');
            
            const octokit = new Octokit({ auth: config.githubToken });
            const gist = await octokit.gists.get({ gist_id: config.gistId });
            const allowedIPs = JSON.parse(gist.data.files[GIST_FILENAME].content);
            
            // Get current UFW rules
            const rules = await getExistingUFWRules();
            const newRules = new Set(Object.values(allowedIPs));
            
            // Remove rules that are no longer in the whitelist
            term.column(2).eraseLine();
            term.yellow('Updating firewall rules...');
            
            for (const rule of rules) {
                const ipMatch = rule.line.match(/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/);
                if (ipMatch && !newRules.has(ipMatch[0])) {
                    term.column(2).eraseLine();
                    term.yellow(`Removing old rule: ${ipMatch[0]}`);
                    await removeUFWRule(rule.number);
                }
            }
            
            // Add new rules
            for (const [domain, ip] of Object.entries(allowedIPs)) {
                if (!currentRules.has(ip)) {
                    term.column(2).eraseLine();
                    term.yellow(`Adding rule for ${domain}: ${ip}`);
                    await addUFWRule(ip);
                    currentRules.add(ip);
                }
            }
            
            // Update last run timestamp in config
            lastUpdate = new Date();
            config.lastRun = lastUpdate.toISOString();
            await saveConfig(config);
            
            term.column(2).eraseLine();
            term.green('✓ Firewall rules updated successfully');
            term.column(2).down(1).eraseLine();
            term.gray(`Last update: ${lastUpdate.toLocaleString()}`);
        } catch (error) {
            term.column(2).eraseLine();
            term.red(`✗ Error: ${error.message}`);
            throw error;
        } finally {
            isUpdating = false;
            term.restoreCursor();
        }
    }
    
    drawHeader('Server Node Active');
    term.white(`
  Identifier: ${config.domain}
  Status: Monitoring whitelist
  Update frequency: Every ${UPDATE_INTERVAL / 60000} minutes
  
  Controls:
  - Press R to refresh manually
  - Press C to view current configuration
  - Press L to view current whitelist
  - Press H for help
  - Press CTRL+C to exit
  
  Activity Log:
`);
    
    // Handle keyboard controls
    term.on('key', async (key) => {
        if (key.toLowerCase() === 'r') {
            await updateRules();
        } else if (key.toLowerCase() === 'c') {
            term.saveCursor();
            drawHeader('Current Configuration');
            term.white(`
  Node Type: Server
  Domain: ${config.domain}
  Gist ID: ${config.gistId}
  Last Update: ${lastUpdate ? lastUpdate.toLocaleString() : 'Never'}
  Active Rules: ${currentRules.size}
  
  Press any key to return...`);
            await term.inputField({ echo: false }).promise;
            drawHeader('Server Node Active');
            term.restoreCursor();
        } else if (key.toLowerCase() === 'l') {
            term.saveCursor();
            const octokit = new Octokit({ auth: config.githubToken });
            const gist = await octokit.gists.get({ gist_id: config.gistId });
            const whitelist = JSON.parse(gist.data.files[GIST_FILENAME].content);
            
            drawHeader('Current Whitelist');
            term.white('\n  Active IP Whitelist:\n\n');
            Object.entries(whitelist).forEach(([domain, ip]) => {
                term.white(`  ${domain}: `);
                term.green(`${ip}\n`);
            });
            term.white('\n  Press any key to return...');
            await term.inputField({ echo: false }).promise;
            drawHeader('Server Node Active');
            term.restoreCursor();
        } else if (key.toLowerCase() === 'h') {
            term.saveCursor();
            drawHeader('Help');
            term.white(`
  Server Node Help:
  
  This node monitors the central whitelist and automatically
  updates UFW rules to allow SSH access from whitelisted IPs.
  
  Troubleshooting:
  - Ensure UFW is running: sudo ufw status
  - Check SSH service: sudo systemctl status ssh
  - Verify GitHub token hasn't expired
  - Check UFW logs: sudo tail -f /var/log/ufw.log
  
  Press any key to return...`);
            await term.inputField({ echo: false }).promise;
            drawHeader('Server Node Active');
            term.restoreCursor();
        }
    });
    
    await updateRules();
    return setInterval(updateRules, UPDATE_INTERVAL);
}

//[Continued in final part...]

// Main Application Logic
async function main() {
    // Handle unexpected shutdowns
    process.on('SIGINT', () => {
        term.clear();
        term.green('\n  Shutting down gracefully...\n');
        process.exit(0);
    });

    process.on('uncaughtException', async (error) => {
        term.red(`\n  Unexpected error: ${error.message}\n`);
        term.white('  Press any key to restart...');
        await term.inputField({ echo: false }).promise;
        process.exit(1);
    });

    while (true) {
        try {
            // Load existing configuration
            let config = await loadConfig();
            
            // Show initial menu
            config = await showInitialMenu(config);
            
            if (!config) {
                continue; // User cancelled or returned to menu
            }

            // Verify configuration before starting
            term.yellow('\n  Verifying configuration...');
            
            // Check GitHub access
            if (!await verifyGitHubToken(config.githubToken)) {
                throw new Error(
                    'GitHub token has expired or is invalid.\n' +
                    '  Please set up a new configuration with a valid token.'
                );
            }

            // Additional checks for server node
            if (config.nodeType === 'server') {
                if (process.platform !== 'linux') {
                    throw new Error(
                        'Server node can only run on Linux systems.\n' +
                        '  Please use this machine as a connector node instead.'
                    );
                }

                // Verify system requirements
                const hasSudo = await checkSudo();
                if (!hasSudo) {
                    throw new Error(
                        'Sudo access is required for server node.\n' +
                        '  Please run with sudo privileges.'
                    );
                }

                // Check SSH and UFW
                term.yellow('\n  Checking system requirements...');
                if (!await checkAndConfigureSSH() || !await checkAndConfigureUFW()) {
                    throw new Error(
                        'System requirements not met.\n' +
                        '  Please check the system requirements and try again.'
                    );
                }
            }

            // Start appropriate node type
            let interval;
            if (config.nodeType === 'connector') {
                interval = await runConnectorNode(config);
            } else {
                interval = await runServerNode(config);
            }

            // Set up cleanup for graceful shutdown
            const cleanup = () => {
                clearInterval(interval);
                term.clear();
                term.green('\n  Shutting down gracefully...\n');
                process.exit(0);
            };

            // Handle various exit signals
            process.on('SIGINT', cleanup);
            process.on('SIGTERM', cleanup);
            process.on('SIGHUP', cleanup);

            // Exit the while loop if everything is running
            break;

        } catch (error) {
            term.red(`\n  Error: ${error.message}\n\n`);
            term.white('  What would you like to do?\n');
            
            const choices = [
                'Try again',
                'Reset configuration',
                'View system status',
                'Show help',
                'Exit'
            ];

            const choice = await showMenu(choices);

            switch (choice) {
                case 0: // Try again
                    continue;
                    
                case 1: // Reset configuration
                    await deleteConfig();
                    term.yellow('\n  Configuration reset. Starting fresh...\n');
                    await new Promise(resolve => setTimeout(resolve, 1500));
                    continue;
                    
                case 2: // View system status
                    await performSystemCheck();
                    continue;
                    
                case 3: // Show help
                    await showWelcomeScreen();
                    continue;
                    
                case 4: // Exit
                default:
                    term.clear();
                    process.exit(0);
            }
        }
    }
}

// Application Recovery Functions
async function attemptRecovery(error, config) {
    term.red(`\n  Error occurred: ${error.message}\n`);
    term.yellow('  Attempting recovery...\n');

    try {
        // Verify basic connectivity
        await fetch('https://api.github.com');
        term.green('  ✓ Internet connection is working\n');

        // Verify GitHub access
        if (await verifyGitHubToken(config.githubToken)) {
            term.green('  ✓ GitHub token is valid\n');
        } else {
            term.red('  ✗ GitHub token is invalid\n');
            return false;
        }

        // For server nodes, verify system requirements
        if (config.nodeType === 'server') {
            if (await checkAndConfigureSSH()) {
                term.green('  ✓ SSH server is running\n');
            } else {
                term.red('  ✗ SSH server check failed\n');
                return false;
            }

            if (await checkAndConfigureUFW()) {
                term.green('  ✓ UFW is configured\n');
            } else {
                term.red('  ✗ UFW check failed\n');
                return false;
            }
        }

        return true;
    } catch (recoveryError) {
        term.red(`  Recovery failed: ${recoveryError.message}\n`);
        return false;
    }
}

// Start the application with error handling
async function startApplication() {
    try {
        await main();
    } catch (error) {
        term.red(`\n  Fatal error: ${error.message}\n`);
        term.white('  Press any key to exit...\n');
        await term.inputField({ echo: false }).promise;
        process.exit(1);
    }
}

// Initialize and run the application
startApplication();
