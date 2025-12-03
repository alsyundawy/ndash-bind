const fs = require('fs-extra');
const path = require('path');
const { exec } = require('child_process');
const util = require('util');
const execPromise = util.promisify(exec);
const config = require('../config');
const bindConfig = require('../utils/bindConfig');
const settingsUtil = require('../utils/settings');
const { activityLogger } = require('../utils/activityLogger');

/**
 * Bind Service - Handles all interactions with Bind DNS server
 */
class BindService {
    constructor() {
        this.zonesPath = config.bind.zonesPath;
        this.confPath = config.bind.confPath;
        this.namedConfLocal = '/etc/bind/named.conf.local';
    }

    /**
     * Initialize - Ensure directories exist
     */
    async initialize() {
        try {
            await fs.ensureDir(this.zonesPath);
            console.log(`✓ Bind zones directory ready: ${this.zonesPath}`);
            // If views configured, ensure zones from other files (like root-hints) are moved into a 'global' view
            try {
                const settings = await settingsUtil.loadSettings();
                const viewsList = settings.resolver?.views || [];
                if (viewsList.length > 0) {
                    // Move root-hints zones into global view if needed
                    await bindConfig.moveZonesFromFileToGlobal('/etc/bind/named.conf.root-hints', 'global', { allow: ['any'] });
                }
            } catch (err) {
                console.warn('Failed to ensure zones from other config files moved to views:', err.message);
            }
            return true;
        } catch (error) {
            console.error(`✗ Failed to initialize Bind service: ${error.message}`);
            return false;
        }
    }

    /**
     * List all zones from named.conf.local
     */
    async listZones() {
        try {
            const configContent = await fs.readFile(this.namedConfLocal, 'utf8');
            const zonesMap = new Map(); // Use Map to deduplicate by zone name

            // Helper function to extract zone type from zone block
            const extractZoneType = (zoneBlock) => {
                const typeMatch = /type\s+(\w+);/.exec(zoneBlock);
                return typeMatch ? typeMatch[1] : 'master';
            };

            // Parse view blocks first and collect zones with view assignment
            const viewRegex = /view\s+"([^"]+)"\s*\{([\s\S]*?)\n\};/g;
            let vmatch;
            while ((vmatch = viewRegex.exec(configContent)) !== null) {
                const viewName = vmatch[1];
                const viewBody = vmatch[2];
                const zoneRegex = /zone\s+"([^"]+)"\s*\{([\s\S]*?)\};/g;
                let zmatch;
                while ((zmatch = zoneRegex.exec(viewBody)) !== null) {
                    const zoneName = zmatch[1];
                    const zoneBlockContent = zmatch[2];
                    const fileMatch = /file\s+"([^"]+)";/.exec(zoneBlockContent);
                    if (!fileMatch) continue;
                    
                    const zoneFile = fileMatch[1].startsWith('/') ? fileMatch[1] : path.join('/etc/bind', fileMatch[1]);
                    
                    // Skip if we already have this zone
                    if (zonesMap.has(zoneName)) continue;
                    
                    const zoneType = extractZoneType(zoneBlockContent);
                    
                    let lastModified = new Date();
                    let recordCount = 0;
                    try {
                        const stats = await fs.stat(zoneFile);
                        lastModified = stats.mtime;
                        const zoneContent = await fs.readFile(zoneFile, 'utf8');
                        const records = this.parseZoneFile(zoneContent);
                        recordCount = records.length;
                    } catch (err) {
                        console.warn(`Warning: Could not read zone file ${zoneFile}`);
                    }
                    
                    zonesMap.set(zoneName, {
                        id: zonesMap.size + 1,
                        name: zoneName,
                        type: zoneType,
                        file: zoneFile,
                        status: 'active',
                        records: recordCount,
                        lastModified: lastModified,
                        view: viewName
                    });
                }
            }

            // Parse top-level zone blocks (not inside a view)
            // Remove all view blocks so we only process top-level zones
            const contentWithoutViews = configContent.replace(viewRegex, '\n');
            const zoneRegex = /zone\s+"([^"]+)"\s+\{([\s\S]*?)\};/g;
            let match;
            while ((match = zoneRegex.exec(contentWithoutViews)) !== null) {
                const zoneName = match[1];
                const zoneBlockContent = match[2];
                const fileMatch = /file\s+"([^"]+)";/.exec(zoneBlockContent);
                if (!fileMatch) continue;
                
                const zoneFile = fileMatch[1].startsWith('/') ? fileMatch[1] : path.join('/etc/bind', fileMatch[1]);
                
                // Skip if we already have this zone
                if (zonesMap.has(zoneName)) continue;
            
                const zoneType = extractZoneType(zoneBlockContent);
                
                // Get zone file stats
                let lastModified = new Date();
                let recordCount = 0;
                
                try {
                    const stats = await fs.stat(zoneFile);
                    lastModified = stats.mtime;
                    
                    // Count records in zone file
                    const zoneContent = await fs.readFile(zoneFile, 'utf8');
                    const records = this.parseZoneFile(zoneContent);
                    recordCount = records.length;
                } catch (err) {
                    console.warn(`Warning: Could not read zone file ${zoneFile}`);
                }
                
                zonesMap.set(zoneName, {
                    id: zonesMap.size + 1,
                    name: zoneName,
                    type: zoneType,
                    file: zoneFile,
                    status: 'active',
                    records: recordCount,
                    lastModified: lastModified
                });
            }
            
            return Array.from(zonesMap.values());
        } catch (error) {
            console.error(`Error listing zones: ${error.message}`);
            return [];
        }
    }

    /**
     * Get zone details
     */
    async getZone(zoneName) {
        try {
            const zones = await this.listZones();
            const zone = zones.find(z => z.name === zoneName);
            
            if (!zone) {
                throw new Error(`Zone ${zoneName} not found`);
            }
            
            // Read and parse zone file
            const zoneContent = await fs.readFile(zone.file, 'utf8');
            const records = this.parseZoneFile(zoneContent);
            
            return {
                zone,
                records
            };
        } catch (error) {
            throw new Error(`Failed to get zone: ${error.message}`);
        }
    }

    /**
     * Create a new zone
     */
    async createZone(data) {
        try {
            // Get and clean zone name - remove leading/trailing whitespace
            let zoneName = (data.name || data.zoneName || '').trim();
            
            // Validate zone name
            if (!zoneName) {
                throw new Error('Zone name is required');
            }
            
            // Remove any extra spaces within the name
            zoneName = zoneName.replace(/\s+/g, '');
            
            // Load settings to check if auto-reload is enabled
            const settings = await settingsUtil.loadSettings();
            
            const options = {
                type: data.type || 'master',
                nameserver: data.nameserver || `ns1.${zoneName}.`,
                email: data.email || `admin.${zoneName}.`,
                ...data
            };
            
            // Remove trailing dot from zone name for file path
            const zoneFileName = zoneName.replace(/\.$/, '');
            const zoneFile = path.join(this.zonesPath, `db.${zoneFileName}`);
            
            // Check if zone already exists
            const existingZones = await this.listZones();
            if (existingZones.find(z => z.name === zoneName)) {
                throw new Error(`Zone ${zoneName} already exists`);
            }
            
            // Pass settings to zone generator
            options.settings = settings;
            
            // Generate zone file content
            const zoneContent = this.generateZoneFile(zoneName, options);
            
            // Backup if enabled
            if (settings.zones.backupEnabled) {
                const backupDir = path.join(this.zonesPath, 'backups');
                await fs.ensureDir(backupDir);
                console.log(`✓ Backup enabled - directory ready: ${backupDir}`);
            }
            
            // Write zone file
            await fs.writeFile(zoneFile, zoneContent, 'utf8');
            console.log(`✓ Created zone file: ${zoneFile}`);
            
            // Add zone to named.conf.local; support view-assignment for split-horizon
            if (options.view) {
                // look up view ACL from settings if present
                const settingsViews = settings.resolver?.views || [];
                const viewObj = settingsViews.find(v => v.name === options.view);
                const viewAcl = viewObj ? viewObj.acl : { allow: ['any'], deny: [] };
                await bindConfig.addZoneToViewConfig(zoneName, zoneFile, options.view, viewAcl);
                // Update settings to include this zone in the view's zones list
                try {
                    const settingsUtil = require('../utils/settings');
                    const settingsAll = await settingsUtil.loadSettings();
                    const viewsList = settingsAll.resolver?.views || [];
                    const vindex = viewsList.findIndex(v => v.name === options.view);
                    if (vindex !== -1) {
                        viewsList[vindex].zones = viewsList[vindex].zones || [];
                        if (!viewsList[vindex].zones.includes(zoneName)) {
                            viewsList[vindex].zones.push(zoneName);
                            await settingsUtil.updateSettings({ resolver: { views: viewsList } });
                        }
                    }
                } catch (err) {
                    console.warn(`Warning: Could not update settings with new zone view: ${err.message}`);
                }
            } else {
                await bindConfig.addZoneToConfig(zoneName, zoneFile);
            }
            console.log(`✓ Added zone to named.conf.local`);
            
            // Reload Bind if auto-reload is enabled
            if (settings.zones.autoReload) {
                await this.reloadBind();
                console.log(`✓ Auto-reload enabled - Bind reloaded`);
            } else {
                console.log(`⚠ Auto-reload disabled - Manual reload required`);
            }
            
            // Log activity
            await activityLogger.zoneCreated(zoneName, {
                type: options.type || 'master',
                zoneFile: zoneFile
            });
            
            return {
                success: true,
                name: zoneName,
                file: zoneFile,
                type: options.type || 'master'
            };
        } catch (error) {
            throw new Error(`Failed to create zone: ${error.message}`);
        }
    }

    /**
     * Add record to zone
     */
    async addRecord(zoneName, record) {
        try {
            // Load settings
            const settings = await settingsUtil.loadSettings();
            
            const { zone } = await this.getZone(zoneName);
            const zoneFile = zone.file;
            
            // Backup if enabled
            if (settings.zones.backupEnabled) {
                const backupFile = `${zoneFile}.backup.${Date.now()}`;
                await fs.copy(zoneFile, backupFile);
                console.log(`✓ Backup created: ${backupFile}`);
            }
            
            // Read current zone file
            let zoneContent = await fs.readFile(zoneFile, 'utf8');
            
            // Increment serial number
            zoneContent = this.incrementSerial(zoneContent);
            
            // Format and add new record
            const recordLine = this.formatRecord(record);
            
            // Add record before the closing of file
            zoneContent += `\n${recordLine}`;
            
            // Write updated zone file
            await fs.writeFile(zoneFile, zoneContent, 'utf8');
            console.log(`✓ Added record to ${zoneName}`);
            
            // Check zone syntax if validation is enabled
            if (settings.zones.validateBeforeReload) {
                await this.checkZone(zoneName, zoneFile);
                console.log(`✓ Zone validation passed`);
            }
            
            // Reload Bind if auto-reload is enabled
            if (settings.zones.autoReload) {
                await this.reloadBind();
                console.log(`✓ Auto-reload enabled - Bind reloaded`);
            }
            
            // Log activity
            await activityLogger.recordCreated(zoneName, record.name, record.type, {
                value: record.value,
                ttl: record.ttl
            });
            
            return { success: true };
        } catch (error) {
            throw new Error(`Failed to add record: ${error.message}`);
        }
    }

    /**
     * Delete record from zone
     */
    async deleteRecord(zoneName, recordName, recordType) {
        try {
            // Load settings
            const settings = await settingsUtil.loadSettings();
            
            const { zone } = await this.getZone(zoneName);
            const zoneFile = zone.file;
            
            // Backup if enabled
            if (settings.zones.backupEnabled) {
                const backupFile = `${zoneFile}.backup.${Date.now()}`;
                await fs.copy(zoneFile, backupFile);
                console.log(`✓ Backup created: ${backupFile}`);
            }
            
            // Read current zone file
            let zoneContent = await fs.readFile(zoneFile, 'utf8');
            
            // Increment serial number
            zoneContent = this.incrementSerial(zoneContent);
            
            // Remove the record line
            const lines = zoneContent.split('\n');
            const filteredLines = lines.filter(line => {
                const trimmed = line.trim();
                if (trimmed.startsWith(';') || !trimmed) return true;
                
                const parts = trimmed.split(/\s+/);
                if (parts.length >= 4) {
                    const name = parts[0];
                    const type = parts.includes('IN') ? parts[parts.indexOf('IN') + 1] : parts[3];
                    
                    if (name === recordName && type === recordType) {
                        return false; // Remove this line
                    }
                }
                return true;
            });
            
            zoneContent = filteredLines.join('\n');
            
            // Write updated zone file
            await fs.writeFile(zoneFile, zoneContent, 'utf8');
            console.log(`✓ Deleted record from ${zoneName}`);
            
            // Reload Bind if auto-reload is enabled
            if (settings.zones.autoReload) {
                await this.reloadBind();
                console.log(`✓ Auto-reload enabled - Bind reloaded`);
            }
            
            // Log activity
            await activityLogger.recordDeleted(zoneName, recordName, recordType);
            
            return { success: true };
        } catch (error) {
            throw new Error(`Failed to delete record: ${error.message}`);
        }
    }

    /**
     * Update/Edit record in zone
     */
    async updateRecord(zoneName, oldRecord, newRecord) {
        try {
            // Load settings
            const settings = await settingsUtil.loadSettings();
            
            const { zone } = await this.getZone(zoneName);
            const zoneFile = zone.file;
            
            // Backup if enabled
            if (settings.zones.backupEnabled) {
                const backupFile = `${zoneFile}.backup.${Date.now()}`;
                await fs.copy(zoneFile, backupFile);
                console.log(`✓ Backup created: ${backupFile}`);
            }
            
            // Read current zone file
            let zoneContent = await fs.readFile(zoneFile, 'utf8');
            
            // Increment serial number
            zoneContent = this.incrementSerial(zoneContent);
            
            // Find and replace the record line
            const lines = zoneContent.split('\n');
            let recordFound = false;
            
            const updatedLines = lines.map(line => {
                const trimmed = line.trim();
                if (trimmed.startsWith(';') || !trimmed) return line;
                
                const parts = trimmed.split(/\s+/);
                if (parts.length >= 4) {
                    const name = parts[0];
                    const type = parts.includes('IN') ? parts[parts.indexOf('IN') + 1] : parts[3];
                    
                    // Match old record by name and type
                    if (name === oldRecord.name && type === oldRecord.type && !recordFound) {
                        recordFound = true;
                        // Replace with new record
                        return this.formatRecord(newRecord);
                    }
                }
                return line;
            });
            
            if (!recordFound) {
                throw new Error(`Record not found: ${oldRecord.name} ${oldRecord.type}`);
            }
            
            zoneContent = updatedLines.join('\n');
            
            // Write updated zone file
            await fs.writeFile(zoneFile, zoneContent, 'utf8');
            console.log(`✓ Updated record in ${zoneName}`);
            
            // Check zone syntax if validation is enabled
            if (settings.zones.validateBeforeReload) {
                await this.checkZone(zoneName, zoneFile);
                console.log(`✓ Zone validation passed`);
            }
            
            // Reload Bind if auto-reload is enabled
            if (settings.zones.autoReload) {
                await this.reloadBind();
                console.log(`✓ Auto-reload enabled - Bind reloaded`);
            }
            
            // Log activity
            await activityLogger.recordUpdated(zoneName, newRecord.name, newRecord.type, {
                oldValue: oldRecord.value,
                newValue: newRecord.value,
                ttl: newRecord.ttl
            });
            
            return { success: true };
        } catch (error) {
            throw new Error(`Failed to update record: ${error.message}`);
        }
    }

    /**
     * Delete zone
     */
    async deleteZone(zoneName) {
        try {
            // Load settings
            const settings = await settingsUtil.loadSettings();
            
            let zoneData = null;
            let zoneFile = null;
            
            try {
                const result = await this.getZone(zoneName);
                zoneData = result.zone;
                zoneFile = result.zone.file;
            } catch (err) {
                // If getZone fails (e.g., zone file missing), try to get zone file from config
                console.warn(`Warning: Could not get full zone data: ${err.message}`);
                
                // Try to find zone file path from config
                const content = await fs.readFile(this.namedConfLocal, 'utf8');
                const zoneFileRegex = new RegExp(`zone\\s+"${zoneName}"\\s*\\{[\\s\\S]*?file\\s+"([^"]+)";`, 'g');
                const match = zoneFileRegex.exec(content);
                if (match) {
                    zoneFile = match[1];
                }
            }
            
            // Remove from named.conf.local
            await bindConfig.removeZoneFromConfig(zoneName);
            
            // Backup and delete zone file if it exists
            if (zoneFile && await fs.pathExists(zoneFile)) {
                const backupFile = `${zoneFile}.backup.${Date.now()}`;
                await fs.copy(zoneFile, backupFile);
                console.log(`✓ Backed up zone file to ${backupFile}`);
                
                // Delete zone file
                await fs.remove(zoneFile);
                console.log(`✓ Deleted zone file`);
            } else if (zoneFile) {
                console.log(`ℹ Zone file does not exist (may be a slave zone not yet synced): ${zoneFile}`);
            }

            // Remove from any view assignments in settings
            try {
                const settingsUtil = require('../utils/settings');
                const settingsAll = await settingsUtil.loadSettings();
                const viewsList = settingsAll.resolver?.views || [];
                let updated = false;
                for (let v of viewsList) {
                    if (v.zones && v.zones.includes(zoneName)) {
                        v.zones = v.zones.filter(z => z !== zoneName);
                        updated = true;
                    }
                }
                if (updated) {
                    await settingsUtil.updateSettings({ resolver: { views: viewsList } });
                }
            } catch (err) {
                console.warn(`Warning: Failed to remove zone from view settings: ${err.message}`);
            }
            
            // Validate config before reload if enabled
            if (settings.zones.validateBeforeReload) {
                try {
                    const { exec } = require('child_process');
                    await new Promise((resolve, reject) => {
                        exec('named-checkconf', (error, stdout, stderr) => {
                            if (error) {
                                reject(new Error(`Config validation failed: ${stderr || error.message}`));
                            } else {
                                resolve();
                            }
                        });
                    });
                    console.log(`✓ Config validated successfully`);
                } catch (validationError) {
                    // Restore backup if validation fails
                    console.error(`✗ Config validation failed, attempting to restore...`);
                    throw validationError;
                }
            }
            
            // Reload Bind if auto-reload is enabled
            if (settings.zones.autoReload) {
                await this.reloadBind();
                console.log(`✓ Auto-reload enabled - Bind reloaded`);
            }
            
            // Log activity
            await activityLogger.zoneDeleted(zoneName, {
                zoneFile: zoneFile
            });
            
            return { success: true };
        } catch (error) {
            throw new Error(`Failed to delete zone: ${error.message}`);
        }
    }

    /**
     * Reassign zone to another view
     */
    async reassignZone(zoneName, newViewName) {
        try {
            // Prevent reassigning system zones
            if (zoneName === '.' || zoneName === 'adblock') {
                throw new Error(`Cannot reassign system zone: ${zoneName}`);
            }

            // Load settings
            const settings = await settingsUtil.loadSettings();

            // current zone info
            const { zone } = await this.getZone(zoneName);
            if (!zone) throw new Error(`Zone ${zoneName} not found`);
            const zoneFile = zone.file;
            const currentView = zone.view;

            // If same view, do nothing
            if ((currentView || '') === (newViewName || '')) {
                return { success: true, message: 'Zone already assigned to that view' };
            }

            // Find target view ACL from settings
            const viewsList = settings.resolver?.views || [];
            const targetViewObj = viewsList.find(v => v.name === newViewName);
            const targetViewAcl = targetViewObj ? targetViewObj.acl : { allow: ['any'], deny: [] };

            // Build new named.conf.local content with zone moved
            const newContent = await bindConfig.buildMoveZoneToViewContent(zoneName, zoneFile, newViewName, targetViewAcl);

            // Write tmp file and validate via named-checkconf -z
            const tmpFile = `${this.namedConfLocal}.tmp.${Date.now()}`;
            await fs.writeFile(tmpFile, newContent, 'utf8');

            // Validate config using named-checkconf -z against tmp file
            try {
                await execPromise(`named-checkconf -z ${tmpFile}`);
            } catch (err) {
                throw new Error(`Config validation failed for proposed change: ${err.stderr || err.message}`);
            }

            // Now backup current conf and apply
            const backupFile = `${this.namedConfLocal}.backup.${Date.now()}`;
            await fs.copyFile(this.namedConfLocal, backupFile);
            await fs.move(tmpFile, this.namedConfLocal, { overwrite: true });
            // Do not update settings yet; perform reload first to ensure configuration is valid

            // Optionally reload Bind
            if (settings.zones.autoReload) {
                try {
                    await this.reloadBind();
                } catch (err) {
                    // rollback config
                    await fs.copyFile(backupFile, this.namedConfLocal);
                    throw new Error(`Reload failed after reassign; config restored: ${err.message}`);
                }
            }

            // Update settings: remove from old view, add to new (only after successful reload)
            try {
                const settingsAll = await settingsUtil.loadSettings();
                const viewsList2 = settingsAll.resolver?.views || [];
                for (let v of viewsList2) {
                    if (v.zones && v.zones.includes(zoneName)) {
                        v.zones = v.zones.filter(z => z !== zoneName);
                    }
                }
                let targetIndex = viewsList2.findIndex(v => v.name === newViewName);
                if (targetIndex !== -1) {
                    viewsList2[targetIndex].zones = viewsList2[targetIndex].zones || [];
                    if (!viewsList2[targetIndex].zones.includes(zoneName)) {
                        viewsList2[targetIndex].zones.push(zoneName);
                    }
                } else {
                    // If new view isn't present in settings, add it with default ACL and zone
                    const newViewObj = { name: newViewName, acl: { allow: ['any'], deny: [] }, zones: [zoneName] };
                    viewsList2.push(newViewObj);
                }
                await settingsUtil.updateSettings({ resolver: { views: viewsList2 } });
            } catch (err) {
                console.warn(`Warning: Could not update settings view membership: ${err.message}`);
            }

            await activityLogger.custom('zone', 'update', `Zone moved to ${newViewName || 'global'}`, zoneName, { view: newViewName });

            return { success: true };
        } catch (error) {
            throw new Error(`Failed to reassign zone: ${error.message}`);
        }
    }

    /**
     * Generate zone file content
     */
    generateZoneFile(zoneName, options = {}) {
        const ttl = options.ttl || 3600;
        
        // Ensure nameserver and email end with single dot
        let ns = options.nameserver || `ns1.${zoneName}.`;
        let email = options.email || `admin.${zoneName}.`;
        
        // Remove any trailing dots, then add exactly one
        ns = ns.replace(/\.+$/, '') + '.';
        email = email.replace(/\.+$/, '') + '.';
        
        const serial = this.generateSerial();
        
        // Check if this is a reverse zone (in-addr.arpa)
        const isReverseZone = zoneName.includes('in-addr.arpa');
        
        // Extract hostname from NS record for A record
        const nsHostname = ns.slice(0, -1).split('.')[0];
        
        // For reverse zones, extract the network prefix
        let networkPrefix = '';
        let domainForPTR = options.domain || 'example.com.';
        if (isReverseZone) {
            // Extract network from zone name (e.g., "215.142.103.in-addr.arpa." -> "103.142.215")
            const parts = zoneName.replace(/\.?in-addr\.arpa\.?$/, '').split('.');
            networkPrefix = parts.reverse().join('.');
            
            // Ensure domain ends with single dot
            domainForPTR = domainForPTR.replace(/\.+$/, '') + '.';
        }
        
        let zoneContent = `; Zone file for ${zoneName}
; Generated by NDash on ${new Date().toISOString()}

$TTL ${ttl}
@       IN      SOA     ${ns} ${email} (
                        ${serial}       ; Serial
                        7200            ; Refresh
                        3600            ; Retry
                        1209600         ; Expire
                        3600 )          ; Minimum TTL

; Name servers
@       IN      NS      ${ns}
`;

        if (isReverseZone) {
            // For reverse zones, add NS glue record with proper IP
            // Use provided IP or construct from network prefix (e.g., 103.142.214.1)
            let nsIP = options.nsIP || options.nameserverIP;
            if (!nsIP) {
                // Construct IP: networkPrefix should be like "103.142.214"
                // Add .1 as default first IP in subnet
                nsIP = `${networkPrefix}.1`;
            }
            zoneContent += `${ns}   IN      A       ${nsIP}\n`;
            
            // Auto-generate PTR records only if enabled in settings
            const autoGeneratePTR = options.settings?.zones?.autoGeneratePTR !== false;
            
            if (autoGeneratePTR) {
                // Auto-generate PTR records for IPs 1-254
                zoneContent += `\n; PTR records (auto-generated)\n`;
                zoneContent += `; Format: <last-octet> IN PTR <hostname>.<domain>\n`;
                for (let i = 1; i <= 254; i++) {
                    const hostname = `host${i}`;
                    zoneContent += `${i}       IN      PTR     ${hostname}.${domainForPTR}\n`;
                }
                console.log(`✓ Auto-generated 254 PTR records`);
            } else {
                zoneContent += `\n; PTR records\n`;
                zoneContent += `; Add your PTR records here\n`;
                zoneContent += `; Example: 1 IN PTR host1.${domainForPTR}\n`;
                console.log(`⚠ Auto-generate PTR disabled - Empty template created`);
            }
        } else {
            // For forward zones, add standard A records
            zoneContent += `\n; A records
@       IN      A       127.0.0.1
${nsHostname}   IN      A       127.0.0.1
`;
        }
        
        return zoneContent;
    }

    /**
     * Parse zone file to extract records
     */
    parseZoneFile(content) {
        const records = [];
        const lines = content.split('\n');
        let id = 1;
        
        for (const line of lines) {
            const trimmed = line.trim();
            
            // Skip comments and empty lines
            if (trimmed.startsWith(';') || !trimmed || trimmed.startsWith('$')) {
                continue;
            }
            
            // Skip SOA record (multi-line)
            if (trimmed.includes('SOA')) {
                continue;
            }
            
            // Parse record line
            const parts = trimmed.split(/\s+/);
            if (parts.length >= 4 && parts.includes('IN')) {
                const inIndex = parts.indexOf('IN');
                const name = parts[0];
                const type = parts[inIndex + 1];
                const value = parts.slice(inIndex + 2).join(' ');
                
                records.push({
                    id: id++,
                    name,
                    type,
                    value,
                    ttl: !isNaN(parts[1]) ? parseInt(parts[1]) : 3600
                });
            }
        }
        
        return records;
    }

    /**
     * Format record for zone file
     */
    formatRecord(record) {
        const name = record.name.padEnd(15);
        const ttl = (record.ttl || 3600).toString().padEnd(8);
        const type = record.type.padEnd(8);
        
        if (record.type === 'MX') {
            const priority = record.priority || 10;
            return `${name} ${ttl} IN ${type} ${priority} ${record.value}`;
        } else if (record.type === 'SRV') {
            const priority = record.priority || 10;
            const weight = record.weight || 0;
            const port = record.port || 0;
            return `${name} ${ttl} IN ${type} ${priority} ${weight} ${port} ${record.value}`;
        } else {
            return `${name} ${ttl} IN ${type} ${record.value}`;
        }
    }

    /**
     * Generate serial number (YYYYMMDDNN format)
     */
    generateSerial() {
        const now = new Date();
        const year = now.getFullYear();
        const month = String(now.getMonth() + 1).padStart(2, '0');
        const day = String(now.getDate()).padStart(2, '0');
        return `${year}${month}${day}01`;
    }

    /**
     * Increment serial number in zone file
     */
    incrementSerial(zoneContent) {
        const serialRegex = /(\d{10})\s*;\s*Serial/i;
        const match = zoneContent.match(serialRegex);
        
        if (match) {
            const currentSerial = match[1];
            const newSerial = (parseInt(currentSerial) + 1).toString();
            return zoneContent.replace(serialRegex, `${newSerial}       ; Serial`);
        }
        
        return zoneContent;
    }

    /**
     * Check zone syntax
     */
    async checkZone(zoneName, zoneFile) {
        try {
            const { stdout, stderr } = await execPromise(`named-checkzone ${zoneName} ${zoneFile}`);
            console.log(`✓ Zone syntax check passed for ${zoneName}`);
            return true;
        } catch (error) {
            console.error(`✗ Zone syntax check failed: ${error.message}`);
            throw new Error(`Zone syntax error: ${error.stderr || error.message}`);
        }
    }

    /**
     * Enable DNS resolver functionality
     */
    async enableResolver(options = {}) {
        try {
            console.log('Enabling DNS Resolver with options:', options);
            
            // Load current settings
            const settings = await settingsUtil.loadSettings();
            
            // Use provided resolver options or fall back to saved settings
            const resolverSettings = options.resolver || settings.resolver || {};
            
            // Generate resolver configuration
            const config = this.generateResolverConfig(resolverSettings);
            
            // Write configuration to named.conf.options
            const configPath = settings.bind.namedConfOptions;
            await fs.writeFile(configPath, config, 'utf8');
            
            // Handle adblock zone if enabled
            if (resolverSettings.adblock?.enabled) {
                // Setup single adblock zone
                await this.setupAdblockZone(resolverSettings.adblock);
            } else {
                await this.removeAdblockZone();
            }
            
            // Start encrypted DNS services if enabled
            const encryptedDnsService = require('./encryptedDnsService');
            if (settings.resolver.doh?.enabled || settings.resolver.dot?.enabled) {
                await encryptedDnsService.start();
            } else {
                await encryptedDnsService.stop();
            }
            
            // Reload Bind to apply changes
            await this.reloadBind();
            
            console.log('✓ DNS Resolver enabled successfully');
            return { success: true, message: 'DNS Resolver enabled' };
        } catch (error) {
            console.error('✗ Failed to enable DNS Resolver:', error.message);
            throw new Error(`Failed to enable DNS Resolver: ${error.message}`);
        }
    }

    /**
     * Disable DNS resolver functionality
     */
    async disableResolver() {
        try {
            console.log('Disabling DNS Resolver');
            
            // Load current settings
            const settings = await settingsUtil.loadSettings();
            
            // Generate basic configuration (no resolver)
            const config = this.generateBasicConfig();
            
            // Write configuration to named.conf.options
            const configPath = settings.bind.namedConfOptions;
            await fs.writeFile(configPath, config, 'utf8');
            
            // Stop encrypted DNS services
            const encryptedDnsService = require('./encryptedDnsService');
            await encryptedDnsService.stop();
            
            // Remove adblock zones
            await this.removeAdblockZone();
            
            // Clear named.conf.local to ensure clean state
            await fs.writeFile('/etc/bind/named.conf.local', '', 'utf8');
            
            // Reload Bind to apply changes
            await this.reloadBind();
            
            console.log('✓ DNS Resolver disabled successfully');
            return { success: true, message: 'DNS Resolver disabled' };
        } catch (error) {
            console.error('✗ Failed to disable DNS Resolver:', error.message);
            throw new Error(`Failed to disable DNS Resolver: ${error.message}`);
        }
    }

    /**
     * Generate resolver-enabled named.conf.options
     */
    generateResolverConfig(resolverSettings) {
        const {
            forwarders = ['8.8.8.8', '8.8.4.4', '1.1.1.1', '1.0.0.1'],
            queryLogging = false,
            cacheSize = '256M',
            dnssecValidation = true,
            adblock = { enabled: false }
        } = resolverSettings;

        let config = `options {
    directory "/var/cache/bind";

    // DNS Resolver Configuration
    recursion yes;
    allow-recursion { any; };
    allow-query { any; };
    allow-query-cache { any; };

    // Forwarders
    forwarders {
`;

        // Add forwarders
        forwarders.forEach(forwarder => {
            config += `        ${forwarder};\n`;
        });

        config += `    };
    forward only;

    // DNSSEC
    dnssec-validation ${dnssecValidation ? 'auto' : 'no'};

    // Query Logging
`;

        if (queryLogging) {
            config += `    querylog yes;
`;
        }

        config += `
    // Cache Size
    max-cache-size ${cacheSize};

    // Additional options
    listen-on port 53 { any; };
    listen-on-v6 port 53 { any; };

    // Disable version queries for security
    version none;

    // Rate limiting
    rate-limit {
        responses-per-second 5;
        window 5;
    };
`;

        // Add RPZ configuration for adblock if enabled
        if (adblock.enabled) {
            config += `
    // Response Policy Zone for Adblock
    response-policy {
        zone "adblock";
    };
`;
        }

        config += `};

`;

        return config;
    }

    /**
     * Generate basic named.conf.options (no resolver)
     */
    generateBasicConfig() {
        return `options {
    directory "/var/cache/bind";

    // Authoritative-only configuration (no resolver)
    recursion no;
    allow-recursion { none; };
    allow-query { any; };
    allow-query-cache { none; };

    // No forwarders - direct resolution only

    // DNSSEC disabled for authoritative mode
    dnssec-validation no;

    // No query logging
    // querylog no;

    // Minimal cache
    max-cache-size 64M;

    // Additional options
    listen-on port 53 { any; };
    listen-on-v6 port 53 { any; };

    // Disable version queries for security
    version none;
};

`;
    }

    /**
     * Reload Bind service
     */
    async reloadBind() {
        try {
            // Try systemctl reload first, fallback to rndc
            try {
                const { stdout, stderr } = await execPromise('systemctl reload named');
                console.log(`✓ Bind reloaded successfully`);
                
                // Log activity
                await activityLogger.bindReloaded();
                
                return { success: true, message: stdout };
            } catch (systemctlError) {
                console.log('systemctl reload failed, trying rndc...');
                const { stdout, stderr } = await execPromise('rndc reload');
                console.log(`✓ Bind reloaded successfully`);
                
                // Log activity
                await activityLogger.bindReloaded();
                
                return { success: true, message: stdout };
            }
        } catch (error) {
            console.error(`✗ Failed to reload Bind: ${error.message}`);
            throw new Error(`Bind reload failed: ${error.stderr || error.message}`);
        }
    }

    /**
     * Get Bind status
     */
    async getBindStatus() {
        try {
            const { stdout } = await execPromise('rndc status');
            return {
                success: true,
                status: 'running',
                details: stdout
            };
        } catch (error) {
            return {
                success: false,
                status: 'error',
                error: error.message
            };
        }
    }

    /**
     * Setup adblock RPZ zone
     */
    async setupAdblockZone(adblockSettings) {
        try {
            console.log('Setting up adblock zone with settings:', adblockSettings);
            
            const zoneName = 'adblock';
            const zoneFile = `/etc/bind/zones/${zoneName}.db`;
            
            // Generate RPZ zone content
            const zoneContent = await this.generateAdblockZoneContent(adblockSettings);
            
            // Write zone file
            await fs.writeFile(zoneFile, zoneContent, 'utf8');
            
            // Add zone to named.conf.local if not already present
            await this.addAdblockZoneToConfig(zoneName, zoneFile);
            
            console.log('✓ Adblock zone setup successfully');
        } catch (error) {
            console.error('✗ Failed to setup adblock zone:', error.message);
            throw error;
        }
    }

    /**
     * Remove adblock RPZ zone
     */
    async removeAdblockZone() {
        try {
            console.log('Removing adblock zone');
            
            const zoneName = 'adblock';
            const zoneFile = `/etc/bind/zones/${zoneName}.db`;
            
            // Remove zone file if exists
            try {
                await fs.unlink(zoneFile);
            } catch (error) {
                // Ignore if file doesn't exist
            }
            
            // Remove zone from named.conf.local
            await this.removeAdblockZoneFromConfig(zoneName);
            
            console.log('✓ Adblock zone removed successfully');
        } catch (error) {
            console.error('✗ Failed to remove adblock zone:', error.message);
            throw error;
        }
    }

    /**
     * Generate adblock RPZ zone content
     */
    async generateAdblockZoneContent(adblockSettings) {
        const { blocklistUrls = [], blocklistUrl, customDomains = [], wildcardDomains = [], redirectTo = '0.0.0.0', wildcardEnabled = false } = adblockSettings;
        
        // Support both old single URL and new multiple URLs format
        const urls = Array.isArray(blocklistUrls) && blocklistUrls.length > 0 ? blocklistUrls : 
                    (blocklistUrl ? [blocklistUrl] : []);
        
        let zoneContent = `\$TTL 86400
@ IN SOA localhost. root.localhost. (
    2024111401 ; serial
    3600       ; refresh
    1800       ; retry
    604800     ; expire
    86400      ; minimum
)
@ IN NS localhost.

; Adblock RPZ zone - redirects blocked domains to ${redirectTo}
`;

        // Add custom domains
        customDomains.forEach(domain => {
            if (domain.trim()) {
                zoneContent += `${domain} IN CNAME ${redirectTo}.\n`;
            }
        });

        // Add wildcard domains if enabled
        if (wildcardEnabled && wildcardDomains.length > 0) {
            wildcardDomains.forEach(pattern => {
                if (pattern.trim()) {
                    // RPZ wildcard format: *.domain.com
                    const wildcardPattern = pattern.startsWith('*.') ? pattern : `*.${pattern}`;
                    zoneContent += `${wildcardPattern} IN CNAME ${redirectTo}.\n`;
                }
            });
        }

        // Try to fetch blocklist from URL
        try {
            const https = require('https');
            const { URL } = require('url');
            
            const fetchBlocklist = (urlString) => {
                return new Promise((resolve, reject) => {
                    const parsedUrl = new URL(urlString);
                    const options = {
                        hostname: parsedUrl.hostname,
                        path: parsedUrl.pathname + parsedUrl.search,
                        method: 'GET',
                        headers: {
                            'User-Agent': 'NDash-Adblock/1.0'
                        }
                    };
                    
                    const req = https.request(options, (res) => {
                        let data = '';
                        res.on('data', (chunk) => {
                            data += chunk;
                        });
                        res.on('end', () => {
                            resolve(data);
                        });
                    });
                    
                    req.on('error', (error) => {
                        reject(error);
                    });
                    
                    req.setTimeout(10000, () => {
                        req.destroy();
                        reject(new Error('Request timeout'));
                    });
                    
                    req.end();
                });
            };
            
            // Fetch from all URLs and combine results
            const blockedDomains = new Set();
            
            for (const url of urls) {
                try {
                    console.log(`Fetching adblock list from: ${url}`);
                    const blocklistData = await fetchBlocklist(url);
                    
                    // Parse blocklist based on format
                    const lines = blocklistData.split('\n');
                    
                    // Check if it's BIND config format (contains "zone" declarations)
                    const isBindFormat = lines.some(line => line.includes('zone "') && line.includes('" {'));
                    
                    // Check if it's AdBlock Plus format (contains "||" and "^")
                    const isAdblockFormat = lines.some(line => line.includes('||') && line.includes('^'));
                    
                    if (isBindFormat) {
                        // Parse BIND config format
                        console.log(`Detected BIND config format for ${url}`);
                        lines.forEach(line => {
                            const trimmed = line.trim();
                            if (trimmed && trimmed.startsWith('zone "') && trimmed.includes('" {')) {
                                // Extract domain from: zone "domain.com" { ...
                                const match = trimmed.match(/zone "([^"]+)"/);
                                if (match && match[1]) {
                                    const domain = match[1].toLowerCase();
                                    if (domain && domain !== 'localhost' && !domain.includes('local')) {
                                        blockedDomains.add(domain);
                                    }
                                }
                            }
                        });
                    } else if (isAdblockFormat) {
                        // Parse AdBlock Plus format
                        console.log(`Detected AdBlock Plus format for ${url}`);
                        lines.forEach(line => {
                            const trimmed = line.trim();
                            if (trimmed && !trimmed.startsWith('!') && !trimmed.startsWith('[')) {
                                // Handle ||domain^ format
                                if (trimmed.startsWith('||') && trimmed.endsWith('^')) {
                                    const domain = trimmed.slice(2, -1).toLowerCase(); // Remove || and ^
                                    if (domain && domain !== 'localhost' && !domain.includes('local')) {
                                        blockedDomains.add(domain);
                                    }
                                }
                                // Handle |domain^ format
                                else if (trimmed.startsWith('|') && trimmed.endsWith('^') && !trimmed.startsWith('||')) {
                                    const domain = trimmed.slice(1, -1).toLowerCase(); // Remove | and ^
                                    if (domain && domain !== 'localhost' && !domain.includes('local')) {
                                        blockedDomains.add(domain);
                                    }
                                }
                            }
                        });
                    } else {
                        // Parse hosts file format
                        console.log(`Detected hosts file format for ${url}`);
                        lines.forEach(line => {
                            const trimmed = line.trim();
                            if (trimmed && !trimmed.startsWith('#')) {
                                const parts = trimmed.split(/\s+/);
                                if (parts.length >= 2 && (parts[0] === '0.0.0.0' || parts[0] === '127.0.0.1')) {
                                    const domain = parts[1].toLowerCase();
                                    if (domain && domain !== 'localhost' && !domain.includes('local')) {
                                        blockedDomains.add(domain);
                                    }
                                }
                            }
                        });
                    }
                    
                } catch (error) {
                    console.warn(`Failed to fetch adblock list from ${url}:`, error.message);
                    // Continue with other URLs
                }
            }
            
            // Add fetched domains to zone (limit to prevent huge files)
            const domainsArray = Array.from(blockedDomains).slice(0, 50000); // Limit to 50k domains
            domainsArray.forEach(domain => {
                zoneContent += `${domain} IN CNAME ${redirectTo}.\n`;
            });
            
            console.log(`Added ${domainsArray.length} domains from ${urls.length} blocklist sources`);
        } catch (error) {
            console.warn('Failed to fetch adblock lists:', error.message);
        }

        return zoneContent;
    }

    /**
     * Add adblock zone to named.conf.local
     */
    async addAdblockZoneToConfig(zoneName, zoneFile) {
        const bindConfig = require('../utils/bindConfig');
        const configPath = '/etc/bind/named.conf.local';
        let configContent = '';
        
        try {
            configContent = await fs.readFile(configPath, 'utf8');
        } catch (error) {
            // File doesn't exist, create it
            configContent = '';
        }
        
        // Check if zone already exists in any view
        if (configContent.includes(`zone "${zoneName}"`)) {
            return; // Already exists
        }
        
        const zoneBlock = `    zone "${zoneName}" {
        type master;
        file "${zoneFile}";
        allow-query { any; };
    };`;
        
        // Add zone to each view
        // Find each view pattern and add zone before its closing };
        let newContent = configContent;
        
        // Use a more robust approach: find view blocks by matching opening and closing braces
        let pos = 0;
        while (true) {
            // Find the next view
            const viewStart = newContent.indexOf('view ', pos);
            if (viewStart === -1) break;
            
            // Find the opening brace of this view
            const openBracePos = newContent.indexOf('{', viewStart);
            if (openBracePos === -1) break;
            
            // Count braces to find the closing brace of this view
            let braceCount = 0;
            let closePos = -1;
            for (let i = openBracePos; i < newContent.length; i++) {
                if (newContent[i] === '{') braceCount++;
                else if (newContent[i] === '}') {
                    braceCount--;
                    if (braceCount === 0) {
                        closePos = i;
                        break;
                    }
                }
            }
            
            if (closePos !== -1) {
                // Found the closing brace of this view
                // Check if zone already exists in this view
                const viewContent = newContent.substring(viewStart, closePos + 1);
                if (!viewContent.includes(`zone "${zoneName}"`)) {
                    // Insert zone before the closing };
                    // Find the newline before the closing }
                    let insertPos = closePos;
                    while (insertPos > 0 && newContent[insertPos - 1] !== '\n') {
                        insertPos--;
                    }
                    newContent = newContent.substring(0, insertPos) + zoneBlock + '\n' + newContent.substring(insertPos);
                }
                
                // Move position forward for next iteration
                pos = viewStart + 20; // Move past "view" string
            } else {
                break;
            }
        }
        
        // Write with validation
        await bindConfig.writeConfigWithValidation(configPath, newContent);
    }

    /**
     * Remove adblock zone from named.conf.local
     */
    async removeAdblockZoneFromConfig(zoneName) {
        const bindConfig = require('../utils/bindConfig');
        const configPath = '/etc/bind/named.conf.local';
        
        try {
            let configContent = await fs.readFile(configPath, 'utf8');
            
            // Split into lines
            let lines = configContent.split('\n');
            let result = [];
            let i = 0;
            
            while (i < lines.length) {
                const line = lines[i];
                
                // Check if this line starts a zone block for our target zone
                if (line.trim().startsWith(`zone "${zoneName}"`)) {
                    // Skip this zone block entirely
                    // Find the closing }; and skip all lines until then
                    let braceCount = 0;
                    let foundBrace = false;
                    
                    while (i < lines.length) {
                        for (const char of lines[i]) {
                            if (char === '{') {
                                braceCount++;
                                foundBrace = true;
                            } else if (char === '}') {
                                braceCount--;
                            }
                        }
                        
                        // Check if this line ends the zone block
                        if (foundBrace && braceCount === 0 && lines[i].trim().endsWith('};')) {
                            // Skip this line and move to next
                            i++;
                            break;
                        }
                        
                        i++;
                    }
                } else {
                    // Keep this line
                    result.push(line);
                    i++;
                }
            }
            
            let updatedContent = result.join('\n');
            
            // Clean up extra blank lines
            updatedContent = updatedContent.replace(/\n\n\n+/g, '\n\n');
            updatedContent = updatedContent.trim();
            
            // Write with validation
            await bindConfig.writeConfigWithValidation(configPath, updatedContent);
        } catch (error) {
            // Ignore if file doesn't exist or zone not found
            console.warn('Warning: Could not remove adblock zone from config:', error.message);
        }
    }

    /**
     * List all ACLs from BIND config files
     */
    async listACLs() {
        try {
            const aclsMap = new Map();
            const configFiles = [
                '/etc/bind/named.conf.options',
                '/etc/bind/named.conf.local'
            ];

            for (const filePath of configFiles) {
                try {
                    const content = await fs.readFile(filePath, 'utf8');
                    // Parse ACL definitions: acl "name" { ... };
                    const aclRegex = /acl\s+"([^"]+)"\s*\{([\s\S]*?)\};/g;
                    let match;
                    
                    while ((match = aclRegex.exec(content)) !== null) {
                        const aclName = match[1];
                        const aclBody = match[2].trim();
                        
                        // Parse ACL entries (IP addresses, ranges, special keywords)
                        const entries = [];
                        const entryRegex = /(!?)([^\s;]+)/g;
                        let entryMatch;
                        
                        while ((entryMatch = entryRegex.exec(aclBody)) !== null) {
                            const negated = entryMatch[1] === '!';
                            const address = entryMatch[2];
                            entries.push({
                                address,
                                negated,
                                description: this.getAddressDescription(address)
                            });
                        }
                        
                        aclsMap.set(aclName, {
                            name: aclName,
                            entries,
                            file: filePath,
                            raw: aclBody
                        });
                    }
                } catch (err) {
                    console.warn(`Could not read ACLs from ${filePath}:`, err.message);
                }
            }

            return Array.from(aclsMap.values());
        } catch (error) {
            console.error('Error listing ACLs:', error);
            return [];
        }
    }

    /**
     * Get description for an address entry
     */
    getAddressDescription(address) {
        const descriptions = {
            'any': 'All hosts',
            'none': 'No hosts',
            'localhost': 'Local server addresses',
            'localnets': 'Local network addresses'
        };
        
        if (descriptions[address]) {
            return descriptions[address];
        }
        
        // Check if it's an IP address or CIDR range
        if (address.includes('/')) {
            return `Network range`;
        } else if (address.match(/^\d+\.\d+\.\d+\.\d+$/)) {
            return 'IP address';
        } else if (address.match(/^[0-9a-fA-F:]+$/)) {
            return 'IPv6 address';
        }
        
        return 'Custom';
    }

    /**
     * Create a new ACL
     */
    async createACL(name, entries, description = '') {
        try {
            // Validate name
            if (!name || typeof name !== 'string') {
                throw new Error('ACL name is required');
            }
            
            if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
                throw new Error('ACL name can only contain letters, numbers, hyphens, and underscores');
            }

            // Check if ACL already exists
            const existingACLs = await this.listACLs();
            if (existingACLs.some(acl => acl.name === name)) {
                throw new Error(`ACL "${name}" already exists`);
            }

            // Build ACL entry lines
            let aclBody = entries.map(entry => {
                const prefix = entry.negated ? '!' : '';
                return `        ${prefix}${entry.address};`;
            }).join('\n');

            // Format ACL definition
            const aclDef = `acl "${name}" {\n${aclBody}\n};\n\n`;

            // Add to named.conf.local
            let content = await fs.readFile(this.namedConfLocal, 'utf8');
            
            // Add ACL at the beginning (after any existing acls or comments)
            const insertPos = content.search(/^(\/\/|#|acl)/m);
            if (insertPos !== -1) {
                content = content.slice(0, insertPos) + aclDef + content.slice(insertPos);
            } else {
                content = aclDef + content;
            }

            await bindConfig.writeConfigWithValidation(this.namedConfLocal, content);
            
            await activityLogger.custom('acl', 'create', `ACL "${name}" created with ${entries.length} entries`, name);

            return { success: true, message: `ACL "${name}" created successfully` };
        } catch (error) {
            console.error('Error creating ACL:', error);
            throw error;
        }
    }

    /**
     * Delete an ACL
     */
    async deleteACL(name) {
        try {
            const configFiles = [
                '/etc/bind/named.conf.options',
                '/etc/bind/named.conf.local'
            ];

            for (const filePath of configFiles) {
                try {
                    let content = await fs.readFile(filePath, 'utf8');
                    const aclRegex = new RegExp(`acl\\s+"${name}"\\s*\\{[\\s\\S]*?\\};\\s*`, 'g');
                    
                    if (aclRegex.test(content)) {
                        content = content.replace(aclRegex, '');
                        await bindConfig.writeConfigWithValidation(filePath, content);
                        
                        await activityLogger.custom('acl', 'delete', `ACL "${name}" deleted`, name);
                        return { success: true, message: `ACL "${name}" deleted successfully` };
                    }
                } catch (err) {
                    console.warn(`Could not process ${filePath}:`, err.message);
                }
            }

            throw new Error(`ACL "${name}" not found`);
        } catch (error) {
            console.error('Error deleting ACL:', error);
            throw error;
        }
    }

    /**
     * Convert a master zone to slave zone
     * zone name, master server IP, and optional ACL for allow-transfer
     */
    async convertToSlaveZone(zoneName, masterIp, allowTransferAcl = 'none') {
        try {
            if (!zoneName || !masterIp) {
                throw new Error('Zone name and master IP are required');
            }

            // Validate IP format
            if (!this.isValidIp(masterIp)) {
                throw new Error('Invalid master server IP address');
            }

            let content = await fs.readFile(this.namedConfLocal, 'utf8');
            
            // Remove existing zone definition for this zone (from any location)
            const zoneRemovalRegex = new RegExp(`zone\\s+"${zoneName}"\\s*\\{[\\s\\S]*?\\};\\s*`, 'g');
            content = content.replace(zoneRemovalRegex, '');

            // Create slave zone definition with proper indentation for inside view
            const slaveZoneDef = `
    zone "${zoneName}" {
        type slave;
        file "/etc/bind/zones/slave/${zoneName}.db";
        masters { ${masterIp}; };
        allow-transfer { ${allowTransferAcl}; };
    };`;

            // Find global view and add zone before closing brace
            // If no global view, create standalone zone with proper formatting
            let added = false;
            
            // Try to find 'global' view
            const globalViewRegex = /view\s+"global"\s*\{([\s\S]*?)\n\};/;
            const globalMatch = globalViewRegex.exec(content);
            
            if (globalMatch) {
                // Add zone inside global view, before closing brace
                const insertPoint = content.lastIndexOf('};', globalMatch.index + globalMatch[0].length);
                if (insertPoint !== -1) {
                    content = content.slice(0, insertPoint) + slaveZoneDef + '\n' + content.slice(insertPoint);
                    added = true;
                }
            }

            // If not added yet, try to find any view and add there
            if (!added) {
                const firstViewMatch = /view\s+"[^"]+"\s*\{/;
                const viewPos = content.search(firstViewMatch);
                if (viewPos !== -1) {
                    // Find this view's closing brace
                    let braceCount = 0;
                    let inBrace = false;
                    for (let i = viewPos; i < content.length; i++) {
                        if (content[i] === '{') {
                            braceCount++;
                            inBrace = true;
                        } else if (content[i] === '}') {
                            braceCount--;
                            if (inBrace && braceCount === 0) {
                                content = content.slice(0, i) + slaveZoneDef + '\n' + content.slice(i);
                                added = true;
                                break;
                            }
                        }
                    }
                }
            }

            // If still not added, add at top level before views
            if (!added) {
                const viewPos = content.search(/^view/m);
                if (viewPos !== -1) {
                    content = content.slice(0, viewPos) + slaveZoneDef + '\n\n' + content.slice(viewPos);
                } else {
                    content = slaveZoneDef + '\n\n' + content;
                }
            }

            await bindConfig.writeConfigWithValidation(this.namedConfLocal, content);
            
            // Ensure slave directory exists and create placeholder zone file
            await fs.ensureDir('/etc/bind/zones/slave');
            
            const slaveZoneFile = `/etc/bind/zones/slave/${zoneName}.db`;
            if (!await fs.pathExists(slaveZoneFile)) {
                // Create placeholder SOA record for slave zone
                const placeholderContent = `; Slave zone file for ${zoneName}
; This file will be populated when zone transfers from master server
$ORIGIN ${zoneName}.
$TTL 3600
@   IN  SOA ns1.${zoneName}. hostmaster.${zoneName}. (
                1           ; serial
                3600        ; refresh
                1800        ; retry
                604800      ; expire
                86400 )     ; minimum
    IN  NS  ns1.${zoneName}.
`;
                await fs.writeFile(slaveZoneFile, placeholderContent);
                console.log(`✓ Created placeholder slave zone file: ${slaveZoneFile}`);
            }

            await activityLogger.custom('zone', 'convert', `Zone "${zoneName}" converted to slave (master: ${masterIp})`, zoneName);

            return { 
                success: true, 
                message: `Zone "${zoneName}" successfully converted to slave zone`
            };
        } catch (error) {
            console.error('Error converting to slave zone:', error);
            throw error;
        }
    }

    /**
     * Convert a slave zone to master zone
     */
    async convertToMasterZone(zoneName, file) {
        try {
            if (!zoneName || !file) {
                throw new Error('Zone name and zone file are required');
            }

            let content = await fs.readFile(this.namedConfLocal, 'utf8');
            
            // Remove existing zone definition for this zone
            const zoneRemovalRegex = new RegExp(`zone\\s+"${zoneName}"\\s*\\{[\\s\\S]*?\\};\\s*`, 'g');
            content = content.replace(zoneRemovalRegex, '');

            // Resolve file path
            const zoneFile = file.startsWith('/') ? file : '/etc/bind/zones/' + file;

            // Create master zone definition with proper indentation
            const masterZoneDef = `
    zone "${zoneName}" {
        type master;
        file "${zoneFile}";
        allow-transfer { none; };
        allow-update { none; };
    };`;

            // Try to find 'global' view and add zone
            let added = false;
            const globalViewRegex = /view\s+"global"\s*\{([\s\S]*?)\n\};/;
            const globalMatch = globalViewRegex.exec(content);
            
            if (globalMatch) {
                const insertPoint = content.lastIndexOf('};', globalMatch.index + globalMatch[0].length);
                if (insertPoint !== -1) {
                    content = content.slice(0, insertPoint) + masterZoneDef + '\n' + content.slice(insertPoint);
                    added = true;
                }
            }

            // If not added yet, try to find any view
            if (!added) {
                const firstViewMatch = /view\s+"[^"]+"\s*\{/;
                const viewPos = content.search(firstViewMatch);
                if (viewPos !== -1) {
                    let braceCount = 0;
                    let inBrace = false;
                    for (let i = viewPos; i < content.length; i++) {
                        if (content[i] === '{') {
                            braceCount++;
                            inBrace = true;
                        } else if (content[i] === '}') {
                            braceCount--;
                            if (inBrace && braceCount === 0) {
                                content = content.slice(0, i) + masterZoneDef + '\n' + content.slice(i);
                                added = true;
                                break;
                            }
                        }
                    }
                }
            }

            if (!added) {
                const viewPos = content.search(/^view/m);
                if (viewPos !== -1) {
                    content = content.slice(0, viewPos) + masterZoneDef + '\n\n' + content.slice(viewPos);
                } else {
                    content = masterZoneDef + '\n\n' + content;
                }
            }

            await bindConfig.writeConfigWithValidation(this.namedConfLocal, content);

            await activityLogger.custom('zone', 'convert', `Zone "${zoneName}" converted to master`, zoneName);

            return { 
                success: true, 
                message: `Zone "${zoneName}" successfully converted to master zone`
            };
        } catch (error) {
            console.error('Error converting to master zone:', error);
            throw error;
        }
    }

    /**
     * Update slave zone master server
     */
    async updateSlaveZoneMaster(zoneName, newMasterIp) {
        try {
            if (!zoneName || !newMasterIp) {
                throw new Error('Zone name and master IP are required');
            }

            if (!this.isValidIp(newMasterIp)) {
                throw new Error('Invalid master server IP address');
            }

            let content = await fs.readFile(this.namedConfLocal, 'utf8');
            
            // Find and update the slave zone's masters statement
            const zoneRegex = new RegExp(
                `(zone\\s+"${zoneName}"\\s*\\{[\\s\\S]*?masters\\s*\\{\\s*)([^}]+)(\\s*\\};[\\s\\S]*?\\};)`,
                'g'
            );

            if (!zoneRegex.test(content)) {
                throw new Error(`Slave zone "${zoneName}" not found`);
            }

            content = content.replace(zoneRegex, `$1${newMasterIp};$3`);

            await bindConfig.writeConfigWithValidation(this.namedConfLocal, content);

            await activityLogger.custom('zone', 'update', `Slave zone "${zoneName}" master updated to ${newMasterIp}`, zoneName);

            return { 
                success: true, 
                message: `Master server for "${zoneName}" updated to ${newMasterIp}`
            };
        } catch (error) {
            console.error('Error updating slave zone master:', error);
            throw error;
        }
    }

    /**
     * Get slave zones
     */
    async getSlaveZones() {
        try {
            const content = await fs.readFile(this.namedConfLocal, 'utf8');
            const slaveZones = [];

            // Parse slave zones more carefully - match zone blocks properly
            // First find all zone blocks, then check if they have "type slave"
            const zoneBlockRegex = /zone\s+"([^"]+)"\s*\{([\s\S]*?)\n\s*\};/g;
            let match;

            while ((match = zoneBlockRegex.exec(content)) !== null) {
                const zoneName = match[1];
                const zoneBody = match[2];

                // Check if this zone has "type slave"
                if (!/type\s+slave/.test(zoneBody)) {
                    continue;
                }

                // Extract masters
                const mastersRegex = /masters\s*\{\s*([^}]+)\s*\};/;
                const mastersMatch = mastersRegex.exec(zoneBody);

                if (mastersMatch) {
                    const masterIps = mastersMatch[1]
                        .split(';')
                        .map(ip => ip.trim())
                        .filter(ip => ip && !ip.startsWith('//'));

                    slaveZones.push({
                        name: zoneName,
                        type: 'slave',
                        masters: masterIps
                    });
                }
            }

            return slaveZones;
        } catch (error) {
            console.error('Error getting slave zones:', error);
            return [];
        }
    }

    /**
     * Get master zones
     */
    async getMasterZones() {
        try {
            const content = await fs.readFile(this.namedConfLocal, 'utf8');
            const masterZones = [];

            // Parse master zones - match zone blocks properly
            const zoneBlockRegex = /zone\s+"([^"]+)"\s*\{([\s\S]*?)\n\s*\};/g;
            let match;

            while ((match = zoneBlockRegex.exec(content)) !== null) {
                const zoneName = match[1];
                const zoneBody = match[2];

                // Check if this zone has "type master"
                if (!/type\s+master/.test(zoneBody)) {
                    continue;
                }

                // Extract file
                const fileRegex = /file\s+"([^"]+)";/;
                const fileMatch = fileRegex.exec(zoneBody);

                if (fileMatch) {
                    masterZones.push({
                        name: zoneName,
                        type: 'master',
                        file: fileMatch[1]
                    });
                }
            }

            return masterZones;
        } catch (error) {
            console.error('Error getting master zones:', error);
            return [];
        }
    }

    /**
     * Set allow-transfer ACL for a zone
     */
    async setZoneAllowTransfer(zoneName, aclName) {
        try {
            if (!zoneName || !aclName) {
                throw new Error('Zone name and ACL name are required');
            }

            let content = await fs.readFile(this.namedConfLocal, 'utf8');

            // Find zone and update or add allow-transfer
            const zoneRegex = new RegExp(
                `(zone\\s+"${zoneName}"\\s*\\{[\\s\\S]*?)(allow-transfer\\s*\\{[^}]+\\};|)(\\s*\\};)`,
                'g'
            );

            if (!zoneRegex.test(content)) {
                throw new Error(`Zone "${zoneName}" not found`);
            }

            const allowTransferLine = `allow-transfer { ${aclName}; };`;

            content = content.replace(zoneRegex, (match, before, existing, after) => {
                // Remove existing allow-transfer if any
                const beforeClean = before.replace(/allow-transfer\s*\{[^}]+\};\s*/g, '');
                return `${beforeClean}    ${allowTransferLine}${after}`;
            });

            await bindConfig.writeConfigWithValidation(this.namedConfLocal, content);

            await activityLogger.custom('zone', 'update', `Zone "${zoneName}" allow-transfer set to ACL "${aclName}"`, zoneName);

            return { 
                success: true, 
                message: `Zone "${zoneName}" allow-transfer updated`
            };
        } catch (error) {
            console.error('Error setting zone allow-transfer:', error);
            throw error;
        }
    }

    /**
     * Validate IP address
     */
    isValidIp(ip) {
        // IPv4
        const ipv4Regex = /^(\d{1,3}\.){3}\d{1,3}$/;
        if (ipv4Regex.test(ip)) {
            const parts = ip.split('.');
            return parts.every(part => parseInt(part) <= 255);
        }

        // IPv6 (simple check)
        if (ip.includes(':')) {
            return true; // Basic IPv6 check
        }

        return false;
    }
}

module.exports = new BindService();
