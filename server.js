// server.js
console.log('Starting WhatsApp Authentication Server...');
require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const cors = require('cors');
const path = require('path'); // Path module
const venom = require('venom-bot');
const fs = require('fs'); // File system module for conversation history
const { getLLMResponse } = require('./gptLLM'); // Import from gptLLM.js

// --- p-limit import solution ---
let pLimit;
try {
    const pLimitPackage = require('p-limit');
    pLimit = pLimitPackage.default || pLimitPackage;
    if (typeof pLimit !== 'function') {
        if (pLimitPackage && typeof pLimitPackage.default === 'function') {
            pLimit = pLimitPackage.default;
        } else {
            throw new Error('pLimit is not a function after attempting to import.');
        }
    }
} catch (e) {
    console.error("FATAL: Failed to import or resolve 'p-limit'. Ensure it's installed (npm install p-limit) and not corrupted.", e);
    process.exit(1);
}
// --- p-limit import end ---

// --- Environment variables and constants ---
const PORT = process.env.PORT || 3001; // Changed to port 3001 to avoid conflicts
const SESSION_NAME = process.env.SESSION_NAME || 'api-whatsapp-bot-session';
const CONCURRENCY_LIMIT_LLM = parseInt(process.env.CONCURRENCY_LIMIT_LLM) || 2;
const MAX_CONVERSATION_HISTORY = parseInt(process.env.MAX_CONVERSATION_HISTORY) || 10;
const MAX_HISTORY_LENGTH = MAX_CONVERSATION_HISTORY; // Alias for MAX_CONVERSATION_HISTORY
const CONVERSATION_HISTORY_DIR = path.join(__dirname, 'conversation_history'); // Root folder
const PUPPETEER_EXECUTABLE_PATH = process.env.PUPPETEER_EXECUTABLE_PATH || undefined;

// Check if running on Render.com
const IS_RENDER = process.env.RENDER === 'true';

const llmLimit = pLimit(CONCURRENCY_LIMIT_LLM);
console.log(`[Setup] Session Name: ${SESSION_NAME}`);
console.log(`[Setup] LLM Concurrency Limit: ${CONCURRENCY_LIMIT_LLM}`);
console.log(`[Setup] Max Conversation History: ${MAX_CONVERSATION_HISTORY}`);
// --- ---

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: "*", // For development, specify origin in production
        methods: ["GET", "POST"]
    }
});

// --- Global variables for bot instance and status ---
let venomClientInstance = null;
let currentQRBase64 = null;
let botCurrentStatus = "OFFLINE"; // OFFLINE, INITIALIZING, SCAN_QR, CONNECTED, DISCONNECTED, ERROR
let aiResponsesEnabled = true; // Flag to toggle AI responses on/off
// --- ---

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'frontend'))); // Serve frontend files

// --- Conversation history load and save helper functions ---
async function loadConversationHistory(chatId) {
    const sanitizedChatId = chatId.replace(/[^a-z0-9_.-]/gi, '_');
    const historyFilePath = path.join(CONVERSATION_HISTORY_DIR, `${sanitizedChatId}.json`);
    try {
        await fs.promises.mkdir(CONVERSATION_HISTORY_DIR, { recursive: true });
        const data = await fs.promises.readFile(historyFilePath, 'utf8');
        return JSON.parse(data);
    } catch (error) {
        if (error.code === 'ENOENT') { return []; }
        console.error(`[History Error] Failed to load conversation history for ${chatId}:`, error);
        return [];
    }
}

async function saveConversationHistory(chatId, history) {
    const sanitizedChatId = chatId.replace(/[^a-z0-9_.-]/gi, '_');
    const historyFilePath = path.join(CONVERSATION_HISTORY_DIR, `${sanitizedChatId}.json`);
    try {
        await fs.promises.mkdir(CONVERSATION_HISTORY_DIR, { recursive: true });
        const trimmedHistory = history.slice(-MAX_HISTORY_LENGTH);
        await fs.promises.writeFile(historyFilePath, JSON.stringify(trimmedHistory, null, 2), 'utf8');
    } catch (error) {
        console.error(`[History Error] Failed to save conversation history for ${chatId}:`, error);
    }
}
// --- ---

// --- Socket.IO connection handling ---
io.on('connection', (socket) => {
    console.log('[SocketIO] Client connected:', socket.id);
    socket.emit('bot_status', { status: botCurrentStatus, qr: currentQRBase64, sessionId: SESSION_NAME });

    socket.on('disconnect', () => {
        console.log('[SocketIO] Client disconnected:', socket.id);
    });
});
// --- ---

// --- Venom Bot start/stop and message handling ---
/**
 * Checks if a WhatsApp session is valid
 * @param {string} sessionName - The name of the session to check
 * @returns {Promise<{valid: boolean, sessionDir: string, sessionFiles: string[]}>} - Session validity info
 */
async function checkWhatsAppSession(sessionName) {
    const TOKENS_DIR = path.join(__dirname, 'tokens');
    const SESSION_DIR = path.join(TOKENS_DIR, sessionName);

    try {
        // Create tokens directory if it doesn't exist
        await fs.promises.mkdir(TOKENS_DIR, { recursive: true });
        await fs.promises.mkdir(SESSION_DIR, { recursive: true });
        console.log('[VenomCtrl] Session directory checked/created at:', SESSION_DIR);

        // Check if session exists and has files
        const sessionFiles = await fs.promises.readdir(SESSION_DIR);
        const hasSessionFiles = sessionFiles.length > 0;

        if (hasSessionFiles) {
            console.log(`[VenomCtrl] Existing session found for ${sessionName} with ${sessionFiles.length} files`);
            // Additional validation could be added here to check for specific session files
            return { valid: true, sessionDir: SESSION_DIR, sessionFiles };
        } else {
            console.log(`[VenomCtrl] No valid session files found for ${sessionName}`);
            return { valid: false, sessionDir: SESSION_DIR, sessionFiles: [] };
        }
    } catch (err) {
        console.error('[VenomCtrl] Error checking session:', err);
        return { valid: false, sessionDir: SESSION_DIR, sessionFiles: [] };
    }
}

/**
 * Cleans up an invalid WhatsApp session
 * @param {string} sessionDir - The directory of the session to clean
 * @returns {Promise<boolean>} - Whether cleanup was successful
 */
async function cleanupInvalidSession(sessionDir) {
    try {
        await fs.promises.rm(sessionDir, { recursive: true, force: true });
        await fs.promises.mkdir(sessionDir, { recursive: true });
        console.log('[VenomCtrl] Invalid session cleaned up successfully');
        return true;
    } catch (err) {
        console.error('[VenomCtrl] Error cleaning up invalid session:', err);
        return false;
    }
}

async function startVenomBot() {
    if (venomClientInstance) {
        console.log('[VenomCtrl] Bot is already running or in the process of starting.');
        io.emit('bot_status', { status: botCurrentStatus, qr: currentQRBase64, sessionId: SESSION_NAME });
        return { status: botCurrentStatus, qr: currentQRBase64, sessionId: SESSION_NAME, message: "Bot already active or starting." };
    }

    botCurrentStatus = "INITIALIZING";
    io.emit('bot_status', { status: botCurrentStatus, qr: null, sessionId: SESSION_NAME });
    console.log('[VenomCtrl] Attempting to start bot...');

    // Check if session exists and is valid
    const sessionStatus = await checkWhatsAppSession(SESSION_NAME);

    // If session is invalid, clean it up before starting
    if (!sessionStatus.valid) {
        console.log('[VenomCtrl] No valid session found or session is corrupted. Cleaning up...');
        await cleanupInvalidSession(sessionStatus.sessionDir);
    } else {
        console.log('[VenomCtrl] Valid session found. Attempting to restore...');
    }

    try {
        venomClientInstance = await venom.create({
            session: SESSION_NAME,
            catchQR: (base64Qr, _asciiQR, attempts) => {
                currentQRBase64 = base64Qr;
                botCurrentStatus = "SCAN_QR";
                console.log(`[VenomCtrl] QR Code generated (Attempt ${attempts}). Status: SCAN_QR`);
                io.emit('bot_status', { status: botCurrentStatus, qr: currentQRBase64, sessionId: SESSION_NAME });
                io.emit('qr_code', base64Qr); // QR code event
            },
            statusFind: (statusSession, session) => {
                botCurrentStatus = statusSession; // Status from Venom
                console.log(`[VenomCtrl] Status Update - Session: ${session}, Raw Status: ${statusSession}`);

                if (['isLogged', 'qrReadSuccess', 'successChat', 'CONNECTED'].includes(statusSession)) {
                    botCurrentStatus = "CONNECTED";
                    currentQRBase64 = null; // No need for QR when connected
                    console.log('[VenomCtrl] Bot successfully connected to WhatsApp.');
                    console.log('[VenomCtrl] Session data saved for future use');
                } else if (['notLogged'].includes(statusSession)) {
                    console.log('[VenomCtrl] Session requires new login, generating QR code');
                } else if (['UNPAIRED', 'DISCONNECTED', 'UNLAUNCHED', 'ब्राउज़र बंद'].includes(statusSession)) {
                    botCurrentStatus = "DISCONNECTED";
                    currentQRBase64 = null;
                    venomClientInstance = null; // Reset client
                    console.warn(`[VenomCtrl] Bot disconnected or unpaired. Status: ${statusSession}`);
                }

                io.emit('bot_status', { status: botCurrentStatus, qr: currentQRBase64, sessionId: SESSION_NAME });
            },
            headless: 'new',
            logQR: false, // We're manually sending QR via io.emit
            autoClose: 0, // Disable auto close to prevent session issues
            disableSpins: true,
            disableWelcome: true,
            updatesLog: true,
            // Session data storage configuration
            folderNameToken: 'tokens', // Folder name where the session tokens will be saved
            createPathFileToken: true, // Create the folder structure for tokens
            // Browser options
            puppeteerOptions: {
                args: [
                    '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
                    '--disable-accelerated-2d-canvas', '--no-first-run', '--no-zygote',
                    '--disable-gpu', '--mute-audio', '--single-process'
                ],
                executablePath: PUPPETEER_EXECUTABLE_PATH || undefined,
                // Use smaller disk cache and memory to work better on Render
                ...(IS_RENDER ? {
                    userDataDir: '/tmp/puppeteer-data',
                } : {})
            },
            multidevice: true, // Enable multidevice support
            useChrome: true, // Use Chrome instead of Chromium
            debug: false, // Set to true for debugging session issues
        });

        if (typeof venomClientInstance.reply !== 'function' || typeof venomClientInstance.sendText !== 'function') {
            console.error('[VenomCtrl Critical Error] Essential client functions are missing after initialization!');
            botCurrentStatus = "ERROR";
            io.emit('bot_status', { status: botCurrentStatus, error: "Client functions missing.", sessionId: SESSION_NAME });
            if (venomClientInstance && typeof venomClientInstance.close === 'function') await venomClientInstance.close();
            venomClientInstance = null;
            return { status: botCurrentStatus, error: "Client functions missing." };
        }

        console.log('[VenomCtrl] Venom client initialized. Attaching message listener...');
        attachMessageListener(venomClientInstance);

        // If session was restored and QR scan not needed
        if (sessionStatus.valid && botCurrentStatus !== "SCAN_QR") {
            botCurrentStatus = "CONNECTED";
            currentQRBase64 = null;
            console.log('[VenomCtrl] Successfully restored previous session');
        }

        io.emit('bot_status', { status: botCurrentStatus, qr: currentQRBase64, sessionId: SESSION_NAME });
        return { status: botCurrentStatus, qr: currentQRBase64, sessionId: SESSION_NAME, message: "Bot started." };

    } catch (error) {
        console.error('[VenomCtrl Error] Error during bot startup:', error);

        // Check if error is related to invalid session
        if (error.message && (
            error.message.includes('Failed to authenticate') ||
            error.message.includes('session expired') ||
            error.message.includes('invalid session') ||
            error.message.includes('browser.browserContexts') ||
            error.message.includes('Protocol error') ||
            error.message.includes('Target closed')
        )) {
            console.log('[VenomCtrl] Session appears to be invalid or expired. Cleaning up session data...');

            try {
                // Delete the session directory to force new QR code generation
                await cleanupInvalidSession(sessionStatus.sessionDir);
                console.log('[VenomCtrl] Old session data removed. Please restart the bot to generate a new QR code.');
            } catch (cleanupErr) {
                console.error('[VenomCtrl] Error cleaning up invalid session:', cleanupErr);
            }

            botCurrentStatus = "ERROR";
            io.emit('bot_status', {
                status: botCurrentStatus,
                error: "Session expired or invalid. Please restart the bot to generate a new QR code.",
                sessionId: SESSION_NAME
            });
        } else {
            botCurrentStatus = "ERROR";
            io.emit('bot_status', { status: botCurrentStatus, error: error.message || String(error), sessionId: SESSION_NAME });
        }

        venomClientInstance = null;
        throw error; // Throw error for API call
    }
}

async function stopVenomBot() {
    if (venomClientInstance && typeof venomClientInstance.close === 'function') {
        console.log('[VenomCtrl] Attempting to stop bot...');
        try {
            await venomClientInstance.close();
            console.log('[VenomCtrl] Bot stopped successfully.');
            return { message: "Bot stopped successfully." };
        } catch (error) {
            console.error('[VenomCtrl Error] Error stopping bot:', error);
            throw error;
        } finally {
            venomClientInstance = null;
            currentQRBase64 = null;
            botCurrentStatus = "OFFLINE";
            io.emit('bot_status', { status: botCurrentStatus, qr: null, sessionId: SESSION_NAME });
        }
    } else {
        console.log('[VenomCtrl] Bot is not running, no action taken.');
        // Update status if not already OFFLINE
        if (botCurrentStatus !== "OFFLINE") {
            botCurrentStatus = "OFFLINE";
            currentQRBase64 = null;
            io.emit('bot_status', { status: botCurrentStatus, qr: null, sessionId: SESSION_NAME });
        }
        return { message: "Bot is not currently running." };
    }
}

function attachMessageListener(client) {
    client.onMessage(async (message) => {
        io.emit('new_message', {
            type: 'user',
            id: message.id,
            from: message.from,
            senderName: message.sender ? (message.sender.pushname || message.sender.verifiedName) : 'Unknown',
            text: message.body,
            isGroup: message.isGroupMsg,
            chatId: message.chatId,
            timestamp: new Date(message.timestamp * 1000).toISOString()
        });

        if (message.fromMe || message.type !== 'chat' || !message.body || message.body.trim() === "") return;

        // Check for AI toggle command
        if (message.body.trim().toLowerCase() === '/ai on') {
            aiResponsesEnabled = true;
            await client.reply(message.chatId, "✅ Suno AI responses are now *ENABLED*", message.id);
            io.emit('ai_toggle_status', { enabled: true });
            return;
        } else if (message.body.trim().toLowerCase() === '/ai off') {
            aiResponsesEnabled = false;
            await client.reply(message.chatId, "❌ Suno AI responses are now *DISABLED*", message.id);
            io.emit('ai_toggle_status', { enabled: false });
            return;
        }

        // Skip AI processing if AI responses are disabled
        if (!aiResponsesEnabled) {
            console.log('[VenomCtrl] Skipping AI response because AI responses are disabled');
            return;
        }

        llmLimit(async () => {
            try {
                let convHistory = await loadConversationHistory(message.chatId);
                let userMsgForLLM = message.body;
                // Optional: Add sender name for group messages
                // if (message.isGroupMsg && message.sender && message.sender.pushname) {
                //     userMsgForLLM = `${message.sender.pushname}: ${message.body}`;
                // }
                convHistory.push({role: "user", content: userMsgForLLM});

                const historyForLLM = convHistory.slice(-MAX_HISTORY_LENGTH);
                const systemPrompt = "You are a friendly WhatsApp assistant. Remember previous parts of the conversation. Keep responses concise.";
                const llmResponseText = await getLLMResponse(userMsgForLLM, systemPrompt, historyForLLM.slice(0,-1));

                convHistory.push({role: "assistant", content: llmResponseText});
                await saveConversationHistory(message.chatId, convHistory);

                if (typeof client.reply === 'function') {
                    await client.reply(message.chatId, llmResponseText, message.id);
                    io.emit('new_message', {
                        type: 'ai_reply',
                        id: `bot_${message.id}`,
                        to: message.chatId,
                        text: llmResponseText,
                        quotedMsgId: message.id,
                        timestamp: new Date().toISOString()
                    });
                } else {
                     console.error(`[VenomCtrl] client.reply function is missing! Cannot send LLM response for message ${message.id}.`);
                }
            } catch (e) {
                console.error(`[VenomCtrl] Error processing LLM response or replying for message ${message.id} in chat ${message.chatId}:`, e);
                io.emit('bot_error', { message: `Error processing LLM response: ${e.message}`, chatId: message.chatId, originalMsgId: message.id });
            }
        });
    });

    client.onStateChange((state) => { // This onStateChange event may duplicate with venom.create's statusCallback
        console.log('[VenomCtrl] Client State Change (onStateChange):', state);

        // Handle different state changes
        if (['CONNECTED'].includes(state)) {
            if (botCurrentStatus !== "CONNECTED") {
                console.log('[VenomCtrl] Client connected via onStateChange');
                botCurrentStatus = "CONNECTED";
                currentQRBase64 = null;
                io.emit('bot_status', { status: botCurrentStatus, qr: currentQRBase64, sessionId: SESSION_NAME });
            }
        } else if (['UNPAIRED', 'DISCONNECTED', 'UNLAUNCHED', 'ब्राउज़र बंद'].includes(state)) {
            if (botCurrentStatus !== "DISCONNECTED") { // If status is not already DISCONNECTED
                console.warn(`[VenomCtrl] Client disconnected/unpaired via onStateChange. Current bot status: ${botCurrentStatus}`);
                botCurrentStatus = "DISCONNECTED";
                currentQRBase64 = null;
                if (venomClientInstance === client) { // If this is the current active client
                    venomClientInstance = null;
                }
                io.emit('bot_status', { status: botCurrentStatus, qr: currentQRBase64, sessionId: SESSION_NAME });
            }
        } else if (['CONFLICT', 'OPENING'].includes(state)) {
            console.log(`[VenomCtrl] Client state: ${state}. Taking action...`);
            if (state === 'CONFLICT') {
                client.useHere(); // Force WhatsApp to use this session
                console.log('[VenomCtrl] Resolved conflict by using session here');
            }
        }
    });
}
// --- ---

// --- API Endpoints ---
app.get('/api/status', (_req, res) => {
    res.json({
        status: botCurrentStatus,
        qr: currentQRBase64,
        sessionId: SESSION_NAME,
        aiEnabled: aiResponsesEnabled
    });
});

app.post('/api/start', async (_req, res) => {
    try {
        const response = await startVenomBot();
        res.status(200).json(response);
    } catch (error) {
        res.status(500).json({ message: "Failed to start bot.", error: error.message || String(error), status: "ERROR" });
    }
});

app.post('/api/stop', async (_req, res) => {
    try {
        const response = await stopVenomBot();
        res.status(200).json(response);
    } catch (error) {
        res.status(500).json({ message: "Failed to stop bot.", error: error.message || String(error), status: "ERROR" });
    }
});

// Toggle AI responses
app.post('/api/toggle-ai', (_req, res) => {
    try {
        aiResponsesEnabled = !aiResponsesEnabled;
        console.log(`[AI Toggle] Suno AI responses are now ${aiResponsesEnabled ? 'ENABLED' : 'DISABLED'}`);

        // Broadcast the new status to all connected clients
        io.emit('ai_toggle_status', { enabled: aiResponsesEnabled });

        res.status(200).json({
            success: true,
            aiEnabled: aiResponsesEnabled,
            message: `Suno AI responses are now ${aiResponsesEnabled ? 'enabled' : 'disabled'}`
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            message: "Failed to toggle AI responses",
            error: error.message || String(error)
        });
    }
});

// A simple root API to test if it's working properly
app.get('/api', (_req, res) => {
    res.send('WhatsApp Bot API Server is running! Use /api/status, /api/start, /api/stop, /api/toggle-ai.');
});

// Health check endpoint for Render
app.get('/health', (_req, res) => {
    res.status(200).json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Redirect root to frontend
app.get('/', (_req, res) => {
    res.sendFile(path.join(__dirname, 'frontend', 'index.html'));
});
// --- ---

/**
 * Periodically checks the WhatsApp connection state and attempts to reconnect if needed
 */
function startSessionMonitor() {
    const CHECK_INTERVAL = 5 * 60 * 1000; // Check every 5 minutes

    console.log('[SessionMonitor] Starting WhatsApp session monitor');

    setInterval(async () => {
        // Only check if we have a client instance
        if (venomClientInstance) {
            try {
                // Check connection state
                const connectionState = await venomClientInstance.getConnectionState();
                console.log(`[SessionMonitor] Current connection state: ${connectionState}`);

                if (connectionState !== 'CONNECTED') {
                    console.log('[SessionMonitor] WhatsApp is not connected. Current status:', botCurrentStatus);

                    // If we're in a disconnected state, attempt to reconnect
                    if (['DISCONNECTED', 'ERROR'].includes(botCurrentStatus)) {
                        console.log('[SessionMonitor] Attempting to restart WhatsApp connection...');

                        // Close the current instance if it exists
                        if (venomClientInstance && typeof venomClientInstance.close === 'function') {
                            try {
                                await venomClientInstance.close();
                            } catch (err) {
                                console.error('[SessionMonitor] Error closing client:', err);
                            }
                        }

                        venomClientInstance = null;

                        // Restart the bot
                        try {
                            await startVenomBot();
                            console.log('[SessionMonitor] WhatsApp connection restarted successfully');
                        } catch (err) {
                            console.error('[SessionMonitor] Failed to restart WhatsApp connection:', err);
                        }
                    }
                }
            } catch (err) {
                console.error('[SessionMonitor] Error checking WhatsApp connection:', err);
            }
        }
    }, CHECK_INTERVAL);
}

// --- Start server ---
server.listen(PORT, () => {
    console.log(`[Server] API Server listening on http://localhost:${PORT}`);
    console.log(`[API Endpoints] Available at http://localhost:${PORT}/api`);

    // Start the session monitor
    startSessionMonitor();
});
// --- ---

// --- Graceful Shutdown ---
const signals = ['SIGINT', 'SIGTERM', 'SIGQUIT'];
signals.forEach(sig => {
  process.on(sig, async () => {
    console.log(`[Server Shutdown] Received ${sig}. Attempting graceful shutdown...`);

    // Properly close WhatsApp connection to preserve session
    if (venomClientInstance && typeof venomClientInstance.close === 'function') {
      try {
        console.log('[Server Shutdown] Attempting to close Venom client connection...');

        // First ensure we're in a good state
        const state = await venomClientInstance.getConnectionState();
        console.log(`[Server Shutdown] Current connection state: ${state}`);

        // Close the client
        await venomClientInstance.close();
        console.log('[Server Shutdown] Venom client connection closed.');

        // Wait a moment for session data to be saved
        await new Promise(resolve => setTimeout(resolve, 1000));
      } catch (e) {
        console.error('[Server Shutdown] Error closing Venom client:', e);
      } finally {
        venomClientInstance = null;
      }
    }

    // Close HTTP server
    server.close(() => {
      console.log('[Server Shutdown] HTTP server closed.');
      process.exit(0); // Exit successfully
    });

    // Force exit after a certain time (if server doesn't close properly)
    setTimeout(() => {
        console.error("[Server Shutdown] Could not close connections in time, forcefully shutting down");
        process.exit(1);
    }, 15000); // 15 seconds to allow for proper session saving
  });
});