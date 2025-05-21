// gptLLM.js
require('dotenv').config();
const OpenAI = require('openai');

const API_KEY = process.env.GPT_API_KEY;
const BASE_URL = process.env.GPT_BASE_URL;
const MODEL_NAME = process.env.GPT_MODEL_NAME || "provider-2/gpt-4o";

let openaiClientInstance;

if (!API_KEY || API_KEY === "YOUR_API_KEY_PLACEHOLDER" || API_KEY.startsWith("sk-") === false && !API_KEY.startsWith("ddc-free-")) { // সাধারণ কী ভ্যালিডেশন
    console.error(
        "[LLM Setup Error] GPT_API_KEY is not defined, is a placeholder, or looks invalid in your .env file. " +
        "LLM features using this provider will be disabled."
    );
    openaiClientInstance = null;
} else if (!BASE_URL) {
    console.error(
        "[LLM Setup Error] GPT_BASE_URL is not defined in your .env file. " +
        "LLM features using this provider will be disabled."
    );
    openaiClientInstance = null;
} else {
    try {
        openaiClientInstance = new OpenAI({
            apiKey: API_KEY,
            baseURL: BASE_URL,
        });
        console.log(`[LLM Setup] OpenAI-compatible LLM Client initialized. Model: ${MODEL_NAME}, URL: ${BASE_URL}`);
    } catch (error) {
        console.error("[LLM Setup] Failed to initialize OpenAI-compatible LLM Client:", error);
        openaiClientInstance = null;
    }
}

async function getLLMResponse(userMessage, systemPrompt = "You are a helpful assistant.", conversationHistory = []) {
    if (!openaiClientInstance) {
        const errorMessage = "[LLM Call] OpenAI-compatible LLM client is not initialized (API key/URL might be missing or initialization failed).";
        console.warn(errorMessage);
        return `I'm sorry, but my connection to the AI brain (GPT) is currently offline. Reason: ${errorMessage}`;
    }

    const messages = [
        { role: "system", content: systemPrompt },
        ...conversationHistory,
        { role: "user", content: userMessage }
    ];

    try {
        // console.log(`[LLM Request] Sending to Model: ${MODEL_NAME}, Messages Count: ${messages.length}`);
        const completion = await openaiClientInstance.chat.completions.create({
            model: MODEL_NAME,
            messages: messages,
            // temperature: 0.7, // সৃজনশীলতা নিয়ন্ত্রণের জন্য
        });

        if (completion.choices && completion.choices.length > 0 && completion.choices[0].message && completion.choices[0].message.content) {
            const aiContent = completion.choices[0].message.content;
            // console.log(`[LLM Response] Received content snippet: "${aiContent.substring(0, 70)}..."`);
            return aiContent;
        } else {
            console.error("[LLM Error] AI response format is unexpected or content is missing:", JSON.stringify(completion));
            return "I received an unusual or empty response from my AI brain (GPT). Please try again.";
        }
    } catch (error) {
        let detailedErrorMessage = error.message || String(error);
        console.error("[LLM Error] Error getting response from OpenAI-compatible API:", detailedErrorMessage);
        if (error.response && error.response.data) {
            detailedErrorMessage += ` | API Response: ${JSON.stringify(error.response.data)}`;
            console.error("[LLM Error] API Response Data:", JSON.stringify(error.response.data));
        } else if (error.status && error.error) {
            detailedErrorMessage += ` | API Error: ${JSON.stringify(error.error)}`;
            console.error("[LLM Error] API Error Details:", JSON.stringify(error.error));
        }
        return `I'm having a little trouble thinking (GPT) right now. Error: ${detailedErrorMessage.substring(0, 100)}... Could you try again?`;
    }
}

module.exports = { getLLMResponse };