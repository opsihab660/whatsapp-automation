// Constants
const API_BASE_URL = 'http://localhost:3000/api';
const SOCKET_URL = 'http://localhost:3000';

// DOM Elements
const statusBadge = document.getElementById('status-badge');
const statusText = document.getElementById('status-text');
const startBotBtn = document.getElementById('start-bot');
const stopBotBtn = document.getElementById('stop-bot');
const toggleAiBtn = document.getElementById('toggle-ai');
const aiToggleText = document.getElementById('ai-toggle-text');
const qrPlaceholder = document.getElementById('qr-placeholder');
const qrCodeContainer = document.getElementById('qr-code');
const messagesContainer = document.getElementById('messages-container');
const filterAllBtn = document.getElementById('filter-all');
const filterUserBtn = document.getElementById('filter-user');
const filterAiBtn = document.getElementById('filter-ai');
const clearMessagesBtn = document.getElementById('clear-messages');

// Socket.io connection
const socket = io(SOCKET_URL);

// State
let currentFilter = 'all';
let messages = [];
let aiEnabled = true; // Track AI response state

// Initialize the app
function init() {
    fetchBotStatus();
    setupEventListeners();
    setupSocketListeners();
}

// Fetch initial bot status
async function fetchBotStatus() {
    try {
        const response = await fetch(`${API_BASE_URL}/status`);
        const data = await response.json();
        updateBotStatus(data);
    } catch (error) {
        console.error('Error fetching bot status:', error);
        showError('Failed to connect to the server. Please check if the server is running.');
    }
}

// Setup event listeners
function setupEventListeners() {
    startBotBtn.addEventListener('click', startBot);
    stopBotBtn.addEventListener('click', stopBot);
    toggleAiBtn.addEventListener('click', toggleAiResponses);

    filterAllBtn.addEventListener('click', () => setMessageFilter('all'));
    filterUserBtn.addEventListener('click', () => setMessageFilter('user'));
    filterAiBtn.addEventListener('click', () => setMessageFilter('ai'));
    clearMessagesBtn.addEventListener('click', clearMessages);
}

// Toggle AI responses
async function toggleAiResponses() {
    try {
        const response = await fetch(`${API_BASE_URL}/toggle-ai`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            }
        });

        const data = await response.json();

        if (data.success) {
            updateAiToggleUI(data.aiEnabled);
        } else {
            showError(`Failed to toggle AI responses: ${data.message}`);
        }
    } catch (error) {
        console.error('Error toggling AI responses:', error);
        showError('Failed to toggle AI responses. Check server connection.');
    }
}

// Update AI toggle button UI
function updateAiToggleUI(enabled) {
    aiEnabled = enabled;
    aiToggleText.textContent = `Suno AI: ${enabled ? 'ON' : 'OFF'}`;

    if (enabled) {
        toggleAiBtn.classList.remove('ai-disabled');
    } else {
        toggleAiBtn.classList.add('ai-disabled');
    }
}

// Setup socket listeners
function setupSocketListeners() {
    socket.on('connect', () => {
        console.log('Connected to server via Socket.IO');
    });

    socket.on('disconnect', () => {
        console.log('Disconnected from server');
        updateStatusUI('OFFLINE', 'Lost connection to server');
    });

    socket.on('bot_status', (data) => {
        updateBotStatus(data);

        // Update AI toggle status if provided
        if (data.aiEnabled !== undefined) {
            updateAiToggleUI(data.aiEnabled);
        }
    });

    socket.on('qr_code', (qrBase64) => {
        renderQRCode(qrBase64);
    });

    socket.on('new_message', (message) => {
        addMessage(message);
    });

    socket.on('bot_error', (error) => {
        showError(`Bot error: ${error.message}`);
    });

    socket.on('ai_toggle_status', (data) => {
        updateAiToggleUI(data.enabled);
    });
}

// Start the bot
async function startBot() {
    try {
        startBotBtn.disabled = true;
        updateStatusUI('INITIALIZING', 'Starting bot...');

        const response = await fetch(`${API_BASE_URL}/start`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            }
        });

        const data = await response.json();

        if (data.error) {
            showError(`Failed to start bot: ${data.error}`);
            updateStatusUI('ERROR', `Error: ${data.error}`);
        }
    } catch (error) {
        console.error('Error starting bot:', error);
        showError('Failed to start bot. Check server connection.');
        updateStatusUI('ERROR', 'Failed to connect to server');
    } finally {
        startBotBtn.disabled = false;
    }
}

// Stop the bot
async function stopBot() {
    try {
        stopBotBtn.disabled = true;
        updateStatusUI('DISCONNECTED', 'Stopping bot...');

        const response = await fetch(`${API_BASE_URL}/stop`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            }
        });

        const data = await response.json();

        if (data.error) {
            showError(`Failed to stop bot: ${data.error}`);
        }
    } catch (error) {
        console.error('Error stopping bot:', error);
        showError('Failed to stop bot. Check server connection.');
    } finally {
        stopBotBtn.disabled = false;
    }
}

// Update bot status UI
function updateBotStatus(data) {
    const { status, qr } = data;
    updateStatusUI(status);

    if (qr) {
        renderQRCode(qr);
    } else {
        hideQRCode();
    }
}

// Update status UI elements
function updateStatusUI(status, customMessage = null) {
    statusBadge.className = 'badge ' + status.toLowerCase();
    statusBadge.textContent = status;

    // Update buttons based on status
    if (['CONNECTED', 'INITIALIZING', 'SCAN_QR'].includes(status)) {
        startBotBtn.disabled = true;
        stopBotBtn.disabled = false;
    } else {
        startBotBtn.disabled = false;
        stopBotBtn.disabled = true;
    }

    // Update status text
    let statusMessage = customMessage;
    if (!statusMessage) {
        switch (status) {
            case 'OFFLINE':
                statusMessage = 'Bot is currently offline';
                break;
            case 'INITIALIZING':
                statusMessage = 'Bot is initializing...';
                break;
            case 'SCAN_QR':
                statusMessage = 'Please scan the QR code with WhatsApp';
                break;
            case 'CONNECTED':
                statusMessage = 'Bot is connected to WhatsApp';
                break;
            case 'DISCONNECTED':
                statusMessage = 'Bot was disconnected';
                break;
            case 'ERROR':
                statusMessage = 'An error occurred';
                break;
            default:
                statusMessage = `Status: ${status}`;
        }
    }

    statusText.textContent = statusMessage;
}

// Render QR code
function renderQRCode(qrBase64) {
    qrPlaceholder.style.display = 'none';
    qrCodeContainer.style.display = 'block';

    // Clear previous QR code
    qrCodeContainer.innerHTML = '';

    // Create image from base64
    const img = document.createElement('img');
    img.src = qrBase64;
    img.alt = 'WhatsApp QR Code';
    img.style.maxWidth = '100%';

    qrCodeContainer.appendChild(img);
}

// Hide QR code
function hideQRCode() {
    qrCodeContainer.style.display = 'none';
    qrPlaceholder.style.display = 'block';
    qrPlaceholder.textContent = 'No QR code available';
}

// Add a message to the messages list
function addMessage(message) {
    messages.push(message);
    renderMessages();

    // Remove empty state if it exists
    const emptyState = messagesContainer.querySelector('.empty-state');
    if (emptyState) {
        emptyState.remove();
    }
}

// Set message filter
function setMessageFilter(filter) {
    currentFilter = filter;

    // Update active filter button
    [filterAllBtn, filterUserBtn, filterAiBtn].forEach(btn => {
        btn.classList.remove('active');
    });

    switch (filter) {
        case 'all':
            filterAllBtn.classList.add('active');
            break;
        case 'user':
            filterUserBtn.classList.add('active');
            break;
        case 'ai':
            filterAiBtn.classList.add('active');
            break;
    }

    renderMessages();
}

// Clear all messages
function clearMessages() {
    messages = [];
    renderMessages();

    // Add empty state
    const emptyState = document.createElement('div');
    emptyState.className = 'empty-state';
    emptyState.innerHTML = `
        <i class="fas fa-comments"></i>
        <p>No messages yet. Start the bot to see incoming messages.</p>
    `;
    messagesContainer.appendChild(emptyState);
}

// Render messages based on current filter
function renderMessages() {
    messagesContainer.innerHTML = '';

    const filteredMessages = messages.filter(msg => {
        if (currentFilter === 'all') return true;
        if (currentFilter === 'user') return msg.type === 'user';
        if (currentFilter === 'ai') return msg.type === 'ai_reply';
        return true;
    });

    filteredMessages.forEach(msg => {
        const messageEl = document.createElement('div');
        messageEl.className = `message ${msg.type === 'user' ? 'message-user' : 'message-ai'}`;

        let headerContent = '';
        if (msg.type === 'user') {
            headerContent = `
                <div class="message-sender">${msg.senderName || 'User'}</div>
                <div class="message-chat">${msg.isGroup ? 'Group' : 'Private'}</div>
            `;
        } else {
            headerContent = `<div class="message-sender">AI Assistant</div>`;
        }

        const timestamp = new Date(msg.timestamp).toLocaleTimeString();

        messageEl.innerHTML = `
            <div class="message-header">${headerContent}</div>
            <div class="message-content">${msg.text}</div>
            <div class="message-time">${timestamp}</div>
        `;

        messagesContainer.appendChild(messageEl);
    });

    // Scroll to bottom
    messagesContainer.scrollTop = messagesContainer.scrollHeight;
}

// Show error message
function showError(message) {
    console.error(message);
    // You could implement a toast notification here
    alert(message);
}

// Initialize the app when DOM is loaded
document.addEventListener('DOMContentLoaded', init);
