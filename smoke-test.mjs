import Anthropic from '@anthropic-ai/sdk';
import { writeFileSync } from 'fs';

const client = new Anthropic();
const msg = await client.messages.create({
  model: 'claude-sonnet-4-20250514',
  max_tokens: 50,
  messages: [{ role: 'user', content: 'Respond with: FreeBSD jail smoke test OK' }]
});
const result = { status: 'ok', response: msg.content[0].text, ts: new Date().toISOString() };
writeFileSync('smoke-test-result.json', JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
