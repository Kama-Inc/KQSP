// kqsp_cli.js - Node.js CLI for Kazan's Quick Share Protocol

// Import necessary modules
const {
    Peer
} = require('peerjs'); // PeerJS library for WebRTC
const wrtc = require('wrtc'); // Node.js WebRTC implementation
const readline = require('readline'); // For reading user input from console
const crypto = require('crypto'); // For SHA256 hashing (group key)
const fs = require('fs'); // For potential file operations
const os = require('os'); // For potential OS-specific features
const process = require('process'); // To access command line arguments

// --- Configuration & Global State ---
let MY_PEER_ID = null;
let MY_DISPLAY_ADDR = null;
let peer = null; // PeerJS instance
let group_key = null;
const connections = new Map(); // Map peerId -> DataConnection

// --- K(addr) Generation --- (Simplified version)
function generateKAddr() {
    const parts = Array.from({
        length: 4
    }, () => Math.floor(Math.random() * 256));
    const display = parts.join('.');
    // PeerJS IDs need to be strings, often alphanumeric. Let's use a simpler format for now.
    // A robust version might use UUIDs or ensure uniqueness via the signaling server.
    const peerId = `kqsp-cli-${parts.join('-')}-${Date.now().toString(36).slice(-4)}`;
    return {
        display: `K(${display})`,
        peerId
    };
}

// --- Group Key & Encryption --- (Same logic as web/python)
function updateGroupKey() {
    const peerIds = sorted([MY_PEER_ID, ...connections.keys()]);
    const hasher = crypto.createHash('sha256');
    hasher.update(JSON.stringify(peerIds));
    group_key = hasher.digest();
    // console.log(`[Debug] Group key updated based on: ${peerIds.join(', ')}`);
}

function xorCrypt(dataBuffer, keyBuffer) {
    if (!keyBuffer) {
        return dataBuffer; // No encryption if key is not set
    }
    const keyLen = keyBuffer.length;
    const result = Buffer.alloc(dataBuffer.length);
    for (let i = 0; i < dataBuffer.length; i++) {
        result[i] = dataBuffer[i] ^ keyBuffer[i % keyLen];
    }
    return result;
}

// --- PeerJS Event Handlers ---
function initializePeer(peerId, targetPeerId = null) { // <-- Add targetPeerId argument
    // IMPORTANT: Configure this to match your web version's signaling server!
    const peerJsOptions = {
        host: '0.peerjs.com', // Default public PeerJS server
        port: 443,
        path: '/',
        secure: true,
        // key: 'peerjs', // Default key for public server
        debug: 2, // 0: Errors, 1: Warnings, 2: Info, 3: Verbose
        wrtc: wrtc // Provide the wrtc implementation for Node.js
    };

    peer = new Peer(peerId, peerJsOptions);

    peer.on('open', (id) => {
        MY_PEER_ID = id;
        console.log(`[System] PeerJS connection open. Your Peer ID: ${id}`);
        console.log(`          Your K(addr): ${MY_DISPLAY_ADDR}`);
        updateGroupKey(); // Initial key

        // Auto-connect if targetPeerId was provided via command line
        if (targetPeerId) {
            console.log(`[System] Auto-connecting to ${targetPeerId} from command line...`);
            const conn = peer.connect(targetPeerId, {
                reliable: true,
            });
            setupConnectionHandlers(conn);
        }

        promptUser(); // Start accepting user input
    });

    peer.on('connection', (conn) => {
        console.log(`[System] Incoming connection from ${conn.peer}`);
        setupConnectionHandlers(conn);
    });

    peer.on('disconnected', () => {
        console.log('[System] Disconnected from signaling server. Attempting to reconnect...');
        // PeerJS attempts reconnection automatically
        // Consider adding manual reconnection logic if needed
    });

    peer.on('close', () => {
        console.log('[System] Peer connection closed permanently.');
        // Handle cleanup if necessary
    });

    peer.on('error', (err) => {
        console.error(`[System] PeerJS Error: ${err.type} - ${err.message}`);
        // Handle specific errors (e.g., 'network', 'server-error', 'unavailable-id')
        if (err.type === 'unavailable-id') {
            console.error(`[System] Peer ID ${MY_PEER_ID} is already taken. Please restart.`);
            process.exit(1);
        }
        // Consider attempting to reconnect or exit based on error type
    });
}

function setupConnectionHandlers(conn) {
    conn.on('open', () => {
        console.log(`[System] Data connection established with ${conn.peer}`);
        connections.set(conn.peer, conn);
        updateGroupKey();
        // Optionally send a welcome message or request info
    });

    conn.on('data', (data) => {
        try {
            // PeerJS handles JSON serialization/deserialization if specified, but let's be explicit
            const payload = typeof data === 'string' ? JSON.parse(data) : data;

            if (payload.type === 'text') {
                // Data might be ArrayBuffer, Blob, string, etc. Need to handle Buffer for XOR
                // Assuming text is sent latin1 encoded buffer string from other clients
                const encryptedBuffer = Buffer.from(payload.text, 'latin1');
                const decryptedBuffer = xorCrypt(encryptedBuffer, group_key);
                console.log(`${payload.from}: ${decryptedBuffer.toString('utf-8')}`);
            } else {
                console.log(`[System] Received unhandled message type '${payload.type}' from ${conn.peer}`);
            }
        } catch (e) {
            console.error(`[System] Error processing data from ${conn.peer}:`, e);
            console.error(`[System] Raw data received:`, data);
        }
        promptUser(); // Re-display prompt after message
    });

    conn.on('close', () => {
        console.log(`[System] Connection closed with ${conn.peer}`);
        connections.delete(conn.peer);
        updateGroupKey();
    });

    conn.on('error', (err) => {
        console.error(`[System] Connection error with ${conn.peer}: ${err.message}`);
        connections.delete(conn.peer);
        updateGroupKey();
    });
}

// --- Message Sending ---
function sendTextMessage(text) {
    if (connections.size === 0) {
        console.log('[System] No active connections to send message.');
        return;
    }
    if (!group_key) {
        console.log('[System] Group key not yet established. Cannot send message.');
        return;
    }

    const textBuffer = Buffer.from(text, 'utf-8');
    const encryptedBuffer = xorCrypt(textBuffer, group_key);

    const payload = {
        type: 'text',
        from: MY_DISPLAY_ADDR,
        text: encryptedBuffer.toString('latin1') // Encode buffer as latin1 string for transport
    };

    const messageStr = JSON.stringify(payload);
    let sentToAny = false;

    connections.forEach((conn, peerId) => {
        if (conn.open) {
            try {
                conn.send(messageStr);
                sentToAny = true;
            } catch (e) {
                console.error(`[System] Failed to send to ${peerId}: ${e.message}`);
            }
        } else {
            console.log(`[System] Connection to ${peerId} is not open.`);
        }
    });

    if (sentToAny) {
        console.log(`You: ${text}`); // Show own message
    }
}

// --- Command Line Interface (CLI) --- //
const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: '> '
});

function promptUser() {
    rl.prompt();
}

rl.on('line', (line) => {
    const input = line.trim();
    if (input.startsWith('/connect ')) {
        const targetPeerId = input.substring('/connect '.length).trim();
        if (targetPeerId && peer) {
            console.log(`[System] Attempting to connect to ${targetPeerId}...`);
            const conn = peer.connect(targetPeerId, {
                reliable: true, // Use reliable SCTP
                // serialization: 'json' // Let PeerJS handle JSON
            });
            setupConnectionHandlers(conn);
        } else {
            console.log('[System] Invalid /connect command. Usage: /connect <target_peer_id>');
        }
    } else if (input === '/peers') {
        if (connections.size > 0) {
            console.log('[System] Connected peers:');
            connections.forEach((conn, peerId) => {
                console.log(` - ${peerId} (${conn.open ? 'open' : 'pending/closed'})`);
            });
        } else {
            console.log('[System] No peers connected.');
        }
    } else if (input === '/myid') {
        console.log(`[System] Your Peer ID: ${MY_PEER_ID}`);
        console.log(`          Your K(addr): ${MY_DISPLAY_ADDR}`);
    } else if (input === '/quit') {
        console.log('[System] Exiting...');
        rl.close();
        if (peer) {
            peer.destroy(); // Close connections and disconnect from signaling server
        }
        process.exit(0);
    } else if (input.startsWith('/')) {
        console.log(`[System] Unknown command: ${input.split(' ')[0]}`);
        console.log('[System] Available commands: /connect <peer_id>, /peers, /myid, /quit');
    } else if (input) {
        sendTextMessage(input);
    }
    promptUser(); // Always re-prompt unless quitting
});

rl.on('close', () => {
    console.log(' [System] Readline closed.Exiting.');
    if (peer) {
        peer.destroy();
    }
    process.exit(0);
});

// --- Initialization ---
function main(targetPeerId = null) { // <-- Add targetPeerId argument
    const {
        display,
        peerId
    } = generateKAddr();
    MY_DISPLAY_ADDR = display;
    // Use generated ID or allow override via args later?
    initializePeer(peerId, targetPeerId); // <-- Pass targetPeerId
}

// Helper for sorting keys
function sorted(arr) {
    return [...arr].sort();
}

// --- Argument Parsing & Start --- //
function parseArgs() {
    const args = process.argv.slice(2); // Skip 'node' and script path
    let targetPeerId = null;
    const connectIndex = args.indexOf('--connect');

    if (connectIndex !== -1 && args.length > connectIndex + 1) {
        targetPeerId = args[connectIndex + 1];
        // Remove K() or K prefix if present, as PeerJS IDs don't use it
        if (targetPeerId.startsWith('K(') && targetPeerId.endsWith(')')) {
            targetPeerId = targetPeerId.substring(2, targetPeerId.length - 1);
        } else if (targetPeerId.startsWith('K')) {
            targetPeerId = targetPeerId.substring(1);
        }
        // Basic validation: PeerJS IDs usually don't look like IP addresses
        // This is a weak check, PeerJS IDs can be varied.
        // A better approach might be needed if K(addr) format needs direct mapping.
        // For now, we assume the user provides the actual PeerJS ID.
        console.log(`[System] Target Peer ID from args: ${targetPeerId}`);
    }
    return targetPeerId;
}

const targetPeerIdFromArgs = parseArgs();
main(targetPeerIdFromArgs); // <-- Pass parsed target ID to main

// Remove the duplicate call below
// main();