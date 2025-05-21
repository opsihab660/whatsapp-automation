// trackerBot.js
const venom = require('venom-bot');
const fs = require('fs').promises; // Async file system operations
const path = require('path');
const { getLLMResponse } = require('./gptLLM'); // gptLLM.js থেকে ইম্পোর্ট

// --- p-limit ইম্পোর্টের জন্য শক্তিশালী সমাধান ---
let pLimit;
try {
    const pLimitPackage = require('p-limit');
    pLimit = pLimitPackage.default || pLimitPackage; // CommonJS/ESM compatibility
    if (typeof pLimit !== 'function') {
        if (pLimitPackage && typeof pLimitPackage.default === 'function') {
            pLimit = pLimitPackage.default;
        } else {
            console.error('Critical error: pLimit is not a function after attempting to import.');
            throw new Error('pLimit could not be imported as a function.');
        }
    }
} catch (e) {
    console.error("FATAL: Failed to import or resolve 'p-limit'. Ensure it's installed (npm install p-limit) and not corrupted.", e);
    process.exit(1); // p-limit ছাড়া কনকারেন্সি কন্ট্রোল সম্ভব নয়
}
// --- p-limit ইম্পোর্ট শেষ ---

// --- এনভায়রনমেন্ট ভেরিয়েবল ও কনস্ট্যান্ট ---
const CONCURRENCY_LIMIT_LLM = parseInt(process.env.CONCURRENCY_LIMIT_LLM) || 2; // LLM API কলের জন্য
const llmLimit = pLimit(CONCURRENCY_LIMIT_LLM);
console.log(`[Setup] LLM Concurrency Limit set to: ${CONCURRENCY_LIMIT_LLM}`);

const SESSION_NAME = process.env.SESSION_NAME || 'whatsapp-gpt-bot-default-session';
console.log(`[Setup] Using session name: ${SESSION_NAME}`);

const CONVERSATION_HISTORY_DIR = path.join(__dirname, 'conversation_history');
const MAX_HISTORY_LENGTH = parseInt(process.env.MAX_CONVERSATION_HISTORY) || 10; // প্রতি চ্যাটে কতগুলো মেসেজ মনে রাখবে
console.log(`[Setup] Max conversation history length per chat: ${MAX_HISTORY_LENGTH}`);

const MAIN_LOG_FILE_PATH = path.join(__dirname, `${SESSION_NAME.replace(/[^a-z0-9_.-]/gi, '_')}_main_events.log`); // সাধারণ ইভেন্ট লগ
const CHAT_LOG_FILE_PATH = path.join(__dirname, `${SESSION_NAME.replace(/[^a-z0-9_.-]/gi, '_')}_chat_messages.log`); // চ্যাট মেসেজ লগ

let venomClientInstance = null; // Venom client instance (সিগন্যাল হ্যান্ডলারের জন্য)
const PUPPETEER_EXECUTABLE_PATH = process.env.PUPPETEER_EXECUTABLE_PATH || undefined; // ঐচ্ছিক
// --- ---

// --- Helper Function: সাধারণ লগিং ---
async function logEvent(level, message, data = null) {
    const timestamp = new Date().toISOString();
    const logMessage = `[${timestamp}] [${level.toUpperCase()}] ${message}` + (data ? ` | Data: ${JSON.stringify(data)}` : '');
    console.log(logMessage);
    try {
        await fs.appendFile(MAIN_LOG_FILE_PATH, logMessage + '\n');
    } catch (err) {
        console.error(`[Log Error] Failed to write to main event log: ${MAIN_LOG_FILE_PATH}`, err);
    }
}
// --- ---

// --- কথোপকথনের ইতিহাস লোড এবং সেভ করার Helper Functions ---
async function loadConversationHistory(chatId) {
    const sanitizedChatId = chatId.replace(/[^a-z0-9_.-]/gi, '_');
    const historyFilePath = path.join(CONVERSATION_HISTORY_DIR, `${sanitizedChatId}.json`);
    try {
        await fs.mkdir(CONVERSATION_HISTORY_DIR, { recursive: true });
        const data = await fs.readFile(historyFilePath, 'utf8');
        return JSON.parse(data);
    } catch (error) {
        if (error.code === 'ENOENT') { return []; } // ফাইল না থাকলে খালি অ্যারে
        logEvent('error', `Failed to load conversation history for ${chatId}`, error.message);
        return [];
    }
}

async function saveConversationHistory(chatId, history) {
    const sanitizedChatId = chatId.replace(/[^a-z0-9_.-]/gi, '_');
    const historyFilePath = path.join(CONVERSATION_HISTORY_DIR, `${sanitizedChatId}.json`);
    try {
        await fs.mkdir(CONVERSATION_HISTORY_DIR, { recursive: true });
        const trimmedHistory = history.slice(-MAX_HISTORY_LENGTH); // শুধু শেষ কিছু মেসেজ রাখা
        await fs.writeFile(historyFilePath, JSON.stringify(trimmedHistory, null, 2), 'utf8');
    } catch (error) {
        logEvent('error', `Failed to save conversation history for ${chatId}`, error.message);
    }
}
// --- ---

venom
  .create(
    SESSION_NAME,
    (base64Qr, asciiQR, attempts, urlCode) => {
      logEvent('info', `QR Scan Attempt: ${attempts}. Scan with WhatsApp.`);
      console.log(asciiQR); // QR কোড টার্মিনালে দেখানো
    },
    (statusSession, session) => {
      logEvent('info', `Venom Status - Session: ${session}, Status: ${statusSession}`);
      if (['isLogged', 'qrReadSuccess', 'successChat', 'CONNECTED'].includes(statusSession)) {
        logEvent('info', 'Venom client successfully connected/restored and ready!');
      }
    },
    { // Venom অপশনস
      headless: 'new',
      logQR: true,
      autoClose: 60000, // ms
      disableSpins: true,
      puppeteerOptions: {
        args: [
          '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
          '--disable-accelerated-2d-canvas', '--no-first-run', '--no-zygote',
          '--disable-gpu', '--mute-audio'
        ],
        executablePath: PUPPETEER_EXECUTABLE_PATH || undefined, // যদি .env থেকে পাথ দেওয়া হয়
      },
    }
  )
  .then(async (client) => {
    logEvent('info', 'Venom client instance created successfully.');
    venomClientInstance = client;

    if (typeof client.reply !== 'function' || typeof client.sendSeen !== 'function' || typeof client.sendText !== 'function') {
        logEvent('error', 'One or more essential Venom client functions (reply, sendSeen, sendText) are missing! Bot functionality will be severely limited.', { availableKeys: Object.keys(client) });
        // আপনি চাইলে এখানে প্রস্থান করতে পারেন: process.exit(1);
    } else {
        logEvent('info', 'Essential Venom client functions (reply, sendSeen, sendText) appear to be available.');
    }
    startBotLogic(client);
  })
  .catch((error) => {
    logEvent('fatal', 'Failed to create Venom session. Exiting.', error.message || error);
    process.exit(1);
  });

async function startBotLogic(client) {
  logEvent('info', `GPT LLM Bot with Conversation History is now active for session: ${SESSION_NAME}. Waiting for messages...`);

  client.onMessage(async (message) => {
    const messageId = message.id;
    const chatId = message.chatId;
    const receivedAt = new Date().toISOString();

    // বিস্তারিত ইনকামিং মেসেজ লগ (ঐচ্ছিক, ডিবাগিং এর জন্য)
    // logEvent('debug', `Message IN - ID: ${messageId}, Chat: ${chatId}, From: ${message.from}, Author: ${message.author}, Type: ${message.type}`);

    if (message.fromMe) { return; } // নিজের পাঠানো মেসেজ উপেক্ষা করা

    const userMessageContent = message.body;
    if (message.type !== 'chat' || !userMessageContent || userMessageContent.trim() === "") {
      // logEvent('debug', `Skipping non-text/empty message - ID: ${messageId}`);
      return;
    }

    llmLimit(async () => {
      const taskStartTime = new Date();
      // logEvent('info', `LLM Task Start - ID: ${messageId}, Chat: ${chatId}, UserMsg: "${userMessageContent.substring(0,30)}..."`);

      try {
        if (typeof client.sendSeen === 'function') { await client.sendSeen(chatId); }

        logChatMessageToFile(message, 'USER_MESSAGE_RECEIVED');
        let currentConversation = await loadConversationHistory(chatId);
        let processedUserMsg = userMessageContent;

        // গ্রুপ মেসেজের ক্ষেত্রে প্রেরকের নাম যোগ করা (ঐচ্ছিক)
        if (message.isGroupMsg && message.sender && message.sender.pushname) {
            // processedUserMsg = `${message.sender.pushname}: ${userMessageContent}`;
        }
        currentConversation.push({ role: "user", content: processedUserMsg });

        const historyForLLM = currentConversation.slice(-MAX_HISTORY_LENGTH); // শেষ কিছু মেসেজ
        const systemPrompt = "You are a friendly and helpful WhatsApp assistant. You remember the previous parts of the conversation in this chat. Be concise unless asked for more details.";
        const llmResponseText = await getLLMResponse(processedUserMsg, systemPrompt, historyForLLM.slice(0, -1)); // বর্তমান ইউজার মেসেজ বাদ দিয়ে হিস্টোরি

        currentConversation.push({ role: "assistant", content: llmResponseText });
        await saveConversationHistory(chatId, currentConversation);

        if (typeof client.reply === 'function') {
          await client.reply(chatId, llmResponseText, messageId);
          // logEvent('info', `LLM Reply Sent - ID: ${messageId}, Chat: ${chatId}, LLM_Resp: "${llmResponseText.substring(0,30)}..."`);
          logChatMessageToFile({ ...message, body: llmResponseText, fromMe: true, quotedMsg: messageId, id: `bot_${messageId}` }, 'BOT_LLM_REPLY_SENT');
        } else {
          logEvent('error', `LLM Reply Error - ID: ${messageId}, client.reply function unavailable. Attempting sendText.`);
          if (typeof client.sendText === 'function') {
            await client.sendText(chatId, `(AI Reply) ${llmResponseText}`);
          } else {
            logEvent('error', `LLM Reply Fallback Error - ID: ${messageId}, client.sendText also unavailable.`);
          }
        }
      } catch (error) {
        logEvent('error', `LLM Task Error - ID: ${messageId}, Chat: ${chatId}`, error.message || error);
        try {
          if (typeof client.reply === 'function') {
            await client.reply(chatId, "I'm having a little trouble thinking right now. Please try again soon.", messageId);
          }
        } catch (replyError) {
          logEvent('error', `LLM Task Error Fallback Reply Error - ID: ${messageId}, Chat: ${chatId}`, replyError.message);
        }
      } finally {
        const taskEndTime = new Date();
        const duration = (taskEndTime - taskStartTime) / 1000; // সেকেন্ডে
        logEvent('debug', `LLM Task End - ID: ${messageId}, Chat: ${chatId}, Duration: ${duration.toFixed(2)}s`);
      }
    }).catch(pLimitQueueError => {
        logEvent('error', `p-limit Queue Error - For MsgID: ${messageId || 'Unknown'}, Chat: ${chatId || 'Unknown'}`, pLimitQueueError.message);
    });
  });

  client.onStateChange((state) => {
    logEvent('info', `Venom Connection State changed to: ${state}`);
    if (state === 'CONFLICT' || state === 'UNLAUNCHED') {
      logEvent('warn', `Venom state: ${state}. Attempting to use this session or re-launch.`);
      try { client.useHere(); } catch (e) { logEvent('error', "Error calling client.useHere()", e.message); }
    }
    if (state === 'UNPAIRED' || state === 'DISCONNECTED') {
      logEvent('error', `Venom state: ${state}. Client is unpaired or disconnected. Please re-scan QR or restart the bot.`);
      // process.exit(1); // প্রয়োজন অনুযায়ী আনকমেন্ট করুন
    }
  });
}

// --- Graceful Shutdown ---
const signals = ['SIGINT', 'SIGTERM', 'SIGQUIT'];
signals.forEach(signal => {
  process.on(signal, async () => {
    logEvent('info', `System Shutdown signal (${signal}) received. Gracefully shutting down...`);
    if (venomClientInstance && typeof venomClientInstance.close === 'function') {
      try {
        logEvent('info', 'Attempting to close Venom client connection...');
        await venomClientInstance.close();
        logEvent('info', 'Venom client connection closed successfully.');
      } catch (closeError) {
        logEvent('error', 'Error closing Venom client connection during shutdown', closeError.message);
      }
    } else {
        logEvent('warn', 'Venom client instance not available or close function missing during shutdown.');
    }
    logEvent('info', 'Exiting process.');
    setTimeout(() => process.exit(0), 1000); // কিছু সময় দেওয়া হচ্ছে লগিং শেষ হওয়ার জন্য
  });
});
// --- ---

// --- চ্যাট মেসেজ লগ করার ফাংশন (JSON ফরম্যাটে) ---
async function logChatMessageToFile(messageData, logType) {
  const logEntry = {
    log_type: logType,
    timestamp_utc: new Date().toISOString(),
    session_name: SESSION_NAME,
    chat_id: messageData.chatId,
    message_id: messageData.id,
    sender_id: messageData.from,
    actual_sender_id_in_group: messageData.isGroupMsg ? (messageData.author || null) : null,
    sender_name: messageData.sender ? (messageData.sender.pushname || messageData.sender.verifiedName || null) : null,
    is_group_msg: messageData.isGroupMsg,
    message_body: messageData.body || null,
    message_type: messageData.type,
    quoted_message_id: messageData.quotedMsg || null,
    from_me: messageData.fromMe || false,
  };
  try {
    await fs.appendFile(CHAT_LOG_FILE_PATH, JSON.stringify(logEntry) + '\n');
  } catch (err) {
    console.error(`[Chat Log Error] Failed to write to chat log file ${CHAT_LOG_FILE_PATH}:`, err);
  }
}
// --- ---