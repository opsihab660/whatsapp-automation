// gptLLM.js
require('dotenv').config();
const OpenAI = require('openai');

const API_KEY = process.env.GPT_API_KEY || "ddc-free-8e5171eeac9148ed89969cc31002d99d";
const BASE_URL = process.env.GPT_BASE_URL || "https://api.devsdocode.com/v1";
const MODEL_NAME = process.env.GPT_MODEL_NAME || "provider-2/gpt-4o";

let openaiClientInstance;

if (!API_KEY || API_KEY === "your_openai_api_key_here_or_provider_key" || API_KEY === "YOUR_GPT_API_KEY") {
    console.error("GPT_API_KEY is not defined or is a placeholder. LLM features disabled.");
    openaiClientInstance = null;
} else {
    try {
        openaiClientInstance = new OpenAI({ apiKey: API_KEY, baseURL: BASE_URL });
        console.log(`[LLM Setup] OpenAI-compatible LLM Client initialized. Model: ${MODEL_NAME}, URL: ${BASE_URL}`);
    } catch (error) {
        console.error("[LLM Setup] Failed to initialize OpenAI-compatible LLM Client:", error);
        openaiClientInstance = null;
    }
}

// conversationHistory এখন একটি প্যারামিটার
async function getLLMResponse(userMessage, systemPrompt = "You are a helpful assistant.", conversationHistory = []) {
    if (!openaiClientInstance) {
        console.warn("[LLM Call] OpenAI-compatible LLM client not initialized.");
        return "I'm sorry, my connection to the AI brain (GPT) is currently offline.";
    }

    // সিস্টেম প্রম্পট, আগের কনভারসেশন হিস্টোরি, এবং নতুন ইউজার মেসেজ একত্রিত করা
    const messages = [
        { role: "system", content: systemPrompt },
        ...conversationHistory, // আগের মেসেজগুলো (যদি থাকে)
        { role: "user", content: userMessage }
    ];

    try {
        // console.log(`[LLM Request] Model: ${MODEL_NAME}, Messages being sent: ${JSON.stringify(messages)}`);
        const completion = await openaiClientInstance.chat.completions.create({
            model: MODEL_NAME,
            messages: messages,
        });

        if (completion.choices && completion.choices.length > 0 && completion.choices[0].message) {
            const aiContent = completion.choices[0].message.content;
            // console.log(`[LLM Response] Content: "${aiContent.substring(0, 100)}..."`);
            return aiContent;
        } else {
            console.error("[LLM Error] AI response format unexpected:", JSON.stringify(completion));
            return "I received an unusual response from my AI brain (GPT). Please try again.";
        }
    } catch (error) {
        console.error("[LLM Error] Error getting response from OpenAI-compatible API:", error.message);
        if (error.response && error.response.data) {
            console.error("[LLM Error] API Response Data:", JSON.stringify(error.response.data));
        }
        return "I'm having a little trouble thinking (GPT) right now. Could you try asking again in a moment?";
    }
}

module.exports = { getLLMResponse };