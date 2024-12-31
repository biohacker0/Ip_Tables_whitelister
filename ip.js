#!/usr/bin/env bun
// ip-manager.js
import { Octokit } from "@octokit/rest";
import { $ } from "bun";
import prompts from 'prompts';
import chalk from 'chalk';
import os from 'os';
import path from 'path';
import { existsSync, mkdirSync } from 'fs';
import { readFile, writeFile } from 'fs/promises';

// Constants
const CONFIG_DIR = path.join(os.homedir(), '.ip-manager');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');
const STATE_FILE = path.join(CONFIG_DIR, 'ufw-state.json');
let lastCredentials = null;
let lastDomain = null;

// Ensure config directory exists
if (!existsSync(CONFIG_DIR)) {
    mkdirSync(CONFIG_DIR, { recursive: true });
}

// System Check Types
const SystemRequirements = {
    CONNECTOR: ['ssh'],
    SERVER: ['ssh', 'ufw'],
    ALL: ['bun', 'ssh', 'ufw']
};

// Utility functions
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

class SystemChecker {
    constructor() {
        this.platform = os.platform();
    }

    async checkBun() {
        try {
            await $`bun -v`;
            return { installed: true, status: 'active' };
        } catch {
            return { installed: false, status: 'not found' };
        }
    }

    async checkSSH() {
        try {
            if (this.platform === 'win32') {
                await $`where ssh`;
                return { installed: true, status: 'installed' };
            } else {
                const sshStatus = await $`systemctl status ssh`;
                const isActive = sshStatus.stdout.includes('active (running)');
                return {
                    installed: true,
                    status: isActive ? 'active' : 'inactive',
                    needsStart: !isActive
                };
            }
        } catch {
            return { installed: false, status: 'not installed' };
        }
    }

    async checkUFW() {
        try {
            if (this.platform === 'win32') {
                return { installed: false, status: 'not supported on Windows' };
            }
            
            const ufwInstalled = await $`which ufw`;
            if (!ufwInstalled) {
                return { installed: false, status: 'not installed' };
            }

            const ufwStatus = await $`sudo ufw status`;
            const isActive = ufwStatus.stdout.includes('Status: active');
            
            return {
                installed: true,
                status: isActive ? 'active' : 'inactive',
                needsEnable: !isActive
            };
        } catch {
            return { installed: false, status: 'not installed' };
        }
    }

    getInstallCommand(service) {
        if (this.platform === 'win32') {
            return 'Please visit https://docs.microsoft.com/windows-server/administration/openssh/openssh_install_firstuse';
        }

        const commands = {
            ssh: {
                ubuntu: 'sudo apt-get install openssh-server',
                fedora: 'sudo dnf install openssh-server',
                macos: 'SSH comes pre-installed on macOS'
            },
            ufw: {
                ubuntu: 'sudo apt-get install ufw',
                fedora: 'sudo dnf install ufw',
                macos: 'brew install ufw'
            }
        };

        // For Linux, try to detect distribution
        try {
            const osRelease = readFileSync('/etc/os-release', 'utf8');
            if (osRelease.includes('Ubuntu')) return commands[service].ubuntu;
            if (osRelease.includes('Fedora')) return commands[service].fedora;
        } catch {}

        // Default to Ubuntu commands
        return commands[service].ubuntu;
    }

    async getServiceStatus(service) {
        switch (service) {
            case 'bun':
                return await this.checkBun();
            case 'ssh':
                return await this.checkSSH();
            case 'ufw':
                return await this.checkUFW();
            default:
                return { installed: false, status: 'unknown' };
        }
    }

    async checkAndDisplayStatus(mode) {
        const services = SystemRequirements[mode];
        const status = {};
        let allGood = true;

        console.log(chalk.cyan('\nSystem Requirements Check:\n'));

        for (const service of services) {
            status[service] = await this.getServiceStatus(service);
            const serviceStatus = status[service];
            
            let statusSymbol, statusColor, statusMessage;
            if (!serviceStatus.installed) {
                statusSymbol = '❌';
                statusColor = 'red';
                statusMessage = `Not installed - Run: ${this.getInstallCommand(service)}`;
                allGood = false;
            } else if (serviceStatus.status === 'inactive' || serviceStatus.needsStart || serviceStatus.needsEnable) {
                statusSymbol = '⚠️';
                statusColor = 'yellow';
                statusMessage = service === 'ufw' ? 'Inactive - Run: sudo ufw enable' : 
                              `Inactive - Run: sudo systemctl start ${service}`;
                allGood = false;
            } else {
                statusSymbol = '✅';
                statusColor = 'green';
                statusMessage = 'Active and running';
            }

            console.log(`${statusSymbol} ${chalk.bold(service.toUpperCase())}: ${chalk[statusColor](statusMessage)}`);
        }

        console.log(''); // Empty line for readability
        return { status, allGood };
    }
}

class GistManager {
    constructor(token) {
        this.octokit = new Octokit({ auth: token });
    }

    async validateToken() {
        try {
            await this.octokit.rest.users.getAuthenticated();
            return true;
        } catch {
            return false;
        }
    }

    async createGist(domain, ip) {
        try {
            const response = await this.octokit.request('POST /gists', {
                description: 'IP_TABLE',
                public: false,
                files: {
                    'config.json': {
                        content: JSON.stringify({ [domain]: ip }, null, 2)
                    }
                },
                headers: {
                    'X-GitHub-Api-Version': '2022-11-28'
                }
            });
            return response.data.id;
        } catch (error) {
            throw new Error("Failed to create gist: " + error.message);
        }
    }

    async getGistContent(gist) {
        try {
            const raw_url = gist.files['config.json'].raw_url;
            const response = await fetch(raw_url);
            const text = await response.text();
            try {
                return JSON.parse(text);
            } catch (parseError) {
                console.log(chalk.yellow('Warning: Invalid JSON in gist, creating fresh configuration.'));
                return {};
            }
        } catch (error) {
            throw new Error("Failed to fetch gist content: " + error.message);
        }
    }

    async getAllGists() {
        try {
            const response = await this.octokit.request('GET /gists', {
                headers: {
                    'X-GitHub-Api-Version': '2022-11-28'
                }
            });
            return response.data;
        } catch (error) {
            throw new Error("Failed to fetch gists: " + error.message);
        }
    }

    async updateGist(gistId, content) {
        try {
            await this.octokit.request('PATCH /gists/{gist_id}', {
                gist_id: gistId,
                files: {
                    'config.json': {
                        content: JSON.stringify(content, null, 2)
                    }
                },
                headers: {
                    'X-GitHub-Api-Version': '2022-11-28'
                }
            });
        } catch (error) {
            throw new Error("Failed to update gist: " + error.message);
        }
    }
}

class UFWManager {
    constructor(port) {
        this.port = port;
    }

    async addRule(ip) {
        try {
            await $`sudo ufw allow from ${ip} to any port ${this.port}`;
            console.log(chalk.green(`Added UFW rule for ${ip}`));
        } catch (error) {
            throw new Error(`Failed to add UFW rule: ${error.message}`);
        }
    }

    async removeRule(ip) {
        try {
            await $`sudo ufw delete allow from ${ip} to any port ${this.port}`;
            console.log(chalk.yellow(`Removed UFW rule for ${ip}`));
        } catch (error) {
            throw new Error(`Failed to remove UFW rule: ${error.message}`);
        }
    }

    async listRules() {
        try {
            const result = await $`sudo ufw status numbered`;
            console.log(result.stdout);
        } catch (error) {
            throw new Error(`Failed to list UFW rules: ${error.message}`);
        }
    }
}

// Configuration Management
async function loadConfig() {
    try {
        if (existsSync(CONFIG_FILE)) {
            const config = JSON.parse(await readFile(CONFIG_FILE, 'utf8'));
            lastCredentials = { token: config.token };
            lastDomain = config.domain;
        }
    } catch (error) {
        console.error(chalk.yellow('Warning: Could not load saved configuration'));
    }
}

async function saveConfig(token, domain) {
    try {
        await writeFile(CONFIG_FILE, JSON.stringify({ token, domain }, null, 2));
    } catch (error) {
        console.error(chalk.yellow('Warning: Could not save configuration'));
    }
}

async function getDeviceIp() {
    try {
        const response = await fetch("https://api.ipify.org?format=json");
        const data = await response.json();
        return data.ip;
    } catch (error) {
        throw new Error("Failed to fetch device IP: " + error.message);
    }
}

// CLI Interface
async function mainMenu() {
    console.clear();
    console.log(chalk.cyan.bold('🌐 IP Manager CLI\n'));

    const systemChecker = new SystemChecker();
    const { status, allGood } = await systemChecker.checkAndDisplayStatus('ALL');

    const choices = [
        { 
            title: 'Connector Node (IP Updater)',
            value: 'connector',
            disabled: !status.ssh?.installed
        },
        { 
            title: 'Server Node (UFW Manager)',
            value: 'server',
            disabled: !status.ufw?.installed || !status.ssh?.installed
        }
    ];

    if (lastCredentials) {
        choices.push({ 
            title: 'Refresh IP (Use Last Settings)',
            value: 'refresh',
            disabled: !status.ssh?.installed
        });
    }
    
    choices.push({ title: 'Exit', value: 'exit' });

    const response = await prompts({
        type: 'select',
        name: 'mode',
        message: 'Select operation mode:',
        choices: choices,
        hint: !allGood ? '⚠️ Some required services are not ready' : undefined
    });

    return response.mode;
}

async function getCredentials(useLastCredentials = false) {
    if (useLastCredentials && lastCredentials) {
        return lastCredentials;
    }

    const creds = await prompts([
        {
            type: 'password',
            name: 'token',
            message: 'Enter your GitHub token:'
        }
    ]);

    lastCredentials = creds;
    return creds;
}

async function getDomain(useLastDomain = false) {
    if (useLastDomain && lastDomain) {
        return { domain: lastDomain };
    }

    const result = await prompts({
        type: 'text',
        name: 'domain',
        message: 'Enter domain/identifier for this node:'
    });

    lastDomain = result.domain;
    return result;
}

async function getSshPort() {
    const result = await prompts({
        type: 'number',
        name: 'port',
        message: 'Enter SSH port number:',
        initial: 22,
        validate: value => value > 0 && value < 65536
    });
    return result;
}

async function connectorMode(useLastSettings = false) {
    console.clear();
    console.log(chalk.cyan.bold('📡 Connector Node Configuration\n'));

    const systemChecker = new SystemChecker();
    const { status, allGood } = await systemChecker.checkAndDisplayStatus('CONNECTOR');

    if (!allGood) {
        console.log(chalk.yellow('\nPlease install and configure the required services before continuing.'));
        await prompts({
            type: 'confirm',
            name: 'acknowledge',
            message: 'Press Enter to continue...',
            initial: true
        });
        return;
    }

    try {
        // Get credentials
        const { token } = await getCredentials(useLastSettings);
        if (!token) {
            console.log(chalk.red('Token is required!'));
            return;
        }

        const gistManager = new GistManager(token);

        // Validate token
        if (!await gistManager.validateToken()) {
            console.log(chalk.red('Invalid GitHub token!'));
            lastCredentials = null;
            return;
        }

        // Get domain identifier
        const { domain } = await getDomain(useLastSettings);
        if (!domain) {
            console.log(chalk.red('Domain is required!'));
            return;
        }

        // Save valid configuration
        await saveConfig(token, domain);

        // Get current IP
        const ip = await getDeviceIp();
        console.log(chalk.cyan(`Current IP: ${ip}`));

        // Handle gist operations
        const gists = await gistManager.getAllGists();
        const configGist = gists.find(g => g.files['config.json']);

        if (configGist) {
            const currentContent = await gistManager.getGistContent(configGist);
            currentContent[domain] = ip;
            await gistManager.updateGist(configGist.id, currentContent);
            console.log(chalk.green('Successfully updated IP in gist!'));
        } else {
            const gistId = await gistManager.createGist(domain, ip);
            console.log(chalk.green(`Created new gist with ID: ${gistId}`));
        }

    } catch (error) {
        console.error(chalk.red(`Error: ${error.message}`));
        return await retryMenu();
    }
}

async function serverMode() {
    console.clear();
    console.log(chalk.cyan.bold('🖥️  Server Node Configuration\n'));

    const systemChecker = new SystemChecker();
    const { status, allGood } = await systemChecker.checkAndDisplayStatus('SERVER');

    if (!allGood) {
        console.log(chalk.yellow('\nPlease install and configure the required services before continuing.'));
        await prompts({
            type: 'confirm',
            name: 'acknowledge',
            message: 'Press Enter to continue...',
            initial: true
        });
        return;
    }

    try {
        // Get SSH port
        const { port } = await getSshPort();

        // Get credentials
        const { token } = await getCredentials();
        if (!token) {
            console.log(chalk.red('Token is required!'));
            return;
        }

        const gistManager = new GistManager(token);
        const ufwManager = new UFWManager(port);
        const localStateFile = path.join(CONFIG_DIR, 'ufw-state.json');

        // Validate token
        if (!await gistManager.validateToken()) {
            console.log(chalk.red('Invalid GitHub token!'));
            return;
        }

        // Get gist data
        const gists = await gistManager.getAllGists();
        const configGist = gists.find(g => g.files['config.json']);

        if (!configGist) {
            console.log(chalk.yellow('No configuration gist found!'));
            return;
        }

        const newData = await gistManager.getGistContent(configGist);
        
        // Load local state
        let oldData = {};
        try {
            if (existsSync(localStateFile)) {
                oldData = JSON.parse(await readFile(localStateFile, 'utf8'));
            }
        } catch (error) {
            console.log(chalk.yellow('Warning: Could not load local state, treating all entries as new'));
        }
        
        // Process each IP
        for (const [domain, ip] of Object.entries(newData)) {
            try {
                if (!oldData.hasOwnProperty(domain)) {
                    // New domain, just add the rule
                    console.log(chalk.cyan(`Adding new rule for ${domain} (${ip})`));
                    await ufwManager.addRule(ip);
                } else if (oldData[domain] !== ip) {
                    // IP has changed, remove old rule and add new one
                    console.log(chalk.yellow(`Updating rule for ${domain} (${oldData[domain]} -> ${ip})`));
                    await ufwManager.removeRule(oldData[domain]);
                    await ufwManager.addRule(ip);
                } else {
                    // Same IP, no change needed
                    console.log(chalk.green(`No change for ${domain} (${ip})`));
                }
            } catch (error) {
                console.error(chalk.red(`Failed to update rules for ${domain}: ${error.message}`));
            }
            await delay(1000); // Prevent overwhelming UFW
        }

        // Remove rules for domains that no longer exist
        for (const [oldDomain, oldIp] of Object.entries(oldData)) {
            if (!newData.hasOwnProperty(oldDomain)) {
                try {
                    console.log(chalk.yellow(`Removing rule for deleted domain ${oldDomain} (${oldIp})`));
                    await ufwManager.removeRule(oldIp);
                } catch (error) {
                    console.error(chalk.red(`Failed to remove old rule for ${oldDomain}: ${error.message}`));
                }
                await delay(1000);
            }
        }

        // Save new state
        await writeFile(localStateFile, JSON.stringify(newData, null, 2));

        // Show current UFW rules
        console.log(chalk.cyan('\nCurrent UFW rules:'));
        await ufwManager.listRules();

    } catch (error) {
        console.error(chalk.red(`Error: ${error.message}`));
        return await retryMenu();
    }
}

async function retryMenu() {
    const choices = [
        { title: 'Retry Current Operation', value: 'retry' },
        { title: 'Refresh (Use Last Settings)', value: 'refresh' },
        { title: 'System Status Check', value: 'status' },
        { title: 'Main Menu', value: 'main' },
        { title: 'Exit', value: 'exit' }
    ];

    const { action } = await prompts({
        type: 'select',
        name: 'action',
        message: 'What would you like to do?',
        choices: choices
    });

    if (action === 'status') {
        const systemChecker = new SystemChecker();
        await systemChecker.checkAndDisplayStatus('ALL');
        return await retryMenu();
    }

    return action;
}

// Main application loop
async function main() {
    // Load saved configuration
    await loadConfig();

    while (true) {
        const mode = await mainMenu();

        if (mode === 'exit') {
            console.log(chalk.cyan('\nGoodbye! 👋\n'));
            break;
        }

        if (mode === 'connector') {
            await connectorMode(false);
        } else if (mode === 'server') {
            await serverMode();
        } else if (mode === 'refresh') {
            await connectorMode(true);
        }

        const retry = await retryMenu();
        if (retry === 'exit') {
            console.log(chalk.cyan('\nGoodbye! 👋\n'));
            break;
        } else if (retry === 'main') {
            continue;
        } else if (retry === 'refresh') {
            await connectorMode(true);
        } else if (retry === 'retry') {
            if (mode === 'connector') {
                await connectorMode(false);
            } else if (mode === 'server') {
                await serverMode();
            }
        }
    }
}

main().catch(console.error);
