# WhatsApp Automation Dashboard

A web-based dashboard for WhatsApp automation with QR code login, message logging, and AI-powered replies.

## Features

- WhatsApp bot control (start/stop)
- QR code scanning for WhatsApp Web login
- Real-time message logging
- AI-powered automatic replies using GPT models
- Conversation history tracking
- 24/7 operation when deployed properly

## Setup

1. Install dependencies:
   ```
   npm install
   ```

2. Configure environment variables in `.env` file:
   ```
   GPT_API_KEY=your_api_key
   GPT_BASE_URL=your_api_url
   GPT_MODEL_NAME=your_model_name
   SESSION_NAME=your_session_name
   PORT=3000
   CONCURRENCY_LIMIT_LLM=2
   MAX_CONVERSATION_HISTORY=10
   ```

3. Start the server:
   ```
   npm start
   ```

4. For development with auto-restart:
   ```
   npm run dev
   ```

5. Open your browser and navigate to:
   ```
   http://localhost:3000
   ```

## Usage

1. Click "Start Bot" to initialize the WhatsApp bot
2. Scan the QR code with your WhatsApp mobile app
3. Once connected, the bot will automatically respond to incoming messages
4. View all message activity in the dashboard
5. Filter messages by type (user/AI)
6. Click "Stop Bot" to disconnect

## API Endpoints

- `GET /api/status` - Get current bot status
- `POST /api/start` - Start the WhatsApp bot
- `POST /api/stop` - Stop the WhatsApp bot

## Technologies Used

- Backend: Node.js, Express.js, Socket.IO
- WhatsApp Integration: venom-bot
- AI Integration: OpenAI-compatible API
- Frontend: HTML, CSS, JavaScript

## Deployment on Render

### Prerequisites

- A Render account
- A GitHub repository with your code

### Deployment Steps

1. Fork or push this repository to your GitHub account
2. Log in to your Render account
3. Click on "New" and select "Web Service"
4. Connect your GitHub repository
5. Configure the service:
   - Name: whatsapp-automation (or your preferred name)
   - Environment: Node
   - Build Command: `npm install`
   - Start Command: `node server.js`
6. Add the following environment variables:
   - GPT_API_KEY: Your OpenAI-compatible API key
   - GPT_BASE_URL: Your API base URL
   - GPT_MODEL_NAME: The model name to use
   - SESSION_NAME: A unique name for your WhatsApp session
   - PORT: 3000 (Render will override this with its own PORT)
   - CONCURRENCY_LIMIT_LLM: 2 (or your preferred limit)
   - MAX_CONVERSATION_HISTORY: 10 (or your preferred limit)
7. Select an appropriate plan:
   - For 24/7 operation, choose a paid plan
   - For testing, the free plan is sufficient but will spin down after inactivity
8. Click "Create Web Service"

### Important Notes

- The free plan on Render will spin down after 15 minutes of inactivity, which is not ideal for a WhatsApp bot that needs to run 24/7
- For continuous operation, use at least the "Starter" plan ($7/month)
- Render provides persistent disk storage which is necessary for maintaining WhatsApp sessions between deployments

## License

ISC
