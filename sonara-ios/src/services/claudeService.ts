/**
 * ClaudeService — Sonara iOS
 * AI-powered book Q&A and explanation via Anthropic Claude API.
 * Same API integration as the desktop version.
 */
import axios from 'axios';

const CLAUDE_API_URL = 'https://api.anthropic.com/v1/messages';
const MODEL = 'claude-3-haiku-20240307';
const MAX_TOKENS = 1024;

export interface ClaudeMessage {
  role: 'user' | 'assistant';
  content: string;
}

export const ClaudeService = {
  async ask(
    apiKey: string,
    question: string,
    context: string,
    history: ClaudeMessage[] = []
  ): Promise<string> {
    if (!apiKey?.startsWith('sk-ant')) {
      throw new Error('Invalid Claude API key. It should start with sk-ant-');
    }

    const systemPrompt =
      `You are a knowledgeable reading assistant for Sonara, an audiobook player. ` +
      `The user is currently reading the following text:\n\n` +
      `---\n${context.slice(0, 3000)}\n---\n\n` +
      `Answer questions concisely and helpfully. If explaining a concept, ` +
      `keep it brief (2-3 sentences unless asked for more). ` +
      `If the question is not related to the text, answer generally.`;

    const messages: ClaudeMessage[] = [
      ...history.slice(-6), // Keep last 6 messages for context
      { role: 'user', content: question },
    ];

    const response = await axios.post(
      CLAUDE_API_URL,
      {
        model: MODEL,
        max_tokens: MAX_TOKENS,
        system: systemPrompt,
        messages,
      },
      {
        headers: {
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json',
        },
        timeout: 30000,
      }
    );

    return response.data?.content?.[0]?.text ?? 'No response from Claude.';
  },

  async summarize(apiKey: string, text: string): Promise<string> {
    return this.ask(
      apiKey,
      'Please provide a brief summary of this passage in 2-3 sentences.',
      text,
      []
    );
  },

  async explain(apiKey: string, word: string, context: string): Promise<string> {
    return this.ask(
      apiKey,
      `What does "${word}" mean in this context? Brief explanation please.`,
      context,
      []
    );
  },
};
