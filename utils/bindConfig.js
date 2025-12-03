const fs = require('fs-extra');

/**
 * Bind Configuration Manager
 * Manages /etc/bind/named.conf.local
 */

const NAMED_CONF_LOCAL = '/etc/bind/named.conf.local';

/**
 * Add zone to named.conf.local
 */
async function addZoneToConfig(zoneName, zoneFile, zoneType = 'master') {
    try {
        let configContent = await fs.readFile(NAMED_CONF_LOCAL, 'utf8');
        
        // Check if zone already exists
        const zonePattern = new RegExp(`zone\\s+"${zoneName}"`, 'i');
        if (zonePattern.test(configContent)) {
            console.log(`Zone ${zoneName} already in config`);
            return;
        }
        
        // Prepare zone block
        const zoneBlock = `
zone "${zoneName}" {
    type ${zoneType};
    file "${zoneFile}";
    allow-update { none; };
};
`;
        
        // Append to config as top-level zone
        await fs.appendFile(NAMED_CONF_LOCAL, zoneBlock);
        
    } catch (error) {
        throw new Error(`Failed to add zone to config: ${error.message}`);
    }
}

/**
 * Add a BIND view to named.conf.local
 */
// Normalize ACL allow/deny lists: split items that contain newline characters or commas
function normalizeList(arr) {
    const items = [];
    for (let v of arr || []) {
        if (!v) continue;
        // Replace escaped newline sequences with actual newline, then split
        v = v.replace(/\\n/g, '\n');
        const parts = v.split(/[\n,;]/).map(s => s.trim()).filter(s => s);
        parts.forEach(p => items.push(p));
    }
    return items;
}

async function addViewToConfig(viewName, acl = { allow: ['any'], deny: [] }) {
    try {
        let content = await fs.readFile(NAMED_CONF_LOCAL, 'utf8');
        const viewPattern = new RegExp(`view\\s+"${viewName}"`, 'i');
        if (viewPattern.test(content)) {
            // view already exists
            return;
        }

        const aclLines = [];
        // Normalize ACL allow/deny lists: split items that contain newline characters or commas
        const allowList = normalizeList(acl.allow || ['any']);
        const denyList = normalizeList(acl.deny || []);
        if (allowList.length > 0) {
            const allowNetworks = allowList.join('; ');
            aclLines.push(`    match-clients { ${allowNetworks}; };`);
        }
        if (denyList && denyList.length > 0) {
            const denyNetworks = denyList.join('; ');
            aclLines.push(`    // deny: ${denyNetworks};`);
        }

        const viewBlock = `\nview "${viewName}" {\n${aclLines.join('\n')}\n};\n`;
        await fs.appendFile(NAMED_CONF_LOCAL, viewBlock);

        // After creating a view, ensure any zone declarations in root-hints are moved into a 'global' view to
        // prevent named-checkconf errors when 'view' statements are in use.
        try {
            await moveZonesFromFileToGlobal('/etc/bind/named.conf.root-hints', 'global', { allow: ['any'] });
        } catch (err) {
            console.warn('Could not move zones from root-hints to global view:', err.message);
        }
    } catch (error) {
        throw new Error(`Failed to add view to config: ${error.message}`);
    }
}

/**
 * Add a zone inside a specific view in named.conf.local. If view does not
 * exist, it will be created first with the provided ACL.
 */
async function addZoneToViewConfig(zoneName, zoneFile, viewName, viewAcl = { allow: ['any'] }, zoneType = 'master') {
    try {
        let content = await fs.readFile(NAMED_CONF_LOCAL, 'utf8');

        // If view doesn't exist, create it
            const updateLine = zoneType.toLowerCase() === 'hint' ? '' : '\n    allow-update { none; };';
            const zoneBlock = `zone "${zoneName}" {\n    type ${zoneType};\n    file "${zoneFile}";${updateLine}\n};\n`;

            // Ensure view exists using provided ACL
            if (!content.includes(`view \"${viewName}\"`)) {
                await addViewToConfig(viewName, viewAcl);
                content = await fs.readFile(NAMED_CONF_LOCAL, 'utf8');
            }

            // Find the view block using brace matching (safer than regex for nested blocks)
            const viewSearch = `view "${viewName}"`;
            const idx = content.indexOf(viewSearch);
            if (idx === -1) {
                throw new Error(`View ${viewName} was not found even after creating it`);
            }
            // find opening brace position after the view name
            const afterMatch = content.slice(idx);
            const openBraceIndex = afterMatch.indexOf('{');
            if (openBraceIndex === -1) throw new Error(`Malformed view block for ${viewName}`);
            let startBracePos = idx + openBraceIndex; // position of '{'

            // Now scan forward to find matching closing '}' using a brace counter
            let braceCount = 0;
            let endBracePos = -1;
            let closingBraceIdx = -1;
            for (let i = startBracePos; i < content.length; i++) {
                const ch = content[i];
                if (ch === '{') braceCount++;
                else if (ch === '}') {
                    braceCount--;
                    if (braceCount === 0) {
                        closingBraceIdx = i;
                        // include following semicolon and whitespace
                        let j = i + 1;
                        while (j < content.length && /[\s;\n\r]/.test(content[j])) j++;
                        endBracePos = j;
                        break;
                    }
                }
            }
            if (endBracePos === -1) throw new Error(`Could not find end of view ${viewName} block`);

            const viewHeader = content.slice(idx, startBracePos + 1); // include open brace
            const viewBody = content.slice(startBracePos + 1, closingBraceIdx); // content inside braces
            const viewFooter = content.slice(closingBraceIdx, endBracePos); // include closing brace and semicolon
            const viewEnd = endBracePos;

            // If zone already exists inside view, skip
            if (new RegExp(`zone\\s+\"${zoneName}\"`, 'i').test(viewBody)) {
                return;
            }

            // Rebuild the view block with the new zone appended before the footer
            const newViewBlock = `${viewHeader}${viewBody}\n    ${zoneBlock}${viewFooter}`;
            const newViewContent = content.slice(0, idx) + newViewBlock + content.slice(viewEnd);
        const tmpFile = `${NAMED_CONF_LOCAL}.tmp.${Date.now()}`;
        await fs.writeFile(tmpFile, newViewContent, 'utf8');
        await fs.move(tmpFile, NAMED_CONF_LOCAL, { overwrite: true });
    } catch (error) {
        throw new Error(`Failed to add zone to view ${viewName}: ${error.message}`);
    }
}

/**
 * Remove a view block from named.conf.local
 */
async function removeViewFromConfig(viewName) {
    try {
        const content = await fs.readFile(NAMED_CONF_LOCAL, 'utf8');
        const viewPattern = new RegExp(`\\bview\\s+"${viewName}"`, 'i');
        if (!viewPattern.test(content)) {
            console.log(`View ${viewName} not found in config, nothing to remove`);
            return;
        }

        // Find the full block and remove it
        const startIndex = content.search(viewPattern);
        const afterMatch = content.slice(startIndex);
        const openBraceIndex = afterMatch.indexOf('{');
        let idx = startIndex + openBraceIndex;
        let braceCount = 0;
        let endIndex = -1;
        for (let i = idx; i < content.length; i++) {
            if (content[i] === '{') braceCount++;
            else if (content[i] === '}') {
                braceCount--;
                if (braceCount === 0) {
                    let j = i + 1;
                    while (j < content.length && /[\s;\n\r]/.test(content[j])) j++;
                    endIndex = j;
                    break;
                }
            }
        }
        if (endIndex === -1) return; // malformed
        const newContent = content.slice(0, startIndex) + content.slice(endIndex);
        const tmpFile = `${NAMED_CONF_LOCAL}.tmp.${Date.now()}`;
        await fs.writeFile(tmpFile, newContent, 'utf8');
        await fs.move(tmpFile, NAMED_CONF_LOCAL, { overwrite: true });
    } catch (error) {
        throw new Error(`Failed to remove view ${viewName}: ${error.message}`);
    }
}

/**
 * List view definitions from named.conf.local along with nested zones
 */
async function listConfiguredViews() {
    try {
        const content = await fs.readFile(NAMED_CONF_LOCAL, 'utf8');
        const views = [];
        let pos = 0;
        while (true) {
            const viewMatch = content.slice(pos).match(/view\s+"([^"]+)"/i);
            if (!viewMatch) break;
            const name = viewMatch[1];
            const viewStartIndex = pos + viewMatch.index;
            // find the opening brace
            const afterMatch = content.slice(viewStartIndex);
            const openBraceIndex = afterMatch.indexOf('{');
            if (openBraceIndex === -1) break; // malformed
            const start = viewStartIndex + openBraceIndex;
            // find matching closing brace
            let braceCount = 0;
            let end = -1;
            for (let i = start; i < content.length; i++) {
                if (content[i] === '{') braceCount++;
                else if (content[i] === '}') {
                    braceCount--;
                    if (braceCount === 0) {
                        // include trailing semicolon and whitespace
                        let j = i + 1;
                        while (j < content.length && /[\s;\n\r]/.test(content[j])) j++;
                        end = j;
                        break;
                    }
                }
            }
            if (end === -1) break; // malformed, bail
            const body = content.slice(start + 1, end - 1);
            const aclMatch = body.match(/match-clients\s*\{([^}]*)\}/i);
            const acl = { allow: [], deny: [] };
            if (aclMatch && aclMatch[1]) {
                const groups = aclMatch[1].split(/[;\n,]/).map(g => g.trim()).filter(g => g);
                acl.allow = groups;
            }
            const zones = [];
            const zoneRegex = /zone\s+"([^\"]+)"\s*\{[\s\S]*?file\s+"([^\"]+)";[\s\S]*?\}/g;
            let zm;
            while ((zm = zoneRegex.exec(body)) !== null) {
                zones.push({ name: zm[1], file: zm[2] });
            }
            views.push({ name, acl, zones });
            pos = end;
        }
        return views;
    } catch (error) {
        throw new Error(`Failed to list views: ${error.message}`);
    }
}

/**
 * Move all zone declarations from a given file into a target view (default 'global')
 * This function will:
 * - parse and find zone blocks inside the file
 * - add each zone into the named.conf.local 'global' view using addZoneToViewConfig
 * - remove the original zone block(s) from the source file (backing it up first)
 */
async function moveZonesFromFileToGlobal(filePath, viewName = 'global', viewAcl = { allow: ['any'], deny: [] }) {
    try {
        // Read source file
        let content = await fs.readFile(filePath, 'utf8');
        const zoneRegex = /zone\s+"([^"]+)"\s*\{[\s\S]*?file\s+"([^"]+)";[\s\S]*?\}/g;
        let match;
        const zonesToMove = [];
        while ((match = zoneRegex.exec(content)) !== null) {
            zonesToMove.push({ name: match[1], file: match[2], block: match[0] });
        }

        if (!zonesToMove.length) return { moved: 0 };

        // Ensure view exists
        await addViewToConfig(viewName, viewAcl);

        // Backup source file
        const backup = `${filePath}.backup.${Date.now()}`;
        await fs.copyFile(filePath, backup);

        for (const z of zonesToMove) {
            try {
            // Extract type from block (fallback to master)
            const m = z.block.match(/type\s+([a-zA-Z]+)\s*;/i);
            const zoneType = m ? m[1] : 'master';
            // Add to named.conf.local view with discovered type
            await addZoneToViewConfig(z.name, z.file, viewName, viewAcl, zoneType);
                // Remove block from the original content
                content = removeZoneFromConfigContent(content, z.name);
            } catch (err) {
                console.warn(`Failed moving zone ${z.name} from ${filePath}: ${err.message}`);
            }
        }

        // Write back cleaned source file
        await fs.writeFile(filePath, content, 'utf8');
        return { moved: zonesToMove.length, backup };
    } catch (error) {
        throw new Error(`Failed to move zones from ${filePath} to ${viewName}: ${error.message}`);
    }
}

/**
 * Remove zone from named.conf.local
 */
/**
 * Remove a zone block from named.conf.local (content-only helper)
 * This function only manipulates the provided content string and returns the new content.
 * It is useful for dry-run testing and ensures brace-matching is correct.
 */
function removeZoneFromConfigContent(content, zoneName) {
    const search = new RegExp(`\\bzone\\s+"${zoneName}"`, 'i');
    const match = search.exec(content);
    if (!match) return content; // zone not found

    // Find index of the match and then the first '{' after it
    const startIndex = match.index;
    const afterMatch = content.slice(startIndex);
    const openBraceIndex = afterMatch.indexOf('{');
    if (openBraceIndex === -1) return content; // malformed, nothing to remove

    let idx = startIndex + openBraceIndex; // position of '{' in original content
    let braceCount = 0;
    let endIndex = -1;

    // scan from idx forward to find matching closing brace
    for (let i = idx; i < content.length; i++) {
        const ch = content[i];
        if (ch === '{') braceCount++;
        else if (ch === '}') {
            braceCount--;
            if (braceCount === 0) {
                // include any following semicolon and whitespace/newlines
                let j = i + 1;
                while (j < content.length && /[\s;\n\r]/.test(content[j])) j++;
                endIndex = j;
                break;
            }
        }
    }

    if (endIndex === -1) {
        // Couldn't find matching braces; don't modify
        return content;
    }

    // Remove the block from startIndex up to endIndex
    const before = content.slice(0, startIndex);
    const after = content.slice(endIndex);

    // Clean up resulting content: collapse multiple blank lines
    let newContent = (before + after).replace(/\n{3,}/g, '\n\n');
    // Trim leading/trailing blank lines but preserve final newline
    newContent = newContent.replace(/^\s+/, '').replace(/\s+$/, '') + '\n';
    return newContent;
}

/**
 * Insert a zoneBlock into the specified view in the provided content string.
 * If the view doesn't exist, a new view will be appended (with ACL if provided).
 */
function insertZoneIntoViewContent(content, zoneBlock, viewName, viewAcl = { allow: ['any'], deny: [] }) {
    // Find view occurrence
    const viewSearch = `view "${viewName}"`;
    const idx = content.indexOf(viewSearch);
    if (idx === -1) {
        // Create view block with ACL and zone inside
        const allowList = normalizeList(viewAcl.allow || ['any']);
        const denyList = normalizeList(viewAcl.deny || []);
        const aclLines = [];
        if (allowList.length > 0) {
            const allowNetworks = allowList.join('; ');
            aclLines.push(`    match-clients { ${allowNetworks}; };`);
        }
        if (denyList.length > 0) {
            aclLines.push(`    // deny: ${denyList.join('; ')};`);
        }
        const viewBlock = `\nview "${viewName}" {\n${aclLines.join('\n')}\n\n    ${zoneBlock}\n};\n`;
        return content + viewBlock;
    }

    // view exists; find open brace
    const afterMatch = content.slice(idx);
    const openBraceIndex = afterMatch.indexOf('{');
    if (openBraceIndex === -1) throw new Error(`Malformed view block for ${viewName}`);
    const startBracePos = idx + openBraceIndex;

    // Find matching closing brace
    let braceCount = 0;
    let endBracePos = -1;
    let closingBraceIdx = -1;
    for (let i = startBracePos; i < content.length; i++) {
        if (content[i] === '{') braceCount++;
        else if (content[i] === '}') {
            braceCount--;
            if (braceCount === 0) {
                closingBraceIdx = i;
                let j = i + 1;
                while (j < content.length && /[\s;\n\r]/.test(content[j])) j++;
                endBracePos = j;
                break;
            }
        }
    }
    if (endBracePos === -1) throw new Error(`Could not find end of view ${viewName} block`);

    const viewHeader = content.slice(idx, startBracePos + 1);
    const viewBody = content.slice(startBracePos + 1, closingBraceIdx);
    const viewFooter = content.slice(closingBraceIdx, endBracePos);
    const newViewBlock = `${viewHeader}${viewBody}\n    ${zoneBlock}${viewFooter}`;
    const newContent = content.slice(0, idx) + newViewBlock + content.slice(endBracePos);
    return newContent;
}

/**
 * Build new config content string with zone moved to view (content-only)
 */
async function buildMoveZoneToViewContent(zoneName, zoneFile, targetView, targetViewAcl = { allow: ['any'], deny: [] }) {
    const content = await fs.readFile(NAMED_CONF_LOCAL, 'utf8');
    // Remove zone from any location it exists
    const cleaned = removeZoneFromConfigContent(content, zoneName);

    // Prepare zone block
    const zoneBlock = `zone "${zoneName}" {\n    type master;\n    file "${zoneFile}";\n    allow-update { none; };\n};\n`;

    const newContent = insertZoneIntoViewContent(cleaned, zoneBlock, targetView, targetViewAcl);
    return newContent;
}

/**
 * Remove zone from named.conf.local (safe, atomic write with backup)
 */
async function removeZoneFromConfig(zoneName) {
    try {
        // Backup current config
        const backupFile = `${NAMED_CONF_LOCAL}.backup.${Date.now()}`;
        await fs.copyFile(NAMED_CONF_LOCAL, backupFile);

        const configContent = await fs.readFile(NAMED_CONF_LOCAL, 'utf8');

        const cleanedContent = removeZoneFromConfigContent(configContent, zoneName);

        if (cleanedContent === configContent) {
            console.log(`Zone ${zoneName} not found in config, no changes made`);
            return;
        }

        // Write atomically to temp file then move into place
        const tmpFile = `${NAMED_CONF_LOCAL}.tmp.${Date.now()}`;
        await fs.writeFile(tmpFile, cleanedContent, 'utf8');
        await fs.move(tmpFile, NAMED_CONF_LOCAL, { overwrite: true });

        console.log(`✓ Removed zone ${zoneName} from config`);
        console.log(`✓ Backup saved: ${backupFile}`);
    } catch (error) {
        throw new Error(`Failed to remove zone from config: ${error.message}`);
    }
}

/**
 * List all zones from named.conf.local
 */
async function listConfiguredZones() {
    try {
        const configContent = await fs.readFile(NAMED_CONF_LOCAL, 'utf8');
        const zones = [];
        
        const zoneRegex = /zone\s+"([^"]+)"\s+\{[^}]*file\s+"([^"]+)";[^}]*\}/g;
        let match;
        
        while ((match = zoneRegex.exec(configContent)) !== null) {
            zones.push({
                name: match[1],
                file: match[2]
            });
        }
        
        return zones;
    } catch (error) {
        throw new Error(`Failed to list zones: ${error.message}`);
    }
}

/**
 * Write config file with validation
 */
async function writeConfigWithValidation(filePath, content) {
    try {
        // First check if it's a BIND config file
        if (filePath.includes('named.conf')) {
            const { exec } = require('child_process');
            const util = require('util');
            const execPromise = util.promisify(exec);
            
            // Write to temporary file
            const tmpFile = `${filePath}.tmp.${Date.now()}`;
            await fs.writeFile(tmpFile, content, 'utf8');
            
            // Validate with named-checkconf
            try {
                await execPromise(`named-checkconf -z ${tmpFile}`);
            } catch (error) {
                // Clean up temp file
                await fs.unlink(tmpFile).catch(() => {});
                throw new Error(`BIND config validation failed: ${error.stderr || error.message}`);
            }
            
            // If valid, move to actual location
            await fs.move(tmpFile, filePath, { overwrite: true });
        } else {
            // For non-BIND config files, write directly
            await fs.writeFile(filePath, content, 'utf8');
        }
        
        return { success: true };
    } catch (error) {
        throw new Error(`Failed to write config: ${error.message}`);
    }
}

module.exports = {
    addZoneToConfig,
    addZoneToViewConfig,
    addViewToConfig,
    removeZoneFromConfig,
    removeViewFromConfig,
    listConfiguredViews,
    listConfiguredZones,
    removeZoneFromConfigContent,
    insertZoneIntoViewContent,
    buildMoveZoneToViewContent,
    moveZonesFromFileToGlobal,
    writeConfigWithValidation
};
